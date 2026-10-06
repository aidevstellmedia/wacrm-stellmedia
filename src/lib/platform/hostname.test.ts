import { describe, expect, it } from "vitest";
import { normalizeHostname, requestHostname } from "./hostname";

describe("normalizeHostname", () => {
  it("lowercases, strips port and trailing dot", () => {
    expect(normalizeHostname("Acme.CRM.StellMedia.com:443")).toBe("acme.crm.stellmedia.com");
    expect(normalizeHostname("acme.example.com.")).toBe("acme.example.com");
  });
  it("takes the first entry of a comma list", () => {
    expect(normalizeHostname("a.example.com, b.example.com")).toBe("a.example.com");
  });
  it("rejects empty and garbage", () => {
    expect(normalizeHostname("")).toBeNull();
    expect(normalizeHostname(null)).toBeNull();
    expect(normalizeHostname("bad host!")).toBeNull();
    expect(normalizeHostname("http://x.com")).toBeNull();
  });
});

describe("requestHostname", () => {
  it("prefers x-forwarded-host over host", () => {
    const h = new Headers({ host: "app:3000", "x-forwarded-host": "acme.crm.stellmedia.com" });
    expect(requestHostname(h)).toBe("acme.crm.stellmedia.com");
  });
  it("falls back to host", () => {
    expect(requestHostname(new Headers({ host: "Admin.localhost:3000" }))).toBe("admin.localhost");
  });
});
