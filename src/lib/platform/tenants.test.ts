import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { table: string; op: string; filters: Record<string, unknown> };
type Res = { data?: unknown; error?: { message: string; code?: string } | null };

let handler: (c: Call) => Res | undefined;
const calls: Call[] = [];
const invite = vi.fn();
const getUserById = vi.fn();
const deleteUser = vi.fn();
const order: string[] = [];

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
  b.in = b.order = b.limit = b.is = () => b;
  const run = () => {
    calls.push(call);
    if (call.op === "delete") order.push(`delete:${call.table}`);
    const r = handler(call) ?? {};
    return { data: r.data ?? null, error: r.error ?? null };
  };
  b.maybeSingle = () => Promise.resolve(run());
  b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad);
  return b;
}

vi.mock("./admin-client", () => ({
  platformAdmin: () => ({ from: builder, auth: { admin: { inviteUserByEmail: invite, getUserById, deleteUser } } }),
}));

import { addTenantDomain, completeTenantSetup, createTenant, deleteUnassignedUser, PartialDeleteError, listTenantMembers, listTenants, listUnassignedUsers, PlatformError, removePlatformAdmin, removeTenantDomain, setTenantStatus } from "./tenants";

beforeEach(() => {
  calls.length = 0;
  invite.mockReset();
  getUserById.mockReset();
  deleteUser.mockReset();
  order.length = 0;
  getUserById.mockImplementation(async () => ({ data: { user: { user_metadata: {}, last_sign_in_at: null } }, error: null }));
  deleteUser.mockImplementation(async () => {
    order.push("deleteUser");
    return { error: null };
  });
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

describe("createTenant tagging", () => {
  it("tags the owner as a client owner on invite", async () => {
    invite.mockResolvedValue({ data: { user: { id: "u9" } }, error: null });
    let domainReads = 0;
    handler = (c) => {
      if (c.table === "accounts") return { data: { id: "a9" } };
      // 1st read is the pre-check (free); 2nd confirms setup claimed the hostname.
      if (c.table === "tenant_domains" && c.op === "select") return ++domainReads === 1 ? undefined : { data: { account_id: "a9" } };
    };
    await createTenant(input);
    expect(invite).toHaveBeenCalledWith("o@acme.com", expect.objectContaining({
      data: { full_name: "O", platform_client_owner: true },
    }));
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
    getUserById.mockImplementation(async (id: string) => ({
      data: { user: { user_metadata: id === "u-cli" ? { platform_client_owner: true } : {} } },
      error: null,
    }));
    const rows = await listTenants();
    expect(rows.map((r) => r.accountId)).toEqual(["cli", "adm-tenant"]);
    expect(getUserById).toHaveBeenCalledTimes(1); // only the settings-less non-admin owner
  });

  it("excludes an untagged settings-less account and includes a tagged one", async () => {
    handler = (c) => {
      if (c.table === "accounts") {
        return { data: [
          { id: "stray", name: "Stray", owner_user_id: "u-stray", created_at: "2026-01-02" },
          { id: "tagged", name: "Tagged", owner_user_id: "u-tag", created_at: "2026-01-01" },
        ] };
      }
    };
    getUserById.mockImplementation(async (id: string) => ({
      data: { user: { user_metadata: id === "u-tag" ? { platform_client_owner: true } : {} } },
      error: null,
    }));
    const rows = await listTenants();
    expect(rows.map((r) => r.accountId)).toEqual(["tagged"]);
    expect(rows[0].status).toBe("incomplete");
  });
});

const acctRows = [
  { id: "adm", name: "Admin", owner_user_id: "u-admin", created_at: "2026-01-05" },
  { id: "stray1", name: "S1", owner_user_id: "u-s1", created_at: "2026-01-04" },
  { id: "tagged", name: "T", owner_user_id: "u-tag", created_at: "2026-01-03" },
  { id: "set", name: "Set", owner_user_id: "u-set", created_at: "2026-01-02" },
  { id: "stray2", name: "S2", owner_user_id: "u-s2", created_at: "2026-01-01" },
];

describe("listUnassignedUsers", () => {
  it("returns exactly the untagged, non-admin, settings-less accounts", async () => {
    handler = (c) => {
      if (c.table === "accounts") return { data: acctRows };
      if (c.table === "tenant_settings") return { data: [{ account_id: "set" }] };
      if (c.table === "platform_admins") return { data: [{ user_id: "u-admin" }] };
      if (c.table === "profiles") return { data: [{ user_id: "u-s1", email: "s1@x.com" }] };
    };
    getUserById.mockImplementation(async (id: string) => ({
      data: { user: { user_metadata: id === "u-tag" ? { platform_client_owner: true } : {}, last_sign_in_at: id === "u-s1" ? "2026-02-01T10:00:00Z" : null } },
      error: null,
    }));
    const rows = await listUnassignedUsers();
    expect(rows).toEqual([
      { accountId: "stray1", ownerUserId: "u-s1", email: "s1@x.com", name: "S1", createdAt: "2026-01-04", lastSignInAt: "2026-02-01T10:00:00Z" },
      { accountId: "stray2", ownerUserId: "u-s2", email: null, name: "S2", createdAt: "2026-01-01", lastSignInAt: null },
    ]);
  });
});

describe("listUnassignedUsers errors", () => {
  it("throws when the auth lookup fails", async () => {
    handler = (c) => (c.table === "accounts" ? { data: acctRows } : undefined);
    getUserById.mockResolvedValue({ data: null, error: { message: "auth down" } });
    await expect(listUnassignedUsers()).rejects.toThrow("auth down");
  });
});

describe("deleteUnassignedUser", () => {
  const stray = (over: Partial<Record<string, unknown>> = {}) => (c: Call): Res | undefined => {
    if (c.table === "accounts") return { data: { id: "a1", owner_user_id: "u1" } };
    if (c.table === "profiles") return { data: over.profiles ?? [{ user_id: "u1", email: "x@y.com" }] };
    if (c.table === "tenant_settings") return { data: over.settings ?? null };
    if (c.table === "platform_admins") return { data: over.admin ?? null };
    if (over.dataTable === c.table) return { data: [{ account_id: "a1" }] };
  };
  const deleted = () => calls.some((c) => c.op === "delete") || deleteUser.mock.calls.length > 0;

  it("refuses when tenant_settings exists", async () => {
    handler = stray({ settings: { account_id: "a1" } });
    await expect(deleteUnassignedUser("a1")).rejects.toThrow("This account belongs to a client and can't be deleted here.");
    expect(deleted()).toBe(false);
  });

  it("refuses when the owner is tagged", async () => {
    handler = stray();
    getUserById.mockImplementation(async () => ({ data: { user: { user_metadata: { platform_client_owner: true } } }, error: null }));
    await expect(deleteUnassignedUser("a1")).rejects.toThrow(/belongs to a client/);
    expect(deleted()).toBe(false);
  });

  it("refuses when the owner is a platform admin", async () => {
    handler = stray({ admin: { user_id: "u1" } });
    await expect(deleteUnassignedUser("a1")).rejects.toThrow(/belongs to a client/);
    expect(deleted()).toBe(false);
  });

  it("refuses when data is present", async () => {
    handler = stray({ dataTable: "contacts" });
    await expect(deleteUnassignedUser("a1")).rejects.toThrow("This account has data and can't be deleted.");
    expect(deleted()).toBe(false);
  });

  it("refuses when a pending invitation exists", async () => {
    handler = stray({ dataTable: "account_invitations" });
    await expect(deleteUnassignedUser("a1")).rejects.toThrow("This account has data and can't be deleted.");
    expect(deleted()).toBe(false);
  });

  it.each(["api_keys", "webhook_endpoints", "quick_replies", "deals", "ai_configs", "ai_knowledge_documents"])(
    "refuses when %s has rows", async (t) => {
      handler = stray({ dataTable: t });
      await expect(deleteUnassignedUser("a1")).rejects.toThrow(/has data/);
      expect(deleted()).toBe(false);
    },
  );

  it("refuses if membership changed just before deleting", async () => {
    let reads = 0;
    handler = (c) => {
      if (c.table === "profiles") return { data: ++reads === 1 ? [{ user_id: "u1", email: "x@y.com" }] : [{ user_id: "u1" }, { user_id: "u2" }] };
      return stray()(c);
    };
    await expect(deleteUnassignedUser("a1")).rejects.toThrow(/changed while deleting/);
    expect(deleted()).toBe(false);
  });

  it("refuses if the sole profile is not the owner", async () => {
    handler = (c) => (c.table === "profiles" ? { data: [{ user_id: "other", email: "o@y.com" }] } : stray()(c));
    await expect(deleteUnassignedUser("a1")).rejects.toThrow(/changed while deleting/);
    expect(deleted()).toBe(false);
  });

  it("throws a PartialDeleteError when the auth user cannot be deleted after the account", async () => {
    handler = stray();
    deleteUser.mockResolvedValueOnce({ error: { message: "nope" } });
    const err = await deleteUnassignedUser("a1").catch((e) => e);
    expect(err).toBeInstanceOf(PartialDeleteError);
    expect(err.ownerUserId).toBe("u1");
    expect(err.message).toMatch(/Account removed, but the login could not be deleted \(user u1\)/);
    expect(order[0]).toBe("delete:accounts");
  });

  it("throws and deletes nothing when the auth lookup fails", async () => {
    handler = stray();
    getUserById.mockResolvedValue({ data: null, error: { message: "auth down" } });
    await expect(deleteUnassignedUser("a1")).rejects.toThrow("auth down");
    expect(deleted()).toBe(false);
  });

  it("refuses when there is more than one profile", async () => {
    handler = stray({ profiles: [{ user_id: "u1" }, { user_id: "u2" }] });
    await expect(deleteUnassignedUser("a1")).rejects.toThrow(PlatformError);
    expect(deleted()).toBe(false);
  });

  it("deletes the account first, then the auth user", async () => {
    handler = stray();
    const res = await deleteUnassignedUser("a1");
    expect(res).toEqual({ email: "x@y.com" });
    expect(order).toEqual(["delete:accounts", "deleteUser"]);
    expect(deleteUser).toHaveBeenCalledWith("u1");
    expect(calls.find((c) => c.op === "delete")?.filters.id).toBe("a1");
  });
});

describe("listTenantMembers", () => {
  it("orders owner > admin > agent > viewer then email and maps lastSignInAt", async () => {
    handler = (c) =>
      c.table === "profiles"
        ? { data: [
            { user_id: "v", email: "a@x.com", full_name: "V", account_role: "viewer" },
            { user_id: "g2", email: "z@x.com", full_name: "", account_role: "agent" },
            { user_id: "o", email: "o@x.com", full_name: "O", account_role: "owner" },
            { user_id: "g1", email: "b@x.com", full_name: "G1", account_role: "agent" },
            { user_id: "ad", email: "m@x.com", full_name: "AD", account_role: "admin" },
          ] }
        : undefined;
    getUserById.mockImplementation(async (id: string) => ({
      data: { user: { last_sign_in_at: id === "o" ? "2026-03-01T00:00:00Z" : null } },
      error: null,
    }));
    const rows = await listTenantMembers("a1");
    expect(rows.map((r) => r.userId)).toEqual(["o", "ad", "g1", "g2", "v"]);
    expect(rows[0].lastSignInAt).toBe("2026-03-01T00:00:00Z");
    expect(rows[1].lastSignInAt).toBeNull();
    expect(rows[3].fullName).toBeNull();
  });
});
