import { describe, expect, it } from "vitest";
import { tenantRequestOrigin } from "./request-origin";

const URL_ = "https://acme.crm.stellmedia.com/api/x";
const h = (o: Record<string, string>) => new Headers(o);

describe("tenantRequestOrigin", () => {
  it("returns null without a tenant host header", () => {
    expect(tenantRequestOrigin(h({ host: "a.com" }), URL_)).toBeNull();
  });
  it("builds the origin for a normal tenant host", () => {
    expect(
      tenantRequestOrigin(
        h({ "x-tenant-host": "acme.crm.stellmedia.com", host: "acme.crm.stellmedia.com" }),
        URL_,
      ),
    ).toBe("https://acme.crm.stellmedia.com");
  });
  it("keeps the dev port and http proto", () => {
    expect(
      tenantRequestOrigin(
        h({ "x-tenant-host": "acme.localhost", host: "acme.localhost:3000", "x-forwarded-proto": "http" }),
        "http://acme.localhost:3000/x",
      ),
    ).toBe("http://acme.localhost:3000");
  });
  it("ignores a malformed x-forwarded-host", () => {
    expect(
      tenantRequestOrigin(
        h({
          "x-tenant-host": "acme.crm.stellmedia.com",
          "x-forwarded-host": "evil.com/x",
          host: "acme.crm.stellmedia.com",
        }),
        URL_,
      ),
    ).toBe("https://acme.crm.stellmedia.com");
  });
  it("rejects a non-http proto", () => {
    expect(
      tenantRequestOrigin(
        h({ "x-tenant-host": "acme.crm.stellmedia.com", "x-forwarded-proto": "javascript" }),
        URL_,
      ),
    ).toBe("https://acme.crm.stellmedia.com");
  });
  it("uses the first element of a forwarded-host list and keeps its port", () => {
    expect(
      tenantRequestOrigin(
        h({
          "x-tenant-host": "acme.crm.stellmedia.com",
          "x-forwarded-host": "acme.crm.stellmedia.com:8443, other",
        }),
        URL_,
      ),
    ).toBe("https://acme.crm.stellmedia.com:8443");
  });
});
