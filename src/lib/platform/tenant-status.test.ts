import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetTenantStatusCacheForTests, assertTenantActive, isTenantActive, TenantSuspendedError } from "./tenant-status";

function db(row: { status: string } | null, error: unknown = null) {
  const maybeSingle = vi.fn(async () => ({ data: row, error }));
  return { client: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }) }, maybeSingle };
}

beforeEach(() => __resetTenantStatusCacheForTests());

describe("isTenantActive", () => {
  it("treats a missing tenant_settings row as active", async () => {
    expect(await isTenantActive("a", db(null).client)).toBe(true);
  });
  it("is false for suspended", async () => {
    expect(await isTenantActive("a", db({ status: "suspended" }).client)).toBe(false);
  });
  it("fails open on lookup errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await isTenantActive("a", db(null, { message: "x" }).client)).toBe(true);
  });
  it("caches", async () => {
    const d = db({ status: "active" });
    await isTenantActive("a", d.client);
    await isTenantActive("a", d.client);
    expect(d.maybeSingle).toHaveBeenCalledTimes(1);
  });
});

describe("assertTenantActive", () => {
  it("throws TenantSuspendedError when suspended", async () => {
    await expect(assertTenantActive("a", db({ status: "suspended" }).client)).rejects.toBeInstanceOf(TenantSuspendedError);
  });
});
