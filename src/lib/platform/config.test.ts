import { describe, expect, it } from "vitest";
import { readPlatformConfig, tenantOrigin, tenantSubdomainHost } from "./config";

describe("readPlatformConfig", () => {
  it("is disabled with no platform env", () => {
    const cfg = readPlatformConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.platformName).toBe("Stell Media CRM");
  });
  it("is enabled by PLATFORM_BASE_DOMAIN or ADMIN_HOSTNAME", () => {
    expect(readPlatformConfig({ PLATFORM_BASE_DOMAIN: "crm.stellmedia.com" }).enabled).toBe(true);
    expect(readPlatformConfig({ ADMIN_HOSTNAME: "admin.crm.stellmedia.com" }).enabled).toBe(true);
  });
  it("normalises hostnames from env", () => {
    const cfg = readPlatformConfig({ ADMIN_HOSTNAME: "ADMIN.crm.stellmedia.com", PLATFORM_DEFAULT_TENANT_HOST: "Acme.localhost:3000" });
    expect(cfg.adminHostname).toBe("admin.crm.stellmedia.com");
    expect(cfg.defaultTenantHost).toBe("acme.localhost");
  });
});

describe("tenant URLs", () => {
  const cfg = readPlatformConfig({ PLATFORM_BASE_DOMAIN: "crm.stellmedia.com" });
  it("builds the subdomain host", () => {
    expect(tenantSubdomainHost(cfg, "acme")).toBe("acme.crm.stellmedia.com");
  });
  it("defaults origin to https on the subdomain", () => {
    expect(tenantOrigin(cfg, "acme")).toBe("https://acme.crm.stellmedia.com");
  });
  it("honours PLATFORM_TENANT_ORIGIN_TEMPLATE for dev", () => {
    const dev = readPlatformConfig({ PLATFORM_BASE_DOMAIN: "localhost", PLATFORM_TENANT_ORIGIN_TEMPLATE: "http://{slug}.localhost:3000" });
    expect(tenantOrigin(dev, "acme")).toBe("http://acme.localhost:3000");
  });
});
