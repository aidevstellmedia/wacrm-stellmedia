import { beforeEach, describe, expect, it, vi } from "vitest";

const requirePlatformAdmin = vi.fn();
vi.mock("./guard", () => ({ requirePlatformAdmin: () => requirePlatformAdmin() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("./tenants", () => {
  class PlatformError extends Error {}
  return {
    PlatformError,
    createTenant: vi.fn(async () => ({ accountId: "acc-1" })),
    completeTenantSetup: vi.fn(),
    updateTenantBranding: vi.fn(),
    setTenantStatus: vi.fn(),
    addTenantDomain: vi.fn(),
    removeTenantDomain: vi.fn(),
    resendOwnerInvite: vi.fn(),
    addPlatformAdmin: vi.fn(),
    removePlatformAdmin: vi.fn(),
    deleteUnassignedUser: vi.fn(async () => ({ email: "x@y.com" })),
    writeAudit: vi.fn(),
  };
});

import * as tenants from "./tenants";
import * as actions from "./actions";

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const prev = { error: null };

beforeEach(() => {
  vi.clearAllMocks();
  requirePlatformAdmin.mockResolvedValue({ userId: "u1", email: "a@b.co" });
});

describe("platform actions", () => {
  it("createClientAction rejects a bad slug without creating a tenant", async () => {
    const res = await actions.createClientAction(
      prev,
      fd({ companyName: "Acme", slug: "-Bad Slug-", ownerEmail: "o@acme.com" }),
    );
    expect(res.error).toBeTruthy();
    expect(tenants.createTenant).not.toHaveBeenCalled();
  });

  it("createClientAction creates, audits and redirects on valid input", async () => {
    await expect(
      actions.createClientAction(prev, fd({ companyName: "Acme", slug: "acme", ownerEmail: "o@acme.com" })),
    ).rejects.toThrow("REDIRECT:/admin/clients/acc-1");
    expect(tenants.createTenant).toHaveBeenCalledTimes(1);
    expect(tenants.writeAudit).toHaveBeenCalledWith("u1", "tenant.create", "acc-1", expect.anything());
  });

  it("setStatusAction rejects statuses other than active/suspended", async () => {
    const res = await actions.setStatusAction(prev, fd({ accountId: "a", status: "deleted" }));
    expect(res.error).toBe("Invalid status.");
    expect(tenants.setTenantStatus).not.toHaveBeenCalled();
  });

  it("removeDomainAction passes (accountId, domainId)", async () => {
    const res = await actions.removeDomainAction(prev, fd({ accountId: "acc", domainId: "dom" }));
    expect(res.ok).toBe(true);
    expect(tenants.removeTenantDomain).toHaveBeenCalledWith("acc", "dom");
  });

  it("deleteUnassignedUserAction passes accountId through and audits", async () => {
    const res = await actions.deleteUnassignedUserAction(prev, fd({ accountId: "acc" }));
    expect(res.ok).toBe(true);
    expect(tenants.deleteUnassignedUser).toHaveBeenCalledWith("acc");
    expect(tenants.writeAudit).toHaveBeenCalledWith("u1", "user.delete_unassigned", null, { accountId: "acc", email: "x@y.com" });
  });

  it("returns PlatformError messages as state", async () => {
    vi.mocked(tenants.removePlatformAdmin).mockRejectedValueOnce(new tenants.PlatformError("Cannot remove the last platform admin."));
    const res = await actions.removeAdminAction(prev, fd({ userId: "x" }));
    expect(res).toEqual({ error: "Cannot remove the last platform admin." });
  });

  it.each([
    "createClientAction",
    "completeSetupAction",
    "updateBrandingAction",
    "setStatusAction",
    "addDomainAction",
    "removeDomainAction",
    "resendInviteAction",
    "addAdminAction",
    "removeAdminAction",
    "deleteUnassignedUserAction",
  ] as const)("%s requires a platform admin", async (name) => {
    requirePlatformAdmin.mockRejectedValue(new Error("NOT_FOUND"));
    await expect(actions[name](prev, fd({ accountId: "a", status: "active" }))).rejects.toThrow("NOT_FOUND");
    for (const fn of Object.values(tenants)) {
      if (typeof fn === "function" && "mock" in fn) expect(fn).not.toHaveBeenCalled();
    }
  });
});
