import { describe, expect, it } from "vitest";
import { readPlatformConfig } from "./config";
import {
  classifyRequest, classifyTenant, isTenantExemptPath, needsAccountBinding,
  stripTenantHeaders, tenantLookupHost,
} from "./tenant-routing";
import type { TenantRecord } from "./types";

const on = readPlatformConfig({ PLATFORM_BASE_DOMAIN: "crm.stellmedia.com", ADMIN_HOSTNAME: "admin.crm.stellmedia.com" });
const off = readPlatformConfig({});
const PROTECTED = ["/dashboard", "/inbox", "/settings"];
const tenant = (status: "active" | "suspended"): TenantRecord => ({
  accountId: "a", slug: "acme", displayName: "Acme", logoPath: null, faviconPath: null, status, brandingVersion: "v",
});

describe("stripTenantHeaders", () => {
  it("removes every x-tenant-* header, keeps the rest", () => {
    const h = stripTenantHeaders(new Headers({ "x-tenant-id": "evil", "X-Tenant-Host": "evil", cookie: "c" }));
    expect(h.get("x-tenant-id")).toBeNull();
    expect(h.get("x-tenant-host")).toBeNull();
    expect(h.get("cookie")).toBe("c");
  });
});

describe("isTenantExemptPath", () => {
  it.each(["/api/whatsapp/webhook", "/api/v1/contacts", "/auth/callback", "/workspace-suspended", "/workspace-not-found"])(
    "%s is exempt", (p) => expect(isTenantExemptPath(p)).toBe(true));
  it.each(["/dashboard", "/login", "/join/abc", "/api/whatsapp/send", "/api/v1x"])(
    "%s is not exempt", (p) => expect(isTenantExemptPath(p)).toBe(false));
});

describe("needsAccountBinding", () => {
  it.each(["/dashboard", "/inbox/123", "/api/account/members", "/api/whatsapp/send"])(
    "%s needs binding", (p) => expect(needsAccountBinding(p, PROTECTED)).toBe(true));
  it.each(["/join/abc", "/auth/callback", "/login", "/signup", "/forgot-password", "/reset-password",
    "/api/invitations/abc/redeem", "/api/whatsapp/webhook", "/api/v1/me"])(
    "%s does not", (p) => expect(needsAccountBinding(p, PROTECTED)).toBe(false));
});

describe("tenantLookupHost", () => {
  it("maps localhost to the dev default tenant host", () => {
    const dev = readPlatformConfig({ PLATFORM_BASE_DOMAIN: "localhost", PLATFORM_DEFAULT_TENANT_HOST: "stellmedia.localhost" });
    expect(tenantLookupHost(dev, "localhost")).toBe("stellmedia.localhost");
    expect(tenantLookupHost(dev, "acme.localhost")).toBe("acme.localhost");
  });
});

describe("classifyRequest", () => {
  it("is off when platform mode is disabled", () => {
    expect(classifyRequest({ cfg: off, host: "anything", pathname: "/dashboard" })).toBe("off");
  });
  it("exempts webhook paths even on unknown hosts", () => {
    expect(classifyRequest({ cfg: on, host: "old.example.com", pathname: "/api/whatsapp/webhook" })).toBe("exempt");
  });
  it("recognises the admin host", () => {
    expect(classifyRequest({ cfg: on, host: "admin.crm.stellmedia.com", pathname: "/admin" })).toBe("admin");
  });
  it("needs a lookup otherwise", () => {
    expect(classifyRequest({ cfg: on, host: "acme.crm.stellmedia.com", pathname: "/login" })).toBe("lookup");
  });
});

describe("classifyTenant", () => {
  it("handles missing, suspended and active tenants", () => {
    expect(classifyTenant(null)).toBe("not_found");
    expect(classifyTenant(tenant("suspended"))).toBe("suspended");
    expect(classifyTenant(tenant("active"))).toBe("tenant");
  });
});
