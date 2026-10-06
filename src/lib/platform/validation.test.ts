import { describe, expect, it } from "vitest";
import { validateBrandingFile, validateCustomDomain, validateEmail, validateSlug } from "./validation";

describe("validateSlug", () => {
  it.each(["acme", "acme-2", "a1"])("accepts %s", (s) => expect(validateSlug(s)).toEqual({ ok: true, slug: s }));
  it("lowercases and trims", () => expect(validateSlug("  Acme ")).toEqual({ ok: true, slug: "acme" }));
  it.each(["a", "-acme", "acme-", "ac_me", "admin", "www", "api", "app", "x".repeat(41)])(
    "rejects %s", (s) => expect(validateSlug(s).ok).toBe(false));
});

describe("validateBrandingFile", () => {
  const f = (type: string, size: number) => new File([new Uint8Array(size)], "x", { type });
  it("allows no file", () => expect(validateBrandingFile(null, "logo")).toEqual({ ok: true, file: null, ext: null }));
  it("treats an empty file input as no file", () => expect(validateBrandingFile(f("application/octet-stream", 0), "logo")).toEqual({ ok: true, file: null, ext: null }));
  it("accepts a small png logo", () => expect(validateBrandingFile(f("image/png", 1000), "logo")).toMatchObject({ ok: true, ext: "png" }));
  it("rejects svg", () => expect(validateBrandingFile(f("image/svg+xml", 100), "logo").ok).toBe(false));
  it("rejects oversized logos", () => expect(validateBrandingFile(f("image/png", 600 * 1024), "logo").ok).toBe(false));
  it("accepts ico favicons and rejects big ones", () => {
    expect(validateBrandingFile(f("image/x-icon", 1000), "favicon")).toMatchObject({ ok: true, ext: "ico" });
    expect(validateBrandingFile(f("image/png", 200 * 1024), "favicon").ok).toBe(false);
  });
});

describe("validateCustomDomain", () => {
  it("accepts and normalises", () => expect(validateCustomDomain("CRM.Acme.com", "crm.stellmedia.com")).toEqual({ ok: true, hostname: "crm.acme.com" }));
  it("rejects our own base domain space", () => expect(validateCustomDomain("x.crm.stellmedia.com", "crm.stellmedia.com").ok).toBe(false));
  it("rejects single-label and garbage", () => {
    expect(validateCustomDomain("localhost", "crm.stellmedia.com").ok).toBe(false);
    expect(validateCustomDomain("https://acme.com", "crm.stellmedia.com").ok).toBe(false);
  });
});

describe("validateEmail", () => {
  it("accepts and lowercases", () => expect(validateEmail(" Owner@Acme.com ")).toEqual({ ok: true, email: "owner@acme.com" }));
  it("rejects garbage", () => expect(validateEmail("nope").ok).toBe(false));
});
