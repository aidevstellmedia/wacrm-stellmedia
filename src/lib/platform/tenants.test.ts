import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { table: string; op: string; filters: Record<string, unknown> };
type Res = { data?: unknown; error?: { message: string; code?: string } | null };

let handler: (c: Call) => Res | undefined;
const calls: Call[] = [];
const invite = vi.fn();

function builder(table: string) {
  const call: Call = { table, op: "select", filters: {} };
  const b: Record<string, unknown> = {};
  for (const op of ["select", "insert", "update", "upsert", "delete"]) {
    b[op] = (payload?: unknown) => {
      if (op !== "select" || call.op === "select") call.op = op;
      if (payload !== undefined && op !== "select") call.filters.payload = payload;
      return b;
    };
  }
  b.eq = (k: string, v: unknown) => ((call.filters[k] = v), b);
  b.in = b.order = b.limit = () => b;
  const run = () => {
    calls.push(call);
    const r = handler(call) ?? {};
    return { data: r.data ?? null, error: r.error ?? null };
  };
  b.maybeSingle = () => Promise.resolve(run());
  b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad);
  return b;
}

vi.mock("./admin-client", () => ({
  platformAdmin: () => ({ from: builder, auth: { admin: { inviteUserByEmail: invite } } }),
}));

import { addTenantDomain, completeTenantSetup, createTenant, listTenants, PlatformError, removePlatformAdmin, removeTenantDomain, setTenantStatus } from "./tenants";

beforeEach(() => {
  calls.length = 0;
  invite.mockReset();
  process.env.PLATFORM_BASE_DOMAIN = "crm.test.com";
  handler = () => undefined;
});

const input = { companyName: "Acme", slug: "acme", ownerEmail: "o@acme.com", ownerName: "O", logo: null, favicon: null };

describe("createTenant", () => {
  it("rejects an existing email without inviting", async () => {
    handler = (c) => (c.table === "profiles" ? { data: { user_id: "u1" } } : undefined);
    await expect(createTenant(input)).rejects.toThrow(PlatformError);
    expect(invite).not.toHaveBeenCalled();
  });

  it("rejects a taken slug without inviting", async () => {
    handler = (c) => (c.table === "tenant_settings" ? { data: { account_id: "a1" } } : undefined);
    await expect(createTenant(input)).rejects.toThrow(/already taken/);
    expect(invite).not.toHaveBeenCalled();
  });

  it("surfaces lookup errors instead of swallowing them", async () => {
    handler = (c) => (c.table === "profiles" ? { error: { message: "boom" } } : undefined);
    await expect(createTenant(input)).rejects.toThrow("boom");
    expect(invite).not.toHaveBeenCalled();
  });
});

describe("removeTenantDomain", () => {
  it("refuses to remove the last subdomain", async () => {
    handler = (c) => {
      if (c.op === "select" && c.filters.id === "d1") return { data: { id: "d1", account_id: "a1", kind: "subdomain" } };
      if (c.op === "select") return { data: [{ id: "d1" }] };
    };
    await expect(removeTenantDomain("a1", "d1")).rejects.toThrow(PlatformError);
    expect(calls.some((c) => c.op === "delete")).toBe(false);
  });

  it("removes a custom domain", async () => {
    handler = (c) => (c.op === "select" ? { data: { id: "d2", account_id: "a1", kind: "custom" } } : undefined);
    await removeTenantDomain("a1", "d2");
    expect(calls.some((c) => c.op === "delete" && c.filters.id === "d2")).toBe(true);
  });
});

describe("removePlatformAdmin", () => {
  it("refuses to remove yourself", async () => {
    await expect(removePlatformAdmin("u1", "u1")).rejects.toThrow(PlatformError);
    expect(calls).toHaveLength(0);
  });

  it("refuses to remove the last admin", async () => {
    handler = () => ({ data: [{ user_id: "u2" }] });
    await expect(removePlatformAdmin("u1", "u2")).rejects.toThrow(/last/);
    expect(calls.some((c) => c.op === "delete")).toBe(false);
  });

  it("removes when others remain", async () => {
    handler = (c) => (c.op === "select" ? { data: [{ user_id: "u1" }, { user_id: "u2" }] } : undefined);
    await removePlatformAdmin("u1", "u2");
    expect(calls.some((c) => c.op === "delete" && c.filters.user_id === "u2")).toBe(true);
  });
});

describe("completeTenantSetup", () => {
  const setup = { companyName: "Acme", slug: "acme", logo: null, favicon: null };

  it("refuses a hostname owned by another account and writes no settings", async () => {
    handler = (c) => (c.table === "tenant_domains" && c.op === "select" ? { data: { account_id: "other" } } : undefined);
    await expect(completeTenantSetup("a1", setup)).rejects.toThrow(/already taken/);
    expect(calls.some((c) => c.table === "tenant_settings" && c.op === "upsert")).toBe(false);
  });

  it("refuses an account that already has a settings row", async () => {
    handler = (c) =>
      c.table === "tenant_settings" && c.op === "select" && c.filters.account_id === "a1" ? { data: { account_id: "a1" } } : undefined;
    await expect(completeTenantSetup("a1", setup)).rejects.toThrow("This client is already set up.");
    expect(calls.some((c) => c.op === "upsert" || c.op === "update")).toBe(false);
  });

  it("converges when re-run for the same account", async () => {
    handler = (c) => {
      if (c.table === "tenant_domains" && c.op === "select") return { data: { account_id: "a1" } };
    };
    await completeTenantSetup("a1", setup);
    const order = calls.filter((c) => c.op === "upsert").map((c) => c.table);
    expect(order).toEqual(["tenant_domains", "tenant_settings"]);
  });
});

describe("setTenantStatus", () => {
  it("throws when the account has no settings row", async () => {
    handler = () => ({ data: [] });
    await expect(setTenantStatus("a1", "suspended")).rejects.toThrow(PlatformError);
  });
});

describe("removeTenantDomain scoping", () => {
  it("treats a domain of another account as not found", async () => {
    handler = () => ({ data: null });
    await expect(removeTenantDomain("a2", "d1")).rejects.toThrow("Domain not found.");
    expect(calls.some((c) => c.op === "delete")).toBe(false);
    expect(calls[0].filters.account_id).toBe("a2");
  });
});

describe("addTenantDomain", () => {
  it("rejects the admin hostname", async () => {
    process.env.ADMIN_HOSTNAME = "admin.crm.test.com";
    try {
      await expect(addTenantDomain("a1", "admin.crm.test.com")).rejects.toThrow(/reserved/);
      expect(calls).toHaveLength(0);
    } finally {
      delete process.env.ADMIN_HOSTNAME;
    }
  });
});

describe("listTenants", () => {
  it("hides a platform admin's personal account but keeps set-up and other accounts", async () => {
    handler = (c) => {
      if (c.table === "accounts") {
        return { data: [
          { id: "adm", name: "Admin personal", owner_user_id: "u-admin", created_at: "2026-01-03" },
          { id: "cli", name: "Client", owner_user_id: "u-cli", created_at: "2026-01-02" },
          { id: "adm-tenant", name: "Admin as client", owner_user_id: "u-admin", created_at: "2026-01-01" },
        ] };
      }
      if (c.table === "tenant_settings") return { data: [{ account_id: "adm-tenant", slug: "x", status: "active" }] };
      if (c.table === "platform_admins") return { data: [{ user_id: "u-admin" }] };
      return { data: [] };
    };
    const rows = await listTenants();
    expect(rows.map((r) => r.accountId)).toEqual(["cli", "adm-tenant"]);
  });
});
