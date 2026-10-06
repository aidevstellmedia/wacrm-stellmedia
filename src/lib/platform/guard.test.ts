import { beforeEach, describe, expect, it, vi } from "vitest";

let host = "admin.crm.stellmedia.com";
let user: { id: string; email: string } | null = { id: "u1", email: "a@b.c" };
let isAdmin = true;
let queryError: { message: string } | null = null;

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host }) }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (p: string) => { throw new Error(`REDIRECT:${p}`); },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) } }) }));
vi.mock("@/lib/platform/admin-client", () => ({
  platformAdmin: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: queryError ? null : (isAdmin ? { user_id: "u1" } : null), error: queryError }) }) }) }) }),
}));

const { requirePlatformAdmin } = await import("./guard");

beforeEach(() => {
  process.env.ADMIN_HOSTNAME = "admin.crm.stellmedia.com";
  host = "admin.crm.stellmedia.com";
  user = { id: "u1", email: "a@b.c" };
  isAdmin = true;
  queryError = null;
});

describe("requirePlatformAdmin", () => {
  it("returns the admin on the admin host", async () => {
    await expect(requirePlatformAdmin()).resolves.toEqual({ userId: "u1", email: "a@b.c" });
  });
  it("404s on a tenant host", async () => {
    host = "acme.crm.stellmedia.com";
    await expect(requirePlatformAdmin()).rejects.toThrow("NOT_FOUND");
  });
  it("404s when ADMIN_HOSTNAME is unset", async () => {
    delete process.env.ADMIN_HOSTNAME;
    await expect(requirePlatformAdmin()).rejects.toThrow("NOT_FOUND");
  });
  it("redirects signed-out users to /login", async () => {
    user = null;
    await expect(requirePlatformAdmin()).rejects.toThrow("REDIRECT:/login");
  });
  it("404s for signed-in non-admins", async () => {
    isAdmin = false;
    await expect(requirePlatformAdmin()).rejects.toThrow("NOT_FOUND");
  });
  it("404s when platform_admins query errors", async () => {
    queryError = { message: "Database error" };
    await expect(requirePlatformAdmin()).rejects.toThrow("NOT_FOUND");
  });
});
