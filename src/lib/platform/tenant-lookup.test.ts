import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetTenantLookupCachesForTests, forgetProfileAccount, lookupProfileAccountId, lookupTenant } from "./tenant-lookup";

const row = {
  account_id: "acc-1", slug: "acme", display_name: "Acme", logo_path: "acc-1/logo.png",
  favicon_path: null, status: "active", branding_version: "2026-10-06T00:00:00Z",
};

beforeEach(() => __resetTenantLookupCachesForTests());

describe("lookupTenant", () => {
  it("maps the RPC row and caches it", async () => {
    const rpc = vi.fn(async () => ({ data: [row], error: null }));
    const t = await lookupTenant({ rpc }, "acme.crm.stellmedia.com");
    expect(t).toEqual({
      accountId: "acc-1", slug: "acme", displayName: "Acme", logoPath: "acc-1/logo.png",
      faviconPath: null, status: "active", brandingVersion: "2026-10-06T00:00:00Z",
    });
    await lookupTenant({ rpc }, "acme.crm.stellmedia.com");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("resolve_tenant", { p_hostname: "acme.crm.stellmedia.com" });
  });
  it("caches misses too", async () => {
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    expect(await lookupTenant({ rpc }, "nope.example.com")).toBeNull();
    expect(await lookupTenant({ rpc }, "nope.example.com")).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("does not cache errors", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "boom" } }));
    expect(await lookupTenant({ rpc }, "x.example.com")).toBeNull();
    await lookupTenant({ rpc }, "x.example.com");
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});

describe("lookupProfileAccountId", () => {
  it("returns the profile account id", async () => {
    const maybeSingle = vi.fn(async () => ({ data: { account_id: "acc-9" }, error: null }));
    const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }) };
    expect(await lookupProfileAccountId(db, "u1")).toBe("acc-9");
  });
  it("forgets profile account and hits the DB again after", async () => {
    const maybeSingle = vi.fn(async () => ({ data: { account_id: "acc-9" }, error: null }));
    const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }) };
    expect(await lookupProfileAccountId(db, "u2")).toBe("acc-9");
    expect(maybeSingle).toHaveBeenCalledTimes(1);
    forgetProfileAccount("u2");
    expect(await lookupProfileAccountId(db, "u2")).toBe("acc-9");
    expect(maybeSingle).toHaveBeenCalledTimes(2);
  });
});
