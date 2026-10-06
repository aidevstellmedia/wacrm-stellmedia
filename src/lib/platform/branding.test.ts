import { describe, expect, it, vi } from "vitest";
import { readPlatformConfig } from "./config";
import { brandingAssetUrl, brandingFromTenant, resolveBranding } from "./branding";

const SB = "https://proj.supabase.co";

describe("brandingAssetUrl", () => {
  it("builds a cache-busted public storage URL", () => {
    expect(brandingAssetUrl(SB, "acc/logo.png", "2026-10-06T00:00:00Z")).toBe(
      "https://proj.supabase.co/storage/v1/object/public/tenant-branding/acc/logo.png?v=2026-10-06T00%3A00%3A00Z",
    );
  });
  it("returns null without a path", () => {
    expect(brandingAssetUrl(SB, null, "v")).toBeNull();
  });
});

describe("brandingFromTenant", () => {
  it("falls back to the platform name and keeps signup on when platform mode is off", () => {
    const b = brandingFromTenant(null, readPlatformConfig({}), SB);
    expect(b).toEqual({ displayName: "Stell Media CRM", logoUrl: null, faviconUrl: null, signupEnabled: true });
  });
  it("uses the tenant name/logo and disables signup in platform mode", () => {
    const cfg = readPlatformConfig({ PLATFORM_BASE_DOMAIN: "crm.stellmedia.com" });
    const b = brandingFromTenant(
      { accountId: "a", slug: "acme", displayName: "Acme", logoPath: "a/logo.png", faviconPath: null, status: "active", brandingVersion: "v" },
      cfg, SB,
    );
    expect(b.displayName).toBe("Acme");
    expect(b.logoUrl).toContain("/tenant-branding/a/logo.png");
    expect(b.signupEnabled).toBe(false);
  });
});

describe("resolveBranding", () => {
  const cfg = readPlatformConfig({ PLATFORM_BASE_DOMAIN: "crm.stellmedia.com" });
  const tenant = { accountId: "a", slug: "acme", displayName: "Acme", logoPath: null, faviconPath: null, status: "active" as const, brandingVersion: "v" };

  it("returns fallback branding without a host and skips the lookup", async () => {
    const lookup = vi.fn();
    const b = await resolveBranding(null, lookup, cfg, SB);
    expect(b.displayName).toBe("Stell Media CRM");
    expect(lookup).not.toHaveBeenCalled();
  });
  it("uses the looked-up tenant", async () => {
    const b = await resolveBranding("acme.crm.stellmedia.com", async () => tenant, cfg, SB);
    expect(b.displayName).toBe("Acme");
  });
  it("never throws: falls back when the lookup fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const b = await resolveBranding("acme.crm.stellmedia.com", async () => { throw new Error("db down"); }, cfg, SB);
    expect(b).toEqual(brandingFromTenant(null, cfg, SB));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
