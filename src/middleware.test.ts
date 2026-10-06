import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

// --- Scenario knobs the mock reads -----------------------------------------
// `mockUser`         — what getUser() resolves to (a refreshed session ⇒ user,
//                      or null for the logged-out path).
// `refreshedCookies` — cookies Supabase writes via setAll() during getUser(),
//                      i.e. the freshly *rotated* auth token. The whole point
//                      of the test is that these must survive onto whatever
//                      response the middleware returns — including redirects.
let mockUser: { id: string } | null = null;
let refreshedCookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
let mockTenants: Record<string, Record<string, unknown>> = {};
let mockProfileAccountId: string | null = null;
// `mockRpcError` / `mockProfileError` — make the tenant RPC or the profile
// lookup fail with a DB error instead of returning data.
let mockRpcError = false;
let mockProfileError = false;
// `mockSignOutError` — signOut() fails (auth-js returns {error} and keeps
// the session on 5xx/network errors).
let mockSignOutError = false;
const signOutSpy = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: { cookies: { setAll: (c: typeof refreshedCookies) => void } },
  ) => ({
    auth: {
      // Mirrors real auth-js: an expired access token is transparently
      // refreshed inside getUser(), which rotates the refresh token and
      // pushes the new cookies through setAll() before resolving.
      getUser: async () => {
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return { data: { user: mockUser } };
      },
      signOut: async (options?: { scope?: string }) => {
        signOutSpy(options);
        if (mockSignOutError) return { error: { message: "x" } };
        opts.cookies.setAll([{ name: "sb-test-auth-token", value: "", options: { maxAge: 0 } }]);
        return { error: null };
      },
    },
    rpc: async (_fn: string, args: { p_hostname: string }) =>
      mockRpcError
        ? { data: null, error: { message: "boom" } }
        : {
            data: mockTenants[args.p_hostname] ? [mockTenants[args.p_hostname]] : [],
            error: null,
          },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            mockProfileError
              ? { data: null, error: { message: "boom" } }
              : { data: { account_id: mockProfileAccountId }, error: null },
        }),
      }),
    }),
  }),
}));

// Imported after the mock is registered.
const { middleware } = await import("./middleware");
import { __resetTenantLookupCachesForTests } from "@/lib/platform/tenant-lookup";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockUser = null;
  refreshedCookies = [];
  mockTenants = {};
  mockProfileAccountId = null;
  mockRpcError = false;
  mockProfileError = false;
  mockSignOutError = false;
  __resetTenantLookupCachesForTests();
  delete process.env.PLATFORM_BASE_DOMAIN;
  delete process.env.ADMIN_HOSTNAME;
  delete process.env.PLATFORM_DEFAULT_TENANT_HOST;
});

afterEach(() => vi.clearAllMocks());

const ROTATED = {
  name: "sb-test-auth-token",
  value: "rotated-refresh-token",
  options: { path: "/", httpOnly: true },
};

describe("middleware — refreshed auth cookies survive redirects", () => {
  it("carries the rotated token when redirecting a signed-in user off /login", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login"),
    );

    // Redirect to /dashboard…
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    // …and the rotated cookie MUST ride along, otherwise the browser keeps
    // replaying the now-consumed refresh token and the session wedges until
    // the user manually clears cookies.
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("carries the rotated token when redirecting an unauth user to /login", async () => {
    mockUser = null;
    // Even on the logged-out path getUser() may emit cookie writes (e.g.
    // clearing a dead session); those must not be dropped on the redirect.
    refreshedCookies = [{ ...ROTATED, value: "cleared" }];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.cookies.get(ROTATED.name)?.value).toBe("cleared");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login?invite=abc123"),
    );

    expect(res.headers.get("location")).toContain("/join/abc123");
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("passes through (no redirect) for a signed-in user on a protected page", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    // No redirect — the normal NextResponse.next() already carries cookies.
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});

describe("middleware — every dashboard route requires a session", () => {
  // Read the route group rather than hard-coding a list, so a new page added
  // under src/app/(dashboard)/ fails here until it is added to
  // protectedPaths. /flows, /agents and /notifications were missed that way
  // and rendered a broken page to signed-out visitors instead of redirecting.
  const dashboardRoutes = readdirSync(join(__dirname, "app", "(dashboard)"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `/${entry.name}`);

  it("finds the dashboard route group", () => {
    expect(dashboardRoutes).toContain("/dashboard");
  });

  it.each(dashboardRoutes)("redirects a signed-out visitor from %s to /login", async (route) => {
    mockUser = null;

    const res = await middleware(new NextRequest(`https://app.test${route}`));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });
});

const ACME = {
  account_id: "acc-acme", slug: "acme", display_name: "Acme", logo_path: null,
  favicon_path: null, status: "active", branding_version: "v1",
};

// Real requests always carry a Host header (requestHostname reads it);
// `new NextRequest(url)` does not set one, so add it from the URL.
function platformRequest(url: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(url, {
    ...init,
    headers: { host: new URL(url).host, ...init.headers },
  });
}

function platformOn() {
  process.env.PLATFORM_BASE_DOMAIN = "crm.stellmedia.com";
  process.env.ADMIN_HOSTNAME = "admin.crm.stellmedia.com";
}

describe("middleware — white-label platform mode", () => {
  it("rewrites unknown hosts to /workspace-not-found", async () => {
    platformOn();
    const res = await middleware(platformRequest("https://nope.crm.stellmedia.com/login"));
    expect(res.headers.get("x-middleware-rewrite")).toContain("/workspace-not-found");
  });

  it("returns 403 JSON for dashboard APIs of a suspended tenant", async () => {
    platformOn();
    mockTenants["acme.crm.stellmedia.com"] = { ...ACME, status: "suspended" };
    mockUser = { id: "u1" };
    const res = await middleware(platformRequest("https://acme.crm.stellmedia.com/api/whatsapp/send"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "workspace_suspended" });
  });

  it("rewrites suspended tenant pages to /workspace-suspended", async () => {
    platformOn();
    mockTenants["acme.crm.stellmedia.com"] = { ...ACME, status: "suspended" };
    const res = await middleware(platformRequest("https://acme.crm.stellmedia.com/login"));
    expect(res.headers.get("x-middleware-rewrite")).toContain("/workspace-suspended");
  });

  it("lets the Meta webhook through on any host", async () => {
    platformOn();
    const res = await middleware(platformRequest("https://old-host.example.com/api/whatsapp/webhook", { method: "POST" }));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("signs out a user whose account belongs to another tenant", async () => {
    platformOn();
    mockTenants["acme.crm.stellmedia.com"] = ACME;
    mockUser = { id: "u-other" };
    mockProfileAccountId = "acc-other";
    refreshedCookies = [ROTATED];
    const res = await middleware(platformRequest("https://acme.crm.stellmedia.com/dashboard"));
    expect(signOutSpy).toHaveBeenCalledWith({ scope: "local" });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("error")).toBe("wrong_workspace");
    // signOut's cleared cookie (not the rotated token) must reach the redirect.
    expect(res.cookies.get("sb-test-auth-token")?.value).toBe("");
  });

  it("returns 403 JSON wrong_workspace for an API of another tenant", async () => {
    platformOn();
    mockTenants["acme.crm.stellmedia.com"] = ACME;
    mockUser = { id: "u-other" };
    mockProfileAccountId = "acc-other";
    const res = await middleware(platformRequest("https://acme.crm.stellmedia.com/api/account/members"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "wrong_workspace" });
    expect(signOutSpy).toHaveBeenCalledWith({ scope: "local" });
  });

  it("returns 503 (no redirect loop) when sign-out of a wrong-workspace user fails", async () => {
    platformOn();
    mockTenants["acme.crm.stellmedia.com"] = ACME;
    mockUser = { id: "u-other" };
    mockProfileAccountId = "acc-other";
    mockSignOutError = true;
    const res = await middleware(platformRequest("https://acme.crm.stellmedia.com/dashboard"));
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });

  it("rewrites /admin on a tenant host to /workspace-not-found", async () => {
    platformOn();
    mockTenants["acme.crm.stellmedia.com"] = ACME;
    mockUser = { id: "u1" };
    mockProfileAccountId = "acc-acme";
    for (const path of ["/admin", "/admin/tenants"]) {
      const res = await middleware(platformRequest(`https://acme.crm.stellmedia.com${path}`));
      expect(res.headers.get("x-middleware-rewrite")).toContain("/workspace-not-found");
    }
  });

  it("does NOT sign out a not-yet-joined invitee on /join and /auth/callback", async () => {
    platformOn();
    mockTenants["acme.crm.stellmedia.com"] = ACME;
    mockUser = { id: "u-new" };
    mockProfileAccountId = "acc-personal";
    for (const path of ["/join/tok123", "/auth/callback?code=x", "/api/invitations/tok123/redeem"]) {
      const res = await middleware(platformRequest(`https://acme.crm.stellmedia.com${path}`));
      expect(res.headers.get("location")).toBeNull();
    }
    expect(signOutSpy).not.toHaveBeenCalled();
  });

  it("strips a spoofed x-tenant-id and sets the real one", async () => {
    platformOn();
    mockTenants["acme.crm.stellmedia.com"] = ACME;
    mockUser = { id: "u1" };
    mockProfileAccountId = "acc-acme";
    const res = await middleware(
      platformRequest("https://acme.crm.stellmedia.com/dashboard", { headers: { "x-tenant-id": "acc-evil" } }),
    );
    expect(res.headers.get("x-middleware-request-x-tenant-id")).toBe("acc-acme");
  });

  it("redirects /signup without an invite to /login", async () => {
    platformOn();
    mockTenants["acme.crm.stellmedia.com"] = ACME;
    const res = await middleware(platformRequest("https://acme.crm.stellmedia.com/signup"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    const withInvite = await middleware(platformRequest("https://acme.crm.stellmedia.com/signup?invite=t"));
    expect(withInvite.headers.get("location")).toBeNull();
  });

  it("sends a logged-out visitor on the admin host to /login and a signed-in one to /admin", async () => {
    platformOn();
    const anon = await middleware(platformRequest("https://admin.crm.stellmedia.com/admin"));
    expect(new URL(anon.headers.get("location")!).pathname).toBe("/login");
    mockUser = { id: "u1" };
    const dash = await middleware(platformRequest("https://admin.crm.stellmedia.com/dashboard"));
    expect(new URL(dash.headers.get("location")!).pathname).toBe("/admin");
    const login = await middleware(platformRequest("https://admin.crm.stellmedia.com/login"));
    expect(new URL(login.headers.get("location")!).pathname).toBe("/admin");
  });

  it("returns 503 (not 404) for a page when the tenant lookup errors", async () => {
    platformOn();
    mockRpcError = true;
    refreshedCookies = [ROTATED];
    const res = await middleware(platformRequest("https://acme.crm.stellmedia.com/dashboard"));
    expect(res.status).toBe(503);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("returns 503 JSON for an API when the tenant lookup errors", async () => {
    platformOn();
    mockRpcError = true;
    mockUser = { id: "u1" };
    const res = await middleware(platformRequest("https://acme.crm.stellmedia.com/api/contacts"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "service_unavailable" });
  });

  it("returns 503 and does NOT sign out when the profile lookup errors", async () => {
    platformOn();
    mockTenants["acme.crm.stellmedia.com"] = ACME;
    mockUser = { id: "u1" };
    mockProfileError = true;
    const res = await middleware(platformRequest("https://acme.crm.stellmedia.com/dashboard"));
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
    expect(signOutSpy).not.toHaveBeenCalled();
  });

  it("stays inert and strips spoofed tenant headers when platform env is unset", async () => {
    mockUser = { id: "u1" };
    const res = await middleware(
      platformRequest("https://app.test/dashboard", { headers: { "x-tenant-id": "acc-evil" } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-tenant-id")).toBeNull();
  });
});
