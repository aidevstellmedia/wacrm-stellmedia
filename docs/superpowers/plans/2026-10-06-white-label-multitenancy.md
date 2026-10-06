# White-label Multi-tenancy (Phase 1 + 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-deployment wacrm fork into a white-label platform: each client (an existing `accounts` row) is served on its own hostname with its own logo/favicon/name, and a super-admin panel on `admin.crm.stellmedia.com` creates, brands and suspends clients.

**Architecture:** Additive "platform layer". New tables (`tenant_settings`, `tenant_domains`, `platform_admins`, `platform_audit_log`) keyed to `accounts`; `src/middleware.ts` resolves hostname → tenant through a `resolve_tenant` RPC (cached), enforces host↔account binding and suspension, and forwards trusted `x-tenant-*` headers; server components read branding from those headers; the admin panel lives in `src/app/(admin)/admin/` and talks to Supabase with the service-role key behind `requirePlatformAdmin()`. Platform mode is OFF unless `PLATFORM_BASE_DOMAIN` or `ADMIN_HOSTNAME` is set, so upstream behaviour and existing tests are unchanged by default.

**Tech Stack:** Next.js 16.3.5 (App Router, server actions), React 19, Supabase (`@supabase/ssr`, `@supabase/supabase-js`), next-intl, Tailwind, vitest.

**Spec:** `docs/superpowers/specs/2026-10-06-white-label-multitenancy-design.md`

## Global Constraints

- Platform code lives in `src/lib/platform/`, `src/app/(admin)/`, `src/app/workspace-*`; edits to upstream files stay minimal and are listed per task.
- Migrations: `supabase/migrations/100_platform_tenancy.sql`, idempotent (`IF NOT EXISTS`, `DROP POLICY IF EXISTS` before `CREATE POLICY`, `ON CONFLICT`), same style as 0xx files.
- Platform mode is enabled iff `PLATFORM_BASE_DOMAIN` or `ADMIN_HOSTNAME` env is set. With neither set, every request behaves exactly as before this plan.
- Slug: `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$` (2–40 chars), reserved: `admin`, `www`, `app`, `api`.
- Tenant status values: `active` | `suspended`. Missing `tenant_settings` row ⇒ treated as active.
- Trusted headers `x-tenant-id` / `x-tenant-host` are ALWAYS stripped from the incoming request by middleware before being set; nothing else may set them.
- Host↔account binding applies only to dashboard `protectedPaths` and `/api/*` except `/api/whatsapp/webhook*`, `/api/v1/*`, `/api/invitations/*`. Never to `/join/*`, `/auth/*`, `/login`, `/signup`, `/forgot-password`, `/reset-password`.
- Soft suspend: dashboard UI → suspended page, dashboard `/api/*` → 403 `workspace_suspended`, API keys → 403, outbound sends/broadcasts/automations/flows/AI paused; inbound webhook messages still stored.
- Branding uploads: logo ≤ 512 KB (`image/png`, `image/webp`, `image/jpeg`); favicon ≤ 128 KB (`image/png`, `image/x-icon`, `image/vnd.microsoft.icon`). No SVG (stored XSS risk on the storage origin).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `changeAbout.txt`.
- Read `node_modules/next/dist/docs/` for any Next API you're unsure of (Next 16 differs from training data: Middleware is now "Proxy"; we keep the `src/middleware.ts` filename for upstream compatibility).

## Review Focus

1. Invited teammate signs up on a tenant host (gets a temporary personal account) → must reach `/join/<token>` and redeem without being signed out (test in Task 5).
2. A user of client B logs in on client A's host → signed out with `wrong_workspace`, on both pages and dashboard APIs (test in Task 5).
3. Client sends a forged `x-tenant-id` header → ignored/overwritten (test in Task 5).
4. Invite token of client A redeemed on client B's host → rejected 403, user stays where they were (test in Task 7).
5. Suspended client's API key, broadcast and automation sends → refused; inbound message still stored (tests in Task 8).

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/100_platform_tenancy.sql` | Tables, RLS, `is_platform_admin()`, `resolve_tenant()`, bucket, backfill |
| `src/lib/platform/config.ts` | Read platform env → `PlatformConfig` |
| `src/lib/platform/hostname.ts` | Normalise hostnames, read request host |
| `src/lib/platform/types.ts` | `TenantRecord`, `TenantStatus` |
| `src/lib/platform/ttl-cache.ts` | Tiny in-memory TTL cache |
| `src/lib/platform/tenant-lookup.ts` | Cached `resolve_tenant` + profile account lookups |
| `src/lib/platform/tenant-routing.ts` | Pure routing decisions + header constants |
| `src/lib/platform/branding.ts` | Server `getTenantBranding()` + pure helpers |
| `src/lib/platform/branding-context.tsx` | Client `BrandingProvider` / `useBranding` / `BrandMark` |
| `src/lib/platform/tenant-status.ts` | `isTenantActive`, `assertTenantActive`, `TenantSuspendedError` |
| `src/lib/platform/admin-client.ts` | Service-role client for platform code |
| `src/lib/platform/guard.ts` | `requirePlatformAdmin()` |
| `src/lib/platform/validation.ts` | Slug / file / domain / email validation |
| `src/lib/platform/tenants.ts` | Tenant provisioning + admin data access (service role) |
| `src/lib/platform/actions.ts` | `'use server'` actions for the admin UI |
| `src/app/(admin)/admin/**` | Admin pages |
| `src/app/workspace-not-found/page.tsx`, `src/app/workspace-suspended/page.tsx` | Error pages |
| `docs/white-label.md` | Ops guide (NPM, DNS, Supabase auth, env) |

---

### Task 1: Platform config and hostname helpers

**Files:**
- Create: `src/lib/platform/config.ts`, `src/lib/platform/hostname.ts`, `src/lib/platform/types.ts`
- Test: `src/lib/platform/config.test.ts`, `src/lib/platform/hostname.test.ts`

**Interfaces:**
- Produces:
  - `interface PlatformConfig { enabled: boolean; baseDomain: string | null; adminHostname: string | null; defaultTenantHost: string | null; tenantOriginTemplate: string | null; platformName: string }`
  - `readPlatformConfig(env?: Record<string, string | undefined>): PlatformConfig`
  - `tenantSubdomainHost(cfg: PlatformConfig, slug: string): string` (throws if `baseDomain` null)
  - `tenantOrigin(cfg: PlatformConfig, slug: string): string`
  - `normalizeHostname(raw: string | null | undefined): string | null`
  - `requestHostname(headers: Headers): string | null`
  - `type TenantStatus = 'active' | 'suspended'`; `interface TenantRecord { accountId: string; slug: string; displayName: string; logoPath: string | null; faviconPath: string | null; status: TenantStatus; brandingVersion: string }`

- [ ] **Step 1: Write the failing tests**

`src/lib/platform/hostname.test.ts`:
```ts
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
```

`src/lib/platform/config.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/platform/`
Expected: FAIL — cannot resolve `./hostname` / `./config`.

- [ ] **Step 3: Implement**

`src/lib/platform/types.ts`:
```ts
export type TenantStatus = "active" | "suspended";

/** Public, pre-auth view of a tenant — exactly what `resolve_tenant()` returns. */
export interface TenantRecord {
  accountId: string;
  slug: string;
  displayName: string;
  logoPath: string | null;
  faviconPath: string | null;
  status: TenantStatus;
  /** `tenant_settings.updated_at`, used to cache-bust branding asset URLs. */
  brandingVersion: string;
}
```

`src/lib/platform/hostname.ts`:
```ts
// Hostname helpers shared by middleware, branding and the admin panel.
// NPM (Nginx Proxy Manager) forwards the browser's host in
// `x-forwarded-host`; a bare deployment only has `host`.

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

export function normalizeHostname(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let host = raw.split(",")[0].trim().toLowerCase();
  host = host.replace(/:\d+$/, "").replace(/\.$/, "");
  if (!host || host.length > 253 || !HOSTNAME_RE.test(host)) return null;
  return host;
}

export function requestHostname(headers: Headers): string | null {
  return (
    normalizeHostname(headers.get("x-forwarded-host")) ??
    normalizeHostname(headers.get("host"))
  );
}
```

`src/lib/platform/config.ts`:
```ts
import { normalizeHostname } from "./hostname";

export interface PlatformConfig {
  /** False ⇒ single-tenant mode: behave exactly like upstream wacrm. */
  enabled: boolean;
  /** e.g. `crm.stellmedia.com`; tenants get `<slug>.<baseDomain>`. */
  baseDomain: string | null;
  /** e.g. `admin.crm.stellmedia.com`; the only host serving /admin. */
  adminHostname: string | null;
  /** Dev only: hostname whose tenant `localhost` should resolve to. */
  defaultTenantHost: string | null;
  /** Optional, e.g. `http://{slug}.localhost:3000`. */
  tenantOriginTemplate: string | null;
  /** Name shown when no tenant matches (and on the admin host). */
  platformName: string;
}

export function readPlatformConfig(
  env: Record<string, string | undefined> = process.env,
): PlatformConfig {
  const baseDomain = normalizeHostname(env.PLATFORM_BASE_DOMAIN);
  const adminHostname = normalizeHostname(env.ADMIN_HOSTNAME);
  return {
    enabled: Boolean(baseDomain || adminHostname),
    baseDomain,
    adminHostname,
    defaultTenantHost: normalizeHostname(env.PLATFORM_DEFAULT_TENANT_HOST),
    tenantOriginTemplate: env.PLATFORM_TENANT_ORIGIN_TEMPLATE?.trim() || null,
    platformName: env.PLATFORM_NAME?.trim() || "Stell Media CRM",
  };
}

export function tenantSubdomainHost(cfg: PlatformConfig, slug: string): string {
  if (!cfg.baseDomain) throw new Error("PLATFORM_BASE_DOMAIN is not set");
  return `${slug}.${cfg.baseDomain}`;
}

export function tenantOrigin(cfg: PlatformConfig, slug: string): string {
  if (cfg.tenantOriginTemplate) return cfg.tenantOriginTemplate.replace("{slug}", slug);
  return `https://${tenantSubdomainHost(cfg, slug)}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/platform/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/platform/config.ts src/lib/platform/hostname.ts src/lib/platform/types.ts src/lib/platform/*.test.ts
git commit -m "feat(platform): platform config and hostname helpers"
```

---

### Task 2: Database migration

**Files:**
- Create: `supabase/migrations/100_platform_tenancy.sql`
- Modify: `supabase/ci/verify-schema.sql` (append assertions inside the existing `DO $$ … $$` block, before its `END`)

**Interfaces:**
- Produces (SQL): tables `tenant_settings`, `tenant_domains`, `platform_admins`, `platform_audit_log`; functions `is_platform_admin() RETURNS boolean`, `resolve_tenant(p_hostname text) RETURNS TABLE(account_id uuid, slug text, display_name text, logo_path text, favicon_path text, status text, branding_version timestamptz)`; storage bucket `tenant-branding`.

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- 100_platform_tenancy.sql — White-label platform layer
--
-- Additive on top of 017's account model: a client ("tenant") IS an
-- `accounts` row. These tables add hostnames, branding, status and
-- the super-admin roster. Numbered 100 so upstream's 0xx migrations
-- never collide. Idempotent — safe to re-run.
-- ============================================================

-- ---------- tenant_settings ----------
CREATE TABLE IF NOT EXISTS tenant_settings (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE
    CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$' AND char_length(slug) >= 2
           AND slug NOT IN ('admin', 'www', 'app', 'api')),
  logo_path TEXT,
  favicon_path TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  suspended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS set_updated_at ON tenant_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON tenant_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------- tenant_domains ----------
CREATE TABLE IF NOT EXISTS tenant_domains (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL UNIQUE CHECK (hostname = lower(hostname)),
  kind TEXT NOT NULL CHECK (kind IN ('subdomain', 'custom')),
  verified_at TIMESTAMPTZ,
  npm_proxy_host_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tenant_domains_account ON tenant_domains(account_id);
ALTER TABLE tenant_domains ENABLE ROW LEVEL SECURITY;

-- ---------- platform_admins ----------
CREATE TABLE IF NOT EXISTS platform_admins (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;

-- ---------- platform_audit_log ----------
CREATE TABLE IF NOT EXISTS platform_audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_log_created ON platform_audit_log(created_at DESC);
ALTER TABLE platform_audit_log ENABLE ROW LEVEL SECURITY;

-- ---------- helpers ----------
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM platform_admins WHERE user_id = auth.uid());
$$;

-- Pre-auth branding lookup. Returns only public-safe columns.
CREATE OR REPLACE FUNCTION public.resolve_tenant(p_hostname TEXT)
RETURNS TABLE (
  account_id UUID, slug TEXT, display_name TEXT, logo_path TEXT,
  favicon_path TEXT, status TEXT, branding_version TIMESTAMPTZ
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT ts.account_id, ts.slug, a.name, ts.logo_path, ts.favicon_path, ts.status, ts.updated_at
  FROM tenant_domains td
  JOIN tenant_settings ts ON ts.account_id = td.account_id
  JOIN accounts a ON a.id = td.account_id
  WHERE td.hostname = lower(p_hostname)
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.resolve_tenant(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated;

-- ---------- policies ----------
DROP POLICY IF EXISTS tenant_settings_admin_all ON tenant_settings;
CREATE POLICY tenant_settings_admin_all ON tenant_settings FOR ALL
  USING (is_platform_admin()) WITH CHECK (is_platform_admin());
DROP POLICY IF EXISTS tenant_settings_member_select ON tenant_settings;
CREATE POLICY tenant_settings_member_select ON tenant_settings FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS tenant_domains_admin_all ON tenant_domains;
CREATE POLICY tenant_domains_admin_all ON tenant_domains FOR ALL
  USING (is_platform_admin()) WITH CHECK (is_platform_admin());

DROP POLICY IF EXISTS platform_admins_admin_all ON platform_admins;
CREATE POLICY platform_admins_admin_all ON platform_admins FOR ALL
  USING (is_platform_admin()) WITH CHECK (is_platform_admin());

DROP POLICY IF EXISTS platform_audit_log_admin_select ON platform_audit_log;
CREATE POLICY platform_audit_log_admin_select ON platform_audit_log FOR SELECT
  USING (is_platform_admin());

-- ---------- storage ----------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('tenant-branding', 'tenant-branding', TRUE, 524288,
        ARRAY['image/png', 'image/webp', 'image/jpeg', 'image/x-icon', 'image/vnd.microsoft.icon'])
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Tenant branding is publicly readable" ON storage.objects;
CREATE POLICY "Tenant branding is publicly readable" ON storage.objects FOR SELECT
  USING (bucket_id = 'tenant-branding');
-- No INSERT/UPDATE/DELETE policies: only the service role writes here.

-- ---------- backfill: Stell Media = client #1 ----------
DO $$
DECLARE
  v_user_id UUID;
  v_account_id UUID;
BEGIN
  SELECT id INTO v_user_id FROM auth.users WHERE email = 'ai.dev@stellmedia.com' LIMIT 1;
  IF v_user_id IS NULL THEN
    RETURN; -- fresh/CI database: nothing to backfill
  END IF;

  INSERT INTO platform_admins (user_id) VALUES (v_user_id) ON CONFLICT DO NOTHING;

  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = v_user_id;
  IF v_account_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO tenant_settings (account_id, slug)
  VALUES (v_account_id, 'stellmedia')
  ON CONFLICT (account_id) DO NOTHING;

  INSERT INTO tenant_domains (account_id, hostname, kind, verified_at)
  VALUES (v_account_id, 'stellmedia.crm.stellmedia.com', 'subdomain', NOW())
  ON CONFLICT (hostname) DO NOTHING;
END $$;
```

- [ ] **Step 2: Append CI assertions** to `supabase/ci/verify-schema.sql` inside the existing `DO $$` block, before its final `END`:

```sql
  -- Platform layer, from 100.
  IF to_regclass('public.tenant_settings') IS NULL
     OR to_regclass('public.tenant_domains') IS NULL
     OR to_regclass('public.platform_admins') IS NULL
     OR to_regclass('public.platform_audit_log') IS NULL THEN
    RAISE EXCEPTION 'platform tables missing — 100_platform_tenancy did not apply';
  END IF;
  IF to_regprocedure('public.resolve_tenant(text)') IS NULL THEN
    RAISE EXCEPTION 'public.resolve_tenant(text) missing';
  END IF;
```

- [ ] **Step 3: Apply locally and prove idempotency**

Run (requires Docker + Supabase CLI): `npx supabase db reset && psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/ci/verify-schema.sql && psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/migrations/100_platform_tenancy.sql`
Expected: reset succeeds, verify prints no exception, second apply of 100 succeeds with no errors. If the Supabase CLI isn't available, say so in the task report and note it as unverified. Do NOT skip silently.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/100_platform_tenancy.sql supabase/ci/verify-schema.sql
git commit -m "feat(platform): tenant, domain, admin and audit tables"
```

---

### Task 3: TTL cache and tenant lookup

**Files:**
- Create: `src/lib/platform/ttl-cache.ts`, `src/lib/platform/tenant-lookup.ts`
- Test: `src/lib/platform/ttl-cache.test.ts`, `src/lib/platform/tenant-lookup.test.ts`

**Interfaces:**
- Consumes: `TenantRecord` (Task 1).
- Produces:
  - `class TtlCache<V> { constructor(ttlMs: number, now?: () => number); get(key: string): V | undefined; set(key: string, value: V): void; delete(key: string): void; clear(): void }`. Stores `undefined`-distinct `null` values (negative caching).
  - `interface RpcClient { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> }`
  - `interface ProfileClient { from(table: 'profiles'): { select(cols: string): { eq(col: string, v: string): { maybeSingle(): PromiseLike<{ data: { account_id: string | null } | null; error: unknown }> } } } }`
  - `lookupTenant(db: RpcClient, hostname: string): Promise<TenantRecord | null>`
  - `lookupProfileAccountId(db: ProfileClient, userId: string): Promise<string | null>`
  - `__resetTenantLookupCachesForTests(): void`

- [ ] **Step 1: Write the failing tests**

`src/lib/platform/ttl-cache.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { TtlCache } from "./ttl-cache";

describe("TtlCache", () => {
  it("returns values until they expire", () => {
    let t = 0;
    const c = new TtlCache<string | null>(1000, () => t);
    c.set("a", "x");
    c.set("b", null);
    expect(c.get("a")).toBe("x");
    expect(c.get("b")).toBeNull();
    t = 1001;
    expect(c.get("a")).toBeUndefined();
  });
});
```

`src/lib/platform/tenant-lookup.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetTenantLookupCachesForTests, lookupProfileAccountId, lookupTenant } from "./tenant-lookup";

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
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/platform/ttl-cache.test.ts src/lib/platform/tenant-lookup.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

`src/lib/platform/ttl-cache.ts`:
```ts
/** Minimal per-process TTL cache. Values may be `null` (negative caching). */
export class TtlCache<V> {
  private store = new Map<string, { value: V; expires: number }>();
  constructor(private ttlMs: number, private now: () => number = Date.now) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.store.size > 5000) this.store.clear(); // crude bound
    this.store.set(key, { value, expires: this.now() + this.ttlMs });
  }

  delete(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
}
```

`src/lib/platform/tenant-lookup.ts`:
```ts
// Cached hostname → tenant and user → account lookups. Used by the
// middleware on every request, so both are cached for 60s per process.
// Suspensions and domain edits therefore take effect within a minute.

import { TtlCache } from "./ttl-cache";
import type { TenantRecord, TenantStatus } from "./types";

const TTL_MS = 60_000;
const tenantCache = new TtlCache<TenantRecord | null>(TTL_MS);
const profileCache = new TtlCache<string | null>(TTL_MS);

export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface ProfileClient {
  from(table: "profiles"): {
    select(cols: string): {
      eq(col: string, v: string): {
        maybeSingle(): PromiseLike<{ data: { account_id: string | null } | null; error: unknown }>;
      };
    };
  };
}

interface ResolveTenantRow {
  account_id: string;
  slug: string;
  display_name: string;
  logo_path: string | null;
  favicon_path: string | null;
  status: string;
  branding_version: string;
}

export async function lookupTenant(db: RpcClient, hostname: string): Promise<TenantRecord | null> {
  const cached = tenantCache.get(hostname);
  if (cached !== undefined) return cached;

  const { data, error } = await db.rpc("resolve_tenant", { p_hostname: hostname });
  if (error) {
    console.error("[platform] resolve_tenant failed:", error.message);
    return null; // not cached — retry next request
  }
  const row = (Array.isArray(data) ? data[0] : data) as ResolveTenantRow | undefined;
  const tenant: TenantRecord | null = row
    ? {
        accountId: row.account_id,
        slug: row.slug,
        displayName: row.display_name,
        logoPath: row.logo_path,
        faviconPath: row.favicon_path,
        status: row.status as TenantStatus,
        brandingVersion: row.branding_version,
      }
    : null;
  tenantCache.set(hostname, tenant);
  return tenant;
}

export async function lookupProfileAccountId(db: ProfileClient, userId: string): Promise<string | null> {
  const cached = profileCache.get(userId);
  if (cached !== undefined) return cached;
  const { data, error } = await db.from("profiles").select("account_id").eq("user_id", userId).maybeSingle();
  if (error) return null;
  const accountId = data?.account_id ?? null;
  profileCache.set(userId, accountId);
  return accountId;
}

export function __resetTenantLookupCachesForTests(): void {
  tenantCache.clear();
  profileCache.clear();
}
```

**Note on the profile cache:** after an invite is redeemed the user's `account_id` changes. A stale cached value could sign them out right after joining. Task 7 calls `forgetProfileAccount(userId)` after redeem. Add it now:
```ts
export function forgetProfileAccount(userId: string): void {
  profileCache.delete(userId);
}
```
The redeem route and the middleware may run in the same Node process (Docker `next start`), so this is effective there. In addition, Task 5's middleware skips the cache when the cached value mismatches (re-reads once before signing out).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/platform/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/platform/ttl-cache.ts src/lib/platform/tenant-lookup.ts src/lib/platform/ttl-cache.test.ts src/lib/platform/tenant-lookup.test.ts
git commit -m "feat(platform): cached tenant and profile lookups"
```

---

### Task 4: Pure routing decisions

**Files:**
- Create: `src/lib/platform/tenant-routing.ts`
- Test: `src/lib/platform/tenant-routing.test.ts`

**Interfaces:**
- Consumes: `PlatformConfig`, `TenantRecord`.
- Produces:
  - `const TENANT_HEADER_ID = "x-tenant-id"`, `const TENANT_HEADER_HOST = "x-tenant-host"`
  - `stripTenantHeaders(headers: Headers): Headers` (returns a copy without any `x-tenant-*`)
  - `isTenantExemptPath(pathname: string): boolean`
  - `needsAccountBinding(pathname: string, protectedPaths: readonly string[]): boolean`
  - `tenantLookupHost(cfg: PlatformConfig, host: string | null): string | null`
  - `type RouteKind = "off" | "exempt" | "admin" | "not_found" | "suspended" | "tenant"`
  - `classifyRequest(input: { cfg: PlatformConfig; host: string | null; pathname: string }): "off" | "exempt" | "admin" | "lookup"`
  - `classifyTenant(tenant: TenantRecord | null): "not_found" | "suspended" | "tenant"`

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/platform/tenant-routing.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// Pure request-classification rules for the white-label platform.
// The middleware does the I/O; everything decidable from config + path
// lives here so it can be unit-tested exhaustively.

import type { PlatformConfig } from "./config";
import type { TenantRecord } from "./types";

export const TENANT_HEADER_ID = "x-tenant-id";
export const TENANT_HEADER_HOST = "x-tenant-host";

/** Paths that are never tenant-gated: Meta webhooks hit one URL, API-key
 *  calls carry their own account, and the error pages must render. */
const EXEMPT_PREFIXES = [
  "/api/whatsapp/webhook",
  "/api/v1/",
  "/auth/callback",
  "/workspace-not-found",
  "/workspace-suspended",
];

/** Pages a not-yet-joined user must reach on a tenant host. */
const NO_BINDING_PREFIXES = ["/api/invitations/"];

export function stripTenantHeaders(headers: Headers): Headers {
  const copy = new Headers(headers);
  for (const key of [...copy.keys()]) {
    if (key.toLowerCase().startsWith("x-tenant-")) copy.delete(key);
  }
  return copy;
}

export function isTenantExemptPath(pathname: string): boolean {
  return EXEMPT_PREFIXES.some((p) => pathname === p.replace(/\/$/, "") || pathname.startsWith(p));
}

export function needsAccountBinding(pathname: string, protectedPaths: readonly string[]): boolean {
  if (isTenantExemptPath(pathname)) return false;
  if (NO_BINDING_PREFIXES.some((p) => pathname.startsWith(p))) return false;
  if (pathname.startsWith("/api/")) return true;
  return protectedPaths.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function tenantLookupHost(cfg: PlatformConfig, host: string | null): string | null {
  if (host === "localhost" && cfg.defaultTenantHost) return cfg.defaultTenantHost;
  return host;
}

export function classifyRequest(input: {
  cfg: PlatformConfig;
  host: string | null;
  pathname: string;
}): "off" | "exempt" | "admin" | "lookup" {
  const { cfg, host, pathname } = input;
  if (!cfg.enabled) return "off";
  if (isTenantExemptPath(pathname)) return "exempt";
  if (cfg.adminHostname && host === cfg.adminHostname) return "admin";
  return "lookup";
}

export function classifyTenant(tenant: TenantRecord | null): "not_found" | "suspended" | "tenant" {
  if (!tenant) return "not_found";
  return tenant.status === "suspended" ? "suspended" : "tenant";
}
```

Note: `"/api/v1x"` must NOT be exempt. `"/api/v1/"` only matches with the trailing slash, and the `pathname === p.replace(/\/$/, "")` arm makes `/api/v1` itself exempt.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/platform/tenant-routing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/platform/tenant-routing.ts src/lib/platform/tenant-routing.test.ts
git commit -m "feat(platform): pure tenant routing rules"
```

---

### Task 5: Middleware integration, error pages, cache header

**Files:**
- Modify: `src/middleware.ts` (whole file shown below)
- Modify: `src/middleware.test.ts` (extend mock + new describe block)
- Create: `src/app/workspace-not-found/page.tsx`, `src/app/workspace-suspended/page.tsx`
- Modify: `messages/en.json`, `messages/es.json`, `messages/pt.json`, `messages/ko.json` (add `Workspace` namespace + `LoginPage.wrongWorkspace`)
- Modify: `next.config.ts` (add `Vary` header to the page cache rule)

**Interfaces:**
- Consumes: Tasks 1, 3, 4.
- Produces: requests reaching server components on a tenant host carry trusted `x-tenant-id` and `x-tenant-host`. `/login?error=wrong_workspace` is a recognised login error.

- [ ] **Step 1: Extend the test mock and write failing tests**

In `src/middleware.test.ts`, replace the scenario knobs + `vi.mock` block with the version below (adds `rpc`, `from`, `signOut`). Keep the rest of the file. Add `import { __resetTenantLookupCachesForTests } from "@/lib/platform/tenant-lookup";` after the middleware import. Call `__resetTenantLookupCachesForTests()` in `beforeEach`, and also reset `mockTenants = {}` and `mockProfileAccountId = null` there. Delete `process.env.PLATFORM_BASE_DOMAIN`, `ADMIN_HOSTNAME` and `PLATFORM_DEFAULT_TENANT_HOST` there too.

```ts
let mockUser: { id: string } | null = null;
let refreshedCookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
let mockTenants: Record<string, Record<string, unknown>> = {};
let mockProfileAccountId: string | null = null;
const signOutSpy = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: { cookies: { setAll: (c: typeof refreshedCookies) => void } },
  ) => ({
    auth: {
      getUser: async () => {
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return { data: { user: mockUser } };
      },
      signOut: async () => {
        signOutSpy();
        opts.cookies.setAll([{ name: "sb-test-auth-token", value: "", options: { maxAge: 0 } }]);
        return { error: null };
      },
    },
    rpc: async (_fn: string, args: { p_hostname: string }) => ({
      data: mockTenants[args.p_hostname] ? [mockTenants[args.p_hostname]] : [],
      error: null,
    }),
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { account_id: mockProfileAccountId }, error: null }) }) }),
    }),
  }),
}));
```

Append this describe block:

```ts
const ACME = {
  account_id: "acc-acme", slug: "acme", display_name: "Acme", logo_path: null,
  favicon_path: null, status: "active", branding_version: "v1",
};

function platformOn() {
  process.env.PLATFORM_BASE_DOMAIN = "crm.stellmedia.com";
  process.env.ADMIN_HOSTNAME = "admin.crm.stellmedia.com";
}

describe("middleware — white-label platform mode", () => {
  it("rewrites unknown hosts to /workspace-not-found", async () => {
    platformOn();
    const res = await middleware(new NextRequest("https://nope.crm.stellmedia.com/login"));
    expect(res.headers.get("x-middleware-rewrite")).toContain("/workspace-not-found");
  });

  it("returns 403 JSON for dashboard APIs of a suspended tenant", async () => {
    platformOn();
    mockTenants["acme.crm.stellmedia.com"] = { ...ACME, status: "suspended" };
    mockUser = { id: "u1" };
    const res = await middleware(new NextRequest("https://acme.crm.stellmedia.com/api/whatsapp/send"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "workspace_suspended" });
  });

  it("rewrites suspended tenant pages to /workspace-suspended", async () => {
    platformOn();
    mockTenants["acme.crm.stellmedia.com"] = { ...ACME, status: "suspended" };
    const res = await middleware(new NextRequest("https://acme.crm.stellmedia.com/login"));
    expect(res.headers.get("x-middleware-rewrite")).toContain("/workspace-suspended");
  });

  it("lets the Meta webhook through on any host", async () => {
    platformOn();
    const res = await middleware(new NextRequest("https://old-host.example.com/api/whatsapp/webhook", { method: "POST" }));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("signs out a user whose account belongs to another tenant", async () => {
    platformOn();
    mockTenants["acme.crm.stellmedia.com"] = ACME;
    mockUser = { id: "u-other" };
    mockProfileAccountId = "acc-other";
    const res = await middleware(new NextRequest("https://acme.crm.stellmedia.com/dashboard"));
    expect(signOutSpy).toHaveBeenCalled();
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("error")).toBe("wrong_workspace");
  });

  it("does NOT sign out a not-yet-joined invitee on /join and /auth/callback", async () => {
    platformOn();
    mockTenants["acme.crm.stellmedia.com"] = ACME;
    mockUser = { id: "u-new" };
    mockProfileAccountId = "acc-personal";
    for (const path of ["/join/tok123", "/auth/callback?code=x", "/api/invitations/tok123/redeem"]) {
      const res = await middleware(new NextRequest(`https://acme.crm.stellmedia.com${path}`));
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
      new NextRequest("https://acme.crm.stellmedia.com/dashboard", { headers: { "x-tenant-id": "acc-evil" } }),
    );
    expect(res.headers.get("x-middleware-request-x-tenant-id")).toBe("acc-acme");
  });

  it("redirects /signup without an invite to /login", async () => {
    platformOn();
    mockTenants["acme.crm.stellmedia.com"] = ACME;
    const res = await middleware(new NextRequest("https://acme.crm.stellmedia.com/signup"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    const withInvite = await middleware(new NextRequest("https://acme.crm.stellmedia.com/signup?invite=t"));
    expect(withInvite.headers.get("location")).toBeNull();
  });

  it("sends a logged-out visitor on the admin host to /login and a signed-in one to /admin", async () => {
    platformOn();
    const anon = await middleware(new NextRequest("https://admin.crm.stellmedia.com/admin"));
    expect(new URL(anon.headers.get("location")!).pathname).toBe("/login");
    mockUser = { id: "u1" };
    const dash = await middleware(new NextRequest("https://admin.crm.stellmedia.com/dashboard"));
    expect(new URL(dash.headers.get("location")!).pathname).toBe("/admin");
    const login = await middleware(new NextRequest("https://admin.crm.stellmedia.com/login"));
    expect(new URL(login.headers.get("location")!).pathname).toBe("/admin");
  });
});
```

`x-middleware-request-<name>` is how Next exposes overridden request headers on a `NextResponse.next({ request: { headers } })` response. If the assertion's header name differs in Next 16.3.5, check `node_modules/next/dist/server/web/spec-extension/response.js` for the exact prefix and adjust the test, not the behaviour.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/middleware.test.ts`
Expected: the new platform-mode tests FAIL; the existing tests still PASS.

- [ ] **Step 3: Rewrite `src/middleware.ts`**

Keep all existing comments and the upstream `createServerClient` / `setAll` block **unchanged** (it uses `NextResponse.next({ request })`; `request.cookies.set` keeps `request.headers` current, so headers forwarded at the end include any refreshed session cookie). New structure:

```ts
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { readPlatformConfig } from '@/lib/platform/config'
import { requestHostname } from '@/lib/platform/hostname'
import { forgetProfileAccount, lookupProfileAccountId, lookupTenant } from '@/lib/platform/tenant-lookup'
import {
  TENANT_HEADER_HOST,
  TENANT_HEADER_ID,
  classifyRequest,
  classifyTenant,
  needsAccountBinding,
  stripTenantHeaders,
  tenantLookupHost,
} from '@/lib/platform/tenant-routing'

// Protected pages - redirect to login if not authenticated
// Every top-level route under src/app/(dashboard)/ belongs here —
// middleware.test.ts reads that directory and fails on a missing one.
const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/flows', '/agents', '/notifications', '/settings']

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })
  const supabase = createServerClient(/* … upstream code unchanged … */)
  const { data: { user } } = await supabase.auth.getUser()
  const withRefreshedCookies = /* … upstream code unchanged … */

  const pathname = request.nextUrl.pathname
  const isApi = pathname.startsWith('/api/')

  // White-label: never trust tenant headers from the client. Built at the
  // END (after getUser() may have rewritten request cookies) so forwarded
  // headers carry the refreshed session.
  let tenantHeaders: { id: string; host: string } | null = null
  const forwardHeaders = () => {
    const h = stripTenantHeaders(request.headers)
    if (tenantHeaders) {
      h.set(TENANT_HEADER_ID, tenantHeaders.id)
      h.set(TENANT_HEADER_HOST, tenantHeaders.host)
    }
    return h
  }
  const redirectTo = (path: string, params: Record<string, string> = {}) => {
    const url = request.nextUrl.clone()
    url.pathname = path
    url.search = ''
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    return withRefreshedCookies(NextResponse.redirect(url))
  }
  const rewriteTo = (path: string) => {
    const url = request.nextUrl.clone()
    url.pathname = path
    url.search = ''
    return withRefreshedCookies(NextResponse.rewrite(url, { request: { headers: forwardHeaders() } }))
  }

  // ---------------- White-label platform layer ----------------
  const cfg = readPlatformConfig()
  const host = requestHostname(request.headers)
  const kind = classifyRequest({ cfg, host, pathname })

  if (kind === 'admin') {
    if (pathname === '/signup') return redirectTo('/login')
    if (!user && pathname.startsWith('/admin')) return redirectTo('/login')
    if (user && (pathname === '/login' || protectedPaths.some(p => pathname.startsWith(p)))) {
      return redirectTo('/admin')
    }
  }

  if (kind === 'lookup') {
    const lookupHost = tenantLookupHost(cfg, host)
    const tenant = lookupHost ? await lookupTenant(supabase, lookupHost) : null
    const tenantKind = classifyTenant(tenant)

    if (tenantKind === 'not_found') {
      if (isApi) return withRefreshedCookies(NextResponse.json({ error: 'workspace_not_found' }, { status: 404 }))
      return rewriteTo('/workspace-not-found')
    }
    if (tenantKind === 'suspended') {
      if (isApi) return withRefreshedCookies(NextResponse.json({ error: 'workspace_suspended' }, { status: 403 }))
      return rewriteTo('/workspace-suspended')
    }

    tenantHeaders = { id: tenant!.accountId, host: lookupHost! }

    if (pathname === '/signup' && !request.nextUrl.searchParams.get('invite')) {
      return redirectTo('/login')
    }

    // Host↔account binding. Never on /join, /auth, /login, /signup,
    // /reset-password — a fresh invitee still has a temporary personal
    // account until redeem_invitation moves them (019).
    if (user && needsAccountBinding(pathname, protectedPaths)) {
      let accountId = await lookupProfileAccountId(supabase, user.id)
      if (accountId !== tenant!.accountId) {
        // Cached value may predate an invite redeem — re-read once.
        forgetProfileAccount(user.id)
        accountId = await lookupProfileAccountId(supabase, user.id)
      }
      if (accountId !== tenant!.accountId) {
        await supabase.auth.signOut()
        if (isApi) return withRefreshedCookies(NextResponse.json({ error: 'wrong_workspace' }, { status: 403 }))
        return redirectTo('/login', { error: 'wrong_workspace' })
      }
    }
  }

  // ---------------- Existing upstream rules (unchanged) ----------------
  // Keep the /login|/signup|/forgot-password signed-in redirect, the
  // protectedPaths redirect (now using the module-level const) and the
  // /api/whatsapp 401 block verbatim.

  // Replaces upstream's final `return supabaseResponse`.
  return withRefreshedCookies(NextResponse.next({ request: { headers: forwardHeaders() } }))
}

export const config = { /* unchanged */ }
```

Implementation notes:
- Delete the old function-local `protectedPaths` declaration. The upstream test checks behaviour, not source.
- Every early return goes through `withRefreshedCookies` (issue #288). `signOut()` writes cleared cookies via `setAll` onto `supabaseResponse`, and `withRefreshedCookies` carries them onto the redirect.
- The middleware supabase client satisfies the `RpcClient` / `ProfileClient` interfaces structurally. If TS complains about the generic Supabase types, cast once at the call (`supabase as unknown as RpcClient`) rather than loosening the interfaces.

- [ ] **Step 4: Error pages + i18n**

`src/app/workspace-not-found/page.tsx`:
```tsx
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function WorkspaceNotFoundPage() {
  const t = await getTranslations("Workspace");
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold text-foreground">{t("notFoundTitle")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("notFoundBody")}</p>
      </div>
    </main>
  );
}
```
`src/app/workspace-suspended/page.tsx`: identical structure, using `suspendedTitle` / `suspendedBody`.

Add to each `messages/*.json` (top-level namespace):
- en: `"Workspace": { "notFoundTitle": "Workspace not found", "notFoundBody": "There is no workspace at this address. Check the link you were given.", "suspendedTitle": "Workspace suspended", "suspendedBody": "This workspace is currently suspended. Please contact your service provider." }`
- es: `"Workspace": { "notFoundTitle": "Espacio de trabajo no encontrado", "notFoundBody": "No hay ningún espacio de trabajo en esta dirección. Revisa el enlace que recibiste.", "suspendedTitle": "Espacio de trabajo suspendido", "suspendedBody": "Este espacio de trabajo está suspendido. Ponte en contacto con tu proveedor de servicio." }`
- pt: `"Workspace": { "notFoundTitle": "Espaço de trabalho não encontrado", "notFoundBody": "Não há nenhum espaço de trabalho neste endereço. Verifique o link que você recebeu.", "suspendedTitle": "Espaço de trabalho suspenso", "suspendedBody": "Este espaço de trabalho está suspenso. Entre em contato com seu provedor de serviço." }`
- ko: `"Workspace": { "notFoundTitle": "워크스페이스를 찾을 수 없습니다", "notFoundBody": "이 주소에는 워크스페이스가 없습니다. 받은 링크를 확인하세요.", "suspendedTitle": "워크스페이스가 일시 중지되었습니다", "suspendedBody": "이 워크스페이스는 현재 일시 중지 상태입니다. 서비스 제공업체에 문의하세요." }`

Add `LoginPage.wrongWorkspace`:
- en `"This account doesn't belong to this workspace. Sign in at your own workspace's address."`
- es `"Esta cuenta no pertenece a este espacio de trabajo. Inicia sesión en la dirección de tu propio espacio."`
- pt `"Esta conta não pertence a este espaço de trabalho. Entre pelo endereço do seu próprio espaço."`
- ko `"이 계정은 이 워크스페이스에 속하지 않습니다. 본인 워크스페이스 주소에서 로그인하세요."`

In `src/app/(auth)/login/page.tsx`, extend the `linkErrorMessage` chain with `: linkError === "wrong_workspace" ? t("wrongWorkspace")` before the final `: null`.

- [ ] **Step 5: Vary header**

In `next.config.ts`, inside the rule with `source: "/:path((?!_next/static|_next/image|api).*)"`, add `{ key: "Vary", value: "Host, X-Forwarded-Host" }` to its `headers` array, with the comment `// White-label: same path renders different branding per host.`

- [ ] **Step 6: Run all tests + typecheck**

Run: `npx vitest run src/middleware.test.ts && npm run typecheck`
Expected: PASS, including every pre-existing middleware test.

- [ ] **Step 7: Commit**

```bash
git add src/middleware.ts src/middleware.test.ts src/app/workspace-not-found src/app/workspace-suspended messages/*.json src/app/\(auth\)/login/page.tsx next.config.ts
git commit -m "feat(platform): resolve tenant per host in middleware with account binding"
```

---

### Task 6: Branding in the UI

**Files:**
- Create: `src/lib/platform/branding.ts`, `src/lib/platform/branding-context.tsx`
- Test: `src/lib/platform/branding.test.ts`
- Modify: `src/app/layout.tsx` (metadata → `generateMetadata`, wrap children in `BrandingProvider`)
- Modify: `src/components/layout/sidebar.tsx` (logo row ~L187-196)
- Modify: `src/app/(auth)/login/page.tsx`, `src/app/(auth)/signup/page.tsx` (`MessageSquare` header icon → `<BrandMark />`, hide "Create account" link when signup disabled)

**Interfaces:**
- Consumes: `lookupTenant`, `TENANT_HEADER_HOST`, `readPlatformConfig`, `TenantRecord`.
- Produces:
  - `interface TenantBranding { displayName: string; logoUrl: string | null; faviconUrl: string | null; signupEnabled: boolean }`
  - `brandingAssetUrl(supabaseUrl: string, path: string | null, version: string): string | null`
  - `brandingFromTenant(tenant: TenantRecord | null, cfg: PlatformConfig, supabaseUrl: string): TenantBranding`
  - `getTenantBranding(): Promise<TenantBranding>` (server only, `react` `cache()`d)
  - `BrandingProvider({ value, children })`, `useBranding(): TenantBranding`, `BrandMark({ size }: { size?: "sm" | "lg" })`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { readPlatformConfig } from "./config";
import { brandingAssetUrl, brandingFromTenant } from "./branding";

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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/platform/branding.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/lib/platform/branding.ts`**

```ts
import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { readPlatformConfig, type PlatformConfig } from "./config";
import { lookupTenant } from "./tenant-lookup";
import { TENANT_HEADER_HOST } from "./tenant-routing";
import type { TenantRecord } from "./types";

export interface TenantBranding {
  displayName: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  /** Public /signup is only offered outside platform mode. */
  signupEnabled: boolean;
}

export function brandingAssetUrl(supabaseUrl: string, path: string | null, version: string): string | null {
  if (!path) return null;
  return `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/tenant-branding/${path}?v=${encodeURIComponent(version)}`;
}

export function brandingFromTenant(tenant: TenantRecord | null, cfg: PlatformConfig, supabaseUrl: string): TenantBranding {
  return {
    displayName: tenant?.displayName ?? cfg.platformName,
    logoUrl: tenant ? brandingAssetUrl(supabaseUrl, tenant.logoPath, tenant.brandingVersion) : null,
    faviconUrl: tenant ? brandingAssetUrl(supabaseUrl, tenant.faviconPath, tenant.brandingVersion) : null,
    signupEnabled: !cfg.enabled,
  };
}

/** Branding for the current request. The host header is trusted only
 *  because middleware strips and re-sets it (see tenant-routing.ts). */
export const getTenantBranding = cache(async (): Promise<TenantBranding> => {
  const cfg = readPlatformConfig();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const host = (await headers()).get(TENANT_HEADER_HOST);
  const tenant = host ? await lookupTenant(await createClient(), host) : null;
  return brandingFromTenant(tenant, cfg, supabaseUrl);
});
```
If `server-only` isn't installed (`ls node_modules/server-only`), drop that import line. Don't add a dependency for it. The vitest test imports this file, so `next/headers` and `@/lib/supabase/server` get loaded. If that import throws under vitest, move `getTenantBranding` into `src/lib/platform/branding-server.ts` and keep the pure helpers in `branding.ts`.

- [ ] **Step 4: Implement `src/lib/platform/branding-context.tsx`**

```tsx
"use client";

import { createContext, useContext, type ReactNode } from "react";
import { MessageSquare } from "lucide-react";
import type { TenantBranding } from "./branding";

const BrandingContext = createContext<TenantBranding>({
  displayName: "Stell Media CRM",
  logoUrl: null,
  faviconUrl: null,
  signupEnabled: true,
});

export function BrandingProvider({ value, children }: { value: TenantBranding; children: ReactNode }) {
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): TenantBranding {
  return useContext(BrandingContext);
}

/** Tenant logo, or the default chat mark on a primary tile. */
export function BrandMark({ size = "sm" }: { size?: "sm" | "lg" }) {
  const { logoUrl, displayName } = useBranding();
  const box = size === "lg" ? "h-12 w-12" : "h-8 w-8";
  if (logoUrl) {
    // Logos are often wide wordmarks (e.g. Stell Media's is ~3.6:1), so fix
    // the height and let the width follow, capped.
    const h = size === "lg" ? "h-12 max-w-[240px]" : "h-8 max-w-[180px]";
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary storage host, tiny image
    return <img src={logoUrl} alt={displayName} className={`${h} w-auto object-contain`} />;
  }
  return (
    <div className={`flex ${box} items-center justify-center rounded-lg bg-primary text-primary-foreground`}>
      <MessageSquare className={size === "lg" ? "h-6 w-6" : "h-4 w-4"} />
    </div>
  );
}
```
`branding-context.tsx` imports only the *type* from `branding.ts` (`import type`), so the server-only module never reaches the client bundle.

- [ ] **Step 5: Wire into layouts and components**

`src/app/layout.tsx`:
- Replace `export const metadata: Metadata = { title: {...}, ..., icons: {...}, ... }` with:
```ts
const BASE_METADATA: Metadata = { /* the existing object, minus title and icons */ };

export async function generateMetadata(): Promise<Metadata> {
  const branding = await getTenantBranding();
  return {
    ...BASE_METADATA,
    title: { default: branding.displayName, template: `%s — ${branding.displayName}` },
    icons: { icon: [{ url: branding.faviconUrl ?? "/icon" }] },
  };
}
```
- Keep `description` as is.
- In `RootLayout` (make it `async` if it isn't already), call `const branding = await getTenantBranding();` and wrap `{children}` with `<BrandingProvider value={branding}>…</BrandingProvider>` inside `ThemeProvider`.
- Imports: `getTenantBranding` from `@/lib/platform/branding`, `BrandingProvider` from `@/lib/platform/branding-context`.
- Before this, read `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-metadata.md` (or the nearest match via `ls node_modules/next/dist/docs/01-app/03-api-reference/04-functions/`). Confirm `headers()` is allowed in `generateMetadata` without `cacheComponents`.

`src/components/layout/sidebar.tsx` logo row: replace
```tsx
<div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
  <MessageSquare className="h-4 w-4" />
</div>
<span className="text-sm font-semibold text-foreground">
  {t("title")}
</span>
```
with
```tsx
<BrandMark />
{!branding.logoUrl && (
  <span className="truncate text-sm font-semibold text-foreground">
    {branding.displayName}
  </span>
)}
```
(A logo usually contains the name already, so the text label only shows with the fallback mark.)
- Add `const branding = useBranding();` next to `const t = useTranslations("Sidebar");`.
- Import `BrandMark, useBranding` from `@/lib/platform/branding-context`.
- Remove `MessageSquare` from the lucide import only if it's now unused.

`src/app/(auth)/login/page.tsx` and `signup/page.tsx`:
- Replace the `MessageSquare` icon tile in the card header with `<BrandMark size="lg" />`.
- Login: wrap the "Don't have an account? Create account" block in `{branding.signupEnabled && ( … )}` with `const branding = useBranding();`.
- Keep the invite variants (`UsersRound` icon) as they are.

- [ ] **Step 6: Verify**

Run: `npx vitest run && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/platform/branding.ts src/lib/platform/branding-context.tsx src/lib/platform/branding.test.ts src/app/layout.tsx src/components/layout/sidebar.tsx src/app/\(auth\)/login/page.tsx src/app/\(auth\)/signup/page.tsx
git commit -m "feat(platform): per-tenant name, logo and favicon"
```

---

### Task 7: Tenant-aware invite links and cross-tenant redeem guard

**Files:**
- Modify: `src/app/api/account/invitations/route.ts` (`getBaseUrl`, ~L94)
- Modify: `src/app/api/invitations/[token]/redeem/route.ts`
- Create: `src/lib/platform/admin-client.ts`
- Test: `src/app/api/invitations/[token]/redeem/route.test.ts`

**Interfaces:**
- Consumes: `TENANT_HEADER_HOST`, `TENANT_HEADER_ID`, `forgetProfileAccount`.
- Produces: `platformAdmin(): SupabaseClient` (service role, lazy singleton).

- [ ] **Step 1: Create `src/lib/platform/admin-client.ts`**

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Service-role client for platform code (admin panel, tenant status,
// cross-tenant guards). Same lazy pattern as src/lib/automations/admin-client.ts.
let _client: SupabaseClient | null = null;

export function platformAdmin(): SupabaseClient {
  if (!_client) {
    _client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _client;
}
```

- [ ] **Step 2: Write the failing redeem test**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const getUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser }, rpc }),
}));
let invitationAccount: string | null = "acc-a";
vi.mock("@/lib/platform/admin-client", () => ({
  platformAdmin: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: invitationAccount ? { account_id: invitationAccount } : null, error: null }) }) }) }),
  }),
}));
const { POST } = await import("./route");
const { __resetRateLimitForTests } = await import("@/lib/rate-limit");

function call(headers: Record<string, string> = {}) {
  return POST(new Request("https://b.crm.stellmedia.com/api/invitations/tok/redeem", { method: "POST", headers }), {
    params: Promise.resolve({ token: "tok" }),
  });
}

beforeEach(() => {
  __resetRateLimitForTests();
  invitationAccount = "acc-a";
  getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
  rpc.mockResolvedValue({ data: "acc-a", error: null });
});

describe("redeem on a tenant host", () => {
  it("rejects an invite that belongs to a different tenant", async () => {
    const res = await call({ "x-tenant-id": "acc-b" });
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("redeems when the invite matches the tenant", async () => {
    const res = await call({ "x-tenant-id": "acc-a" });
    expect(res.status).toBe(200);
  });
  it("is unchanged outside platform mode (no tenant header)", async () => {
    const res = await call();
    expect(res.status).toBe(200);
  });
});
```
If `__resetRateLimitForTests` isn't exported from `@/lib/rate-limit`, check `src/lib/rate-limit.ts` for the actual export used by `src/lib/auth/api-context.test.ts` and use that.

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run "src/app/api/invitations/[token]/redeem/route.test.ts"`
Expected: first test FAILS (returns 200).

- [ ] **Step 4: Implement**

In `redeem/route.ts`, after the `if (!user)` block and before the RPC:
```ts
  // White-label: an invite to client A must not be redeemable on client
  // B's host. x-tenant-id is trustworthy — middleware strips/sets it.
  const tenantId = request.headers.get(TENANT_HEADER_ID);
  if (tenantId) {
    const { data: inv } = await platformAdmin()
      .from("account_invitations")
      .select("account_id")
      .eq("token_hash", hashInviteToken(token))
      .maybeSingle();
    if (inv && inv.account_id !== tenantId) {
      return NextResponse.json({ error: "This invitation belongs to a different workspace." }, { status: 403 });
    }
  }
```
After a successful RPC (before `return NextResponse.json({ ok: true, accountId })`): `forgetProfileAccount(user.id);`. Imports: `TENANT_HEADER_ID` from `@/lib/platform/tenant-routing`, `platformAdmin` from `@/lib/platform/admin-client`, `forgetProfileAccount` from `@/lib/platform/tenant-lookup`.

In `invitations/route.ts` `getBaseUrl`, insert at the top of the function:
```ts
  // White-label: on a tenant host, invite links must point at that
  // tenant's own address. The header is only present when middleware
  // matched this host to the caller's tenant.
  if (request.headers.get(TENANT_HEADER_HOST)) {
    const h =
      request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
      request.headers.get("host")?.trim();
    const proto =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
      new URL(request.url).protocol.replace(":", "");
    if (h) return `${proto}://${h}`;
  }
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/platform/admin-client.ts "src/app/api/invitations/[token]/redeem" src/app/api/account/invitations/route.ts
git commit -m "feat(platform): tenant-scoped invite links and redeem guard"
```

---

### Task 8: Soft-suspend enforcement on server paths

**Files:**
- Create: `src/lib/platform/tenant-status.ts`
- Test: `src/lib/platform/tenant-status.test.ts`
- Modify:
  - `src/lib/auth/api-context.ts` (after `row` resolves, ~L95)
  - `src/lib/auth/api-context.test.ts` (mock `@/lib/platform/tenant-status`)
  - `src/lib/whatsapp/send-message.ts` (~L272)
  - `src/lib/whatsapp/broadcast-core.ts` (~L124)
  - `src/lib/whatsapp/broadcast-resume.ts` (~L240)
  - `src/lib/flows/meta-send.ts` (`loadAccountMetaCredentials`, ~L41)
  - `src/lib/automations/meta-send.ts` (~L156)
  - `src/app/api/whatsapp/webhook/route.ts` (before the flow/automation/AI dispatch, ~L860)

**Interfaces:**
- Consumes: `platformAdmin()`, `TtlCache`.
- Produces:
  - `class TenantSuspendedError extends Error { code = "workspace_suspended" }`
  - `isTenantActive(accountId: string, db?: StatusClient): Promise<boolean>` — true when no `tenant_settings` row; cached 30s; **fails open** (returns true) on a lookup error so a DB blip can't take every tenant down; logs the error.
  - `assertTenantActive(accountId: string, db?: StatusClient): Promise<void>` — throws `TenantSuspendedError`.
  - `__resetTenantStatusCacheForTests(): void`

- [ ] **Step 1: Write the failing tests**

```ts
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
```

Add to `src/lib/auth/api-context.test.ts`:
```ts
let tenantActive = true;
vi.mock("@/lib/platform/tenant-status", () => ({ isTenantActive: async () => tenantActive }));
// in beforeEach: tenantActive = true;
it("rejects keys of a suspended workspace with 403", async () => {
  tenantActive = false;
  findActiveKeyByHash.mockResolvedValue(row());
  await expectApiError(requireApiKey(reqWith(`Bearer ${KEY}`)), "forbidden", 403);
});
```
Match the existing test's helper names (`row`, `reqWith`, `expectApiError`, `KEY`). Read the file and put the new `it` in the describe block that covers successful key resolution.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/platform/tenant-status.test.ts src/lib/auth/api-context.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/lib/platform/tenant-status.ts`**

```ts
// Soft-suspend gate for server-side paths that don't pass through a
// tenant host (public API keys, webhook-driven engines, broadcast resume).
// Fails OPEN on lookup errors: a DB blip must not silence every client.

import { platformAdmin } from "./admin-client";
import { TtlCache } from "./ttl-cache";

export class TenantSuspendedError extends Error {
  readonly code = "workspace_suspended";
  constructor() {
    super("This workspace is suspended. Contact your service provider.");
    this.name = "TenantSuspendedError";
  }
}

export interface StatusClient {
  from(table: "tenant_settings"): {
    select(cols: string): {
      eq(col: string, v: string): {
        maybeSingle(): PromiseLike<{ data: { status: string } | null; error: unknown }>;
      };
    };
  };
}

const cache = new TtlCache<boolean>(30_000);

export async function isTenantActive(accountId: string, db?: StatusClient): Promise<boolean> {
  const hit = cache.get(accountId);
  if (hit !== undefined) return hit;
  const client = db ?? (platformAdmin() as unknown as StatusClient);
  const { data, error } = await client.from("tenant_settings").select("status").eq("account_id", accountId).maybeSingle();
  if (error) {
    console.error("[platform] tenant status lookup failed:", error);
    return true;
  }
  const active = !data || data.status !== "suspended";
  cache.set(accountId, active);
  return active;
}

export async function assertTenantActive(accountId: string, db?: StatusClient): Promise<void> {
  if (!(await isTenantActive(accountId, db))) throw new TenantSuspendedError();
}

export function __resetTenantStatusCacheForTests(): void {
  cache.clear();
}
```

- [ ] **Step 4: Wire the call sites**

- `src/lib/auth/api-context.ts`: right after the `if (!row) { … throw unauthorized(); }` block:
  ```ts
  if (!(await isTenantActive(row.account_id))) {
    throw forbidden('This workspace is suspended. Contact your service provider.');
  }
  ```
- `send-message.ts`: just before `const accessToken = decrypt(config.access_token);` add
  ```ts
  if (!(await isTenantActive(accountId))) {
    throw new SendMessageError('workspace_suspended', 'This workspace is suspended.', 403);
  }
  ```
  Check the `SendMessageError` constructor's first-arg type. If it's a closed union, add `'workspace_suspended'` to it.
- `broadcast-core.ts`: same spot, the same pattern with `BroadcastError('workspace_suspended', 'This workspace is suspended.', 403)`, extending its code union if needed.
- `broadcast-resume.ts` (~L240), `flows/meta-send.ts` `loadAccountMetaCredentials`, `automations/meta-send.ts` (~L156): `await assertTenantActive(accountId)` before the decrypt. Use the variable name in scope there (`input.accountId` in automations).
- `webhook/route.ts`: find the function where `dispatchInboundToFlows` is called (~L879) and the account id in scope. Insert this immediately before the flow dispatch block:
  ```ts
  // White-label soft suspend: keep storing inbound messages, but don't
  // run bots/automations or call Meta on a suspended workspace's behalf.
  if (!(await isTenantActive(accountId))) return
  ```
  Use the actual in-scope variable. Confirm by reading ~40 lines above. Make sure `dispatchWebhookEvent` (outbound customer webhooks) also sits after this early return, or is skipped. Read the function before inserting.
- Finally run `grep -rn "decrypt(config.access_token)" src --include=*.ts | grep -v test`. Every hit must be in either (a) a dashboard `/api/whatsapp/*` route, which middleware already 403s for suspended tenants, or (b) a file patched above. List the hits in the task report.

- [ ] **Step 5: Run everything**

Run: `npx vitest run && npm run typecheck`
Expected: PASS. Existing send/broadcast tests may need `vi.mock("@/lib/platform/tenant-status", () => ({ isTenantActive: async () => true, assertTenantActive: async () => {} }))` added. Add it in each failing test file rather than weakening the implementation.

- [ ] **Step 6: Commit**

```bash
git add -A src/lib src/app/api/whatsapp/webhook/route.ts
git reset -q changeAbout.txt 2>/dev/null; git status --short
git commit -m "feat(platform): soft-suspend gate on API keys and outbound sends"
```

---

### Task 9: Platform-admin guard

**Files:**
- Create: `src/lib/platform/guard.ts`
- Test: `src/lib/platform/guard.test.ts`

**Interfaces:**
- Consumes: `readPlatformConfig`, `requestHostname`, `platformAdmin`, `createClient` (`@/lib/supabase/server`).
- Produces: `requirePlatformAdmin(): Promise<{ userId: string; email: string | null }>`. Calls `notFound()` when ADMIN_HOSTNAME is unset, the host isn't the admin host, or the user isn't in `platform_admins`. Calls `redirect('/login')` when signed out.

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

let host = "admin.crm.stellmedia.com";
let user: { id: string; email: string } | null = { id: "u1", email: "a@b.c" };
let isAdmin = true;

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host }) }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (p: string) => { throw new Error(`REDIRECT:${p}`); },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) } }) }));
vi.mock("@/lib/platform/admin-client", () => ({
  platformAdmin: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: isAdmin ? { user_id: "u1" } : null, error: null }) }) }) }) }),
}));

const { requirePlatformAdmin } = await import("./guard");

beforeEach(() => {
  process.env.ADMIN_HOSTNAME = "admin.crm.stellmedia.com";
  host = "admin.crm.stellmedia.com";
  user = { id: "u1", email: "a@b.c" };
  isAdmin = true;
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
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/platform/guard.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { platformAdmin } from "./admin-client";
import { readPlatformConfig } from "./config";
import { requestHostname } from "./hostname";

/** Gate for every admin page AND every admin server action. 404 (not
 *  403) so the admin panel's existence isn't advertised on client hosts. */
export async function requirePlatformAdmin(): Promise<{ userId: string; email: string | null }> {
  const cfg = readPlatformConfig();
  const host = requestHostname(await headers());
  if (!cfg.adminHostname || host !== cfg.adminHostname) notFound();

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data } = await platformAdmin().from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (!data) notFound();

  return { userId: user.id, email: user.email ?? null };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/platform/guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/platform/guard.ts src/lib/platform/guard.test.ts
git commit -m "feat(platform): requirePlatformAdmin guard"
```

---

### Task 10: Validation and tenant provisioning service

**Files:**
- Create: `src/lib/platform/validation.ts`, `src/lib/platform/tenants.ts`
- Test: `src/lib/platform/validation.test.ts`

**Interfaces:**
- Consumes: `platformAdmin`, `readPlatformConfig`, `tenantSubdomainHost`, `tenantOrigin`, `normalizeHostname`.
- Produces:
  - `validateSlug(raw: string): { ok: true; slug: string } | { ok: false; error: string }`
  - `validateBrandingFile(file: File | null, kind: "logo" | "favicon"): { ok: true; file: File | null; ext: string | null } | { ok: false; error: string }` (null/empty file ⇒ ok with nulls)
  - `validateCustomDomain(raw: string, baseDomain: string | null): { ok: true; hostname: string } | { ok: false; error: string }` (rejects hosts under `baseDomain` and the admin host)
  - `validateEmail(raw: string): { ok: true; email: string } | { ok: false; error: string }`
  - In `tenants.ts`:
    - `interface TenantListRow { accountId: string; name: string; slug: string | null; status: "active" | "suspended" | "incomplete"; domains: string[]; memberCount: number; whatsappConnected: boolean; createdAt: string }`
    - `listTenants(): Promise<TenantListRow[]>`
    - `getTenantDetail(accountId: string): Promise<{ row: TenantListRow; logoPath: string | null; faviconPath: string | null; ownerEmail: string | null; domains: { id: string; hostname: string; kind: string }[] } | null>`
    - `createTenant(input: { companyName: string; slug: string; ownerEmail: string; ownerName: string; logo: File | null; favicon: File | null }): Promise<{ accountId: string }>`
    - `completeTenantSetup(accountId: string, input: { companyName: string; slug: string; logo: File | null; favicon: File | null }): Promise<void>` (idempotent)
    - `updateTenantBranding(accountId: string, input: { companyName: string; logo: File | null; favicon: File | null }): Promise<void>`
    - `setTenantStatus(accountId: string, status: "active" | "suspended"): Promise<void>`
    - `addTenantDomain(accountId: string, hostname: string): Promise<void>`
    - `removeTenantDomain(domainId: string): Promise<void>` (refuses to remove the last subdomain row)
    - `resendOwnerInvite(accountId: string): Promise<void>`
    - `listPlatformAdmins(): Promise<{ userId: string; email: string | null; createdAt: string }[]>`
    - `addPlatformAdmin(email: string): Promise<void>`
    - `removePlatformAdmin(actorUserId: string, userId: string): Promise<void>` (refuses self and last)
    - `writeAudit(actorUserId: string, action: string, accountId: string | null, details?: Record<string, unknown>): Promise<void>`
    - `listAudit(limit?: number): Promise<{ id: string; action: string; accountId: string | null; actorEmail: string | null; details: Record<string, unknown>; createdAt: string }[]>`
    - `class PlatformError extends Error` (user-facing message)

- [ ] **Step 1: Write the failing validation tests**

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/platform/validation.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `validation.ts`**

```ts
import { normalizeHostname } from "./hostname";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;
const RESERVED = new Set(["admin", "www", "app", "api"]);

export function validateSlug(raw: string) {
  const slug = raw.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    return { ok: false as const, error: "Use 2–40 lowercase letters, numbers or hyphens (not at the start or end)." };
  }
  if (RESERVED.has(slug)) return { ok: false as const, error: `"${slug}" is reserved.` };
  return { ok: true as const, slug };
}

const FILE_RULES = {
  logo: { max: 512 * 1024, types: { "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg" } as Record<string, string> },
  favicon: { max: 128 * 1024, types: { "image/png": "png", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico" } as Record<string, string> },
};

export function validateBrandingFile(file: File | null, kind: "logo" | "favicon") {
  if (!file || file.size === 0) return { ok: true as const, file: null, ext: null };
  const rule = FILE_RULES[kind];
  const ext = rule.types[file.type];
  if (!ext) return { ok: false as const, error: `${kind === "logo" ? "Logo" : "Favicon"} must be ${kind === "logo" ? "PNG, WebP or JPEG" : "PNG or ICO"}.` };
  if (file.size > rule.max) return { ok: false as const, error: `${kind === "logo" ? "Logo" : "Favicon"} must be at most ${rule.max / 1024} KB.` };
  return { ok: true as const, file, ext };
}

export function validateCustomDomain(raw: string, baseDomain: string | null) {
  const trimmed = raw.trim();
  if (trimmed.includes("/") || trimmed.includes(":")) return { ok: false as const, error: "Enter a bare hostname like crm.acme.com." };
  const hostname = normalizeHostname(trimmed);
  if (!hostname || !hostname.includes(".")) return { ok: false as const, error: "Enter a bare hostname like crm.acme.com." };
  if (baseDomain && (hostname === baseDomain || hostname.endsWith(`.${baseDomain}`))) {
    return { ok: false as const, error: "Subdomains of the platform domain are managed automatically." };
  }
  return { ok: true as const, hostname };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function validateEmail(raw: string) {
  const email = raw.trim().toLowerCase();
  return EMAIL_RE.test(email) ? { ok: true as const, email } : { ok: false as const, error: "Enter a valid email address." };
}
```
The slug regex requires length ≥ 2, so `"a"` fails. `"a1"` passes.

- [ ] **Step 4: Run validation tests**

Run: `npx vitest run src/lib/platform/validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `tenants.ts`** (service role; server-only usage)

```ts
// Tenant provisioning and admin data access. Service role throughout —
// every exported function is only reachable via actions.ts, which calls
// requirePlatformAdmin() first.

import { platformAdmin } from "./admin-client";
import { readPlatformConfig, tenantOrigin, tenantSubdomainHost } from "./config";

export class PlatformError extends Error {}

export interface TenantListRow {
  accountId: string;
  name: string;
  slug: string | null;
  status: "active" | "suspended" | "incomplete";
  domains: string[];
  memberCount: number;
  whatsappConnected: boolean;
  createdAt: string;
}

const db = () => platformAdmin();

export async function writeAudit(actorUserId: string, action: string, accountId: string | null, details: Record<string, unknown> = {}) {
  const { error } = await db().from("platform_audit_log").insert({ actor_user_id: actorUserId, action, account_id: accountId, details });
  if (error) console.error("[platform] audit write failed:", error.message);
}

export async function listTenants(): Promise<TenantListRow[]> {
  const [accounts, settings, domains, profiles, configs] = await Promise.all([
    db().from("accounts").select("id, name, created_at").order("created_at", { ascending: false }),
    db().from("tenant_settings").select("account_id, slug, status"),
    db().from("tenant_domains").select("account_id, hostname"),
    db().from("profiles").select("account_id"),
    db().from("whatsapp_config").select("account_id"),
  ]);
  for (const r of [accounts, settings, domains, profiles, configs]) if (r.error) throw new Error(r.error.message);

  const settingsBy = new Map((settings.data ?? []).map((s) => [s.account_id as string, s]));
  return (accounts.data ?? []).map((a) => {
    const s = settingsBy.get(a.id);
    return {
      accountId: a.id,
      name: a.name,
      slug: (s?.slug as string) ?? null,
      status: s ? (s.status as "active" | "suspended") : "incomplete",
      domains: (domains.data ?? []).filter((d) => d.account_id === a.id).map((d) => d.hostname as string),
      memberCount: (profiles.data ?? []).filter((p) => p.account_id === a.id).length,
      whatsappConnected: (configs.data ?? []).some((c) => c.account_id === a.id),
      createdAt: a.created_at,
    };
  });
}
```
At 1–10 clients, whole-table reads are fine. Note it in a comment: `// Fine at tens of tenants; paginate if this grows past a few hundred.`

The remaining functions:

```ts
async function uploadBranding(accountId: string, kind: "logo" | "favicon", file: File, ext: string): Promise<string> {
  const path = `${accountId}/${kind}.${ext}`;
  const { error } = await db().storage.from("tenant-branding").upload(path, file, { upsert: true, contentType: file.type });
  if (error) throw new PlatformError(`Could not upload ${kind}: ${error.message}`);
  return path;
}

async function findUserIdByEmail(email: string): Promise<string | null> {
  // profiles.email is filled by handle_new_user; avoids paging auth.admin.listUsers.
  const { data } = await db().from("profiles").select("user_id").eq("email", email).maybeSingle();
  return (data?.user_id as string) ?? null;
}

export async function completeTenantSetup(
  accountId: string,
  input: { companyName: string; slug: string; logo: { file: File; ext: string } | null; favicon: { file: File; ext: string } | null },
): Promise<void> {
  const cfg = readPlatformConfig();
  const { error: nameErr } = await db().from("accounts").update({ name: input.companyName }).eq("id", accountId);
  if (nameErr) throw new PlatformError(nameErr.message);

  const { data: existingSlug } = await db().from("tenant_settings").select("account_id").eq("slug", input.slug).maybeSingle();
  if (existingSlug && existingSlug.account_id !== accountId) throw new PlatformError(`The address "${input.slug}" is already taken.`);

  const patch: Record<string, unknown> = { account_id: accountId, slug: input.slug };
  if (input.logo) patch.logo_path = await uploadBranding(accountId, "logo", input.logo.file, input.logo.ext);
  if (input.favicon) patch.favicon_path = await uploadBranding(accountId, "favicon", input.favicon.file, input.favicon.ext);
  const { error: setErr } = await db().from("tenant_settings").upsert(patch, { onConflict: "account_id" });
  if (setErr) throw new PlatformError(setErr.message);

  const hostname = tenantSubdomainHost(cfg, input.slug);
  const { error: domErr } = await db().from("tenant_domains").upsert(
    { account_id: accountId, hostname, kind: "subdomain", verified_at: new Date().toISOString() },
    { onConflict: "hostname", ignoreDuplicates: true },
  );
  if (domErr) throw new PlatformError(domErr.message);
}

export async function createTenant(input: {
  companyName: string; slug: string; ownerEmail: string; ownerName: string;
  logo: { file: File; ext: string } | null; favicon: { file: File; ext: string } | null;
}): Promise<{ accountId: string }> {
  const cfg = readPlatformConfig();
  if (await findUserIdByEmail(input.ownerEmail)) {
    throw new PlatformError("A user with this email already exists. Each person can belong to only one client.");
  }
  const { data: taken } = await db().from("tenant_settings").select("account_id").eq("slug", input.slug).maybeSingle();
  if (taken) throw new PlatformError(`The address "${input.slug}" is already taken.`);

  const redirectTo = `${tenantOrigin(cfg, input.slug)}/auth/callback?next=/reset-password`;
  const { data, error } = await db().auth.admin.inviteUserByEmail(input.ownerEmail, {
    data: { full_name: input.ownerName },
    redirectTo,
  });
  if (error || !data.user) throw new PlatformError(`Invite failed: ${error?.message ?? "no user returned"}`);

  // handle_new_user (017) has created the owner's account + profile.
  const { data: acct } = await db().from("accounts").select("id").eq("owner_user_id", data.user.id).maybeSingle();
  if (!acct) throw new PlatformError("Owner invited, but their account was not created. Check the handle_new_user trigger.");

  await completeTenantSetup(acct.id, { companyName: input.companyName, slug: input.slug, logo: input.logo, favicon: input.favicon });
  return { accountId: acct.id };
}
```

Write the rest in the same style:
- `getTenantDetail`: use `listTenants()` and find the row. Read `tenant_settings` logo/favicon paths. Read `tenant_domains` (`id, hostname, kind`) for the account. Read the owner email via `accounts.owner_user_id` → `profiles.email`.
- `updateTenantBranding`: update `accounts.name`; if files are given, upload and update `tenant_settings` paths. Always `update({ updated_at: new Date().toISOString() })` too so the branding version busts the cache.
- `setTenantStatus`: `update({ status, suspended_at: status === 'suspended' ? now : null })`.
- `addTenantDomain`: insert `{ account_id, hostname, kind: 'custom' }`. Map unique violation `23505` → `PlatformError("That domain is already in use.")`.
- `removeTenantDomain`: load the row. If `kind === 'subdomain'` and it's the only subdomain row for the account → `PlatformError`. Otherwise delete.
- `resendOwnerInvite`: owner email via `accounts.owner_user_id` → `profiles.email`. If the owner has never signed in (`auth.admin.getUserById(id).data.user.last_sign_in_at` null), call `inviteUserByEmail` again with the same `redirectTo` from the tenant slug. Otherwise `PlatformError("The owner has already activated their account.")`.
- `listPlatformAdmins`: join `platform_admins.user_id` → `profiles.email`.
- `addPlatformAdmin(email)`: `findUserIdByEmail`, then `PlatformError` if missing, insert with `onConflict` ignore.
- `removePlatformAdmin(actor, userId)`: refuse if `actor === userId` or the count is ≤ 1.
- `listAudit(limit = 200)`: select ordered desc, then map `actor_user_id` → profile email.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck && npx vitest run src/lib/platform/`
Expected: PASS.

```bash
git add src/lib/platform/validation.ts src/lib/platform/validation.test.ts src/lib/platform/tenants.ts
git commit -m "feat(platform): tenant provisioning and admin data access"
```

---

### Task 11: Admin server actions and UI

**Files:**
- Create: `src/lib/platform/actions.ts`
- Create: `src/app/(admin)/admin/layout.tsx`, `page.tsx`, `clients/new/page.tsx`, `clients/new/new-client-form.tsx`, `clients/[accountId]/page.tsx`, `clients/[accountId]/client-forms.tsx`, `admins/page.tsx`, `audit/page.tsx`

**Interfaces:**
- Consumes: `requirePlatformAdmin`, all of `tenants.ts`, `validation.ts`, `readPlatformConfig`.
- Produces: `type ActionState = { error: string | null; ok?: boolean }` and server actions with signature `(prev: ActionState, formData: FormData) => Promise<ActionState>`:
  - `createClientAction`
  - `completeSetupAction`
  - `updateBrandingAction`
  - `setStatusAction`
  - `addDomainAction`
  - `removeDomainAction`
  - `resendInviteAction`
  - `addAdminAction`
  - `removeAdminAction`

- [ ] **Step 1: Read the Next 16 docs** for server actions and forms: `ls node_modules/next/dist/docs/01-app/02-guides/ | grep -i -E "form|action|mutat"`, and read the matching file. Confirm `useActionState` + `<form action>` usage and the `serverActions.bodySizeLimit` default (1 MB is enough for 512 KB + 128 KB).

- [ ] **Step 2: Implement `src/lib/platform/actions.ts`**

```ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "./guard";
import { readPlatformConfig } from "./config";
import * as tenants from "./tenants";
import { validateBrandingFile, validateCustomDomain, validateEmail, validateSlug } from "./validation";

export type ActionState = { error: string | null; ok?: boolean };

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
}
function file(fd: FormData, key: string): File | null {
  const v = fd.get(key);
  return v instanceof File ? v : null;
}
function brandingInputs(fd: FormData): { error: string } | { logo: { file: File; ext: string } | null; favicon: { file: File; ext: string } | null } {
  const logo = validateBrandingFile(file(fd, "logo"), "logo");
  if (!logo.ok) return { error: logo.error };
  const fav = validateBrandingFile(file(fd, "favicon"), "favicon");
  if (!fav.ok) return { error: fav.error };
  return {
    logo: logo.file && logo.ext ? { file: logo.file, ext: logo.ext } : null,
    favicon: fav.file && fav.ext ? { file: fav.file, ext: fav.ext } : null,
  };
}
async function run(fn: () => Promise<void>): Promise<ActionState> {
  try {
    await fn();
    return { error: null, ok: true };
  } catch (e) {
    if (e instanceof tenants.PlatformError) return { error: e.message };
    throw e; // includes next/navigation redirect/notFound signals
  }
}

export async function createClientAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requirePlatformAdmin();
  const companyName = str(fd, "companyName").trim();
  if (!companyName) return { error: "Company name is required." };
  const slug = validateSlug(str(fd, "slug"));
  if (!slug.ok) return { error: slug.error };
  const email = validateEmail(str(fd, "ownerEmail"));
  if (!email.ok) return { error: email.error };
  const files = brandingInputs(fd);
  if ("error" in files) return { error: files.error };

  let accountId = "";
  const res = await run(async () => {
    ({ accountId } = await tenants.createTenant({
      companyName, slug: slug.slug, ownerEmail: email.email, ownerName: str(fd, "ownerName").trim(), ...files,
    }));
    await tenants.writeAudit(admin.userId, "tenant.create", accountId, { slug: slug.slug, ownerEmail: email.email });
  });
  if (res.error) return res;
  revalidatePath("/admin");
  redirect(`/admin/clients/${accountId}`);
}
```
Write the other actions with the same shape. Each one:
1. calls `requirePlatformAdmin()` first
2. validates inputs with `validation.ts`
3. wraps the `tenants.*` call plus `writeAudit` in `run()`
4. calls `revalidatePath` on `/admin` and `/admin/clients/<id>`

Specifics:
- `completeSetupAction` reads `accountId`, `companyName`, `slug` and the files → `tenants.completeTenantSetup`. Audit `tenant.complete_setup`.
- `updateBrandingAction` → `updateTenantBranding`. Audit `tenant.update_branding`.
- `setStatusAction` reads `status` (must be `active` or `suspended`, else error). Audit `tenant.suspend` or `tenant.reactivate`.
- `addDomainAction` → `validateCustomDomain(str(fd,"hostname"), readPlatformConfig().baseDomain)`. Audit `tenant.domain_add`.
- `removeDomainAction` → audit `tenant.domain_remove`.
- `resendInviteAction` → audit `tenant.resend_invite`.
- `addAdminAction` / `removeAdminAction` → audit `platform.admin_add` / `platform.admin_remove` with `accountId: null`.

- [ ] **Step 3: Admin layout `src/app/(admin)/admin/layout.tsx`**

```tsx
import Link from "next/link";
import type { Metadata } from "next";
import { requirePlatformAdmin } from "@/lib/platform/guard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requirePlatformAdmin();
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <span className="text-sm font-semibold text-foreground">Platform admin</span>
          <nav className="flex gap-4 text-sm text-muted-foreground">
            <Link href="/admin" className="hover:text-foreground">Clients</Link>
            <Link href="/admin/admins" className="hover:text-foreground">Admins</Link>
            <Link href="/admin/audit" className="hover:text-foreground">Audit log</Link>
          </nav>
          <span className="ml-auto text-xs text-muted-foreground">{admin.email}</span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
```
The admin UI is English-only (internal tool). Don't add i18n keys for it.

- [ ] **Step 4: Clients list `page.tsx`**

A server component:
- calls `requirePlatformAdmin()` (defence in depth; layouts don't protect server actions) and `listTenants()`
- renders `src/components/ui/table.tsx` with these columns: Name (link to `/admin/clients/<id>`), Address (first domain), Status, Members, WhatsApp (Connected/—), Created (`date-fns` `format(…, "yyyy-MM-dd")`)
- renders `<Badge>` from `src/components/ui/badge.tsx` for the status
- shows "Complete setup" for `incomplete` rows
- has a "New client" `Button` linking to `/admin/clients/new`

Read `table.tsx` / `badge.tsx` / `button.tsx` exports before using them.

- [ ] **Step 5: New client form**

`clients/new/page.tsx` renders `<NewClientForm baseDomain={readPlatformConfig().baseDomain} />`.

`new-client-form.tsx`:
- a `"use client"` component using `useActionState(createClientAction, { error: null })`
- a `<form action={formAction}>` with `Input`/`Label` fields:
  - `companyName`
  - `slug`, with a live preview `{slug}.{baseDomain}`
  - `ownerName`
  - `ownerEmail`
  - `logo` (`type="file" accept="image/png,image/webp,image/jpeg"`)
  - `favicon` (`accept="image/png,image/x-icon"`)
- a submit `Button` disabled while `isPending`
- the error rendered in `Alert` when `state.error`
- auto-suggest the slug from the company name (lowercase, non-alnum → `-`, trimmed) until the user edits the slug field

- [ ] **Step 6: Client detail page + forms**

`clients/[accountId]/page.tsx` (server): `const { accountId } = await params;` (params is a Promise in Next 16), then `getTenantDetail`, then `notFound()` if null. Sections:
1. Header: name, status badge, primary address link (`https://<first subdomain>`), owner email.
2. If `status === "incomplete"`: a `CompleteSetupForm`. Otherwise a `BrandingForm` with current logo/favicon previews, via `brandingAssetUrl(process.env.NEXT_PUBLIC_SUPABASE_URL!, path, Date.now().toString())`.
3. Domains: a list with a remove button per row (`RemoveDomainForm`, hidden input `domainId`), plus `AddDomainForm`. Under the add form, show static instructions:
   - "Point a CNAME for this hostname at `<baseDomain>` (or an A record at the server IP)."
   - "In Nginx Proxy Manager add a Proxy Host for it → app container, and request a Let's Encrypt certificate."
   - "Add `https://<hostname>/**` to Supabase → Authentication → URL Configuration → Redirect URLs."
4. Owner invite: a `ResendInviteForm`.
5. Danger zone: a `StatusForm`, a suspend/reactivate button with `confirm()` in `onClick` (the client form calls `e.preventDefault()` if not confirmed).

`client-forms.tsx` (`"use client"`): one small component per action, all using `useActionState` and showing `state.error` / a "Saved" note on `state.ok`. Each includes `<input type="hidden" name="accountId" value={accountId} />`.

- [ ] **Step 7: Admins and audit pages**

`admins/page.tsx`: lists `listPlatformAdmins()`, with an add-by-email form (`addAdminAction`) and remove buttons (`removeAdminAction`, hidden `userId`). Put the client components in `admins/admin-forms.tsx`.

`audit/page.tsx`: a table of `listAudit()` with time, actor email, action, client account id (link to the client page), and details (`JSON.stringify`, truncated in a `<code>`).

- [ ] **Step 8: Verify build-level correctness**

Run: `npm run typecheck && npm run lint && npx vitest run && npm run build`
Expected: all succeed. `npm run build` needs the env vars from `.env.local`. If they're missing, report it rather than faking them.

- [ ] **Step 9: Commit**

```bash
git add src/lib/platform/actions.ts "src/app/(admin)"
git commit -m "feat(platform): super-admin panel for clients, admins and audit log"
```

---

### Task 12: Ops docs, env example, default theme

**Files:**
- Create: `docs/white-label.md`
- Modify: `.env.local.example` (new "WHITE-LABEL PLATFORM (optional)" section)
- Modify (only if the user supplies brand colours): `src/app/globals.css` violet tokens, `src/app/icon.tsx` background colour

- [ ] **Step 1: Apply the Stell Media palette** (user-supplied: primary `#4d2971`).
In `src/app/globals.css`, update the `html[data-theme="violet"]` token blocks (read the file to find every block — light and dark mode variants):
  - Light mode: `--primary: #4d2971`, `--primary-hover` a ~8% darker shade (`#43235f`), `--primary-soft` / `--primary-soft-2` light tints of the same hue (e.g. `#f1ebf7` / `#e4d8ef`), `--primary-foreground: #ffffff`, and `--ring` / `--sidebar-primary` if they reference the old violet.
  - Dark mode: `#4d2971` is too dark to read as text/accents on the dark background — use a lighter tint of the same hue for `--primary` (start at `#9f74d1`, adjust until text-on-background contrast ≥ 4.5:1 and `--primary-foreground` on `--primary` ≥ 4.5:1; compute with the WCAG relative-luminance formula in a quick `node -e` script and paste the ratios in the report).
  - Keep the theme id `violet` (no rename — upstream compatibility; the picker label may stay).
  - `src/app/icon.tsx`: background `#4d2971`.
- [ ] **Step 2: Add the env section** to `.env.local.example`:

```env
# ============================================================
# WHITE-LABEL PLATFORM (optional) — see docs/white-label.md
# ============================================================
# Setting either of the first two turns platform mode on: every host
# must be a registered client domain, public sign-up is disabled, and
# /admin is served on ADMIN_HOSTNAME only.
# PLATFORM_BASE_DOMAIN=crm.stellmedia.com
# ADMIN_HOSTNAME=admin.crm.stellmedia.com
# Name shown on the admin host and when no client matches.
# PLATFORM_NAME=Stell Media CRM
# Local dev only:
# PLATFORM_DEFAULT_TENANT_HOST=stellmedia.localhost
# PLATFORM_TENANT_ORIGIN_TEMPLATE=http://{slug}.localhost:3000
```

- [ ] **Step 3: Write `docs/white-label.md`** with these sections, using the concrete values:
1. **What platform mode does** (one paragraph).
2. **DNS:** `*.crm.stellmedia.com` and `admin.crm.stellmedia.com` A records → VPS IP.
3. **Nginx Proxy Manager:**
   - one proxy host for `*.crm.stellmedia.com` and `admin.crm.stellmedia.com` → the app container (`http://<container>:3000`)
   - SSL → "Request a new certificate" with "Use a DNS Challenge" (wildcards need it) and your DNS provider's API credentials
   - "Force SSL" on
   - custom client domains: one proxy host each with a normal HTTP-challenge certificate
   - NPM forwards `Host` by default; don't override it
4. **Supabase Auth:**
   - Redirect URLs: add `https://*.crm.stellmedia.com/**` and `https://admin.crm.stellmedia.com/**`, plus each custom domain
   - set the **Invite user** email template link to `<a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=invite">Accept invitation</a>`. Why: admin-created invites carry no PKCE verifier, and `redirectTo` already contains `?next=`, which is why `&` is correct.
   - set the **Reset password** template to `<a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=recovery">Reset password</a>` so resets return to the client's own domain
5. **Env vars** (copy from Step 2).
6. **Migration:**
   - apply `supabase/migrations/100_platform_tenancy.sql`
   - it makes `ai.dev@stellmedia.com` a platform admin and Stell Media client `stellmedia`
   - **add your current production hostname** so existing users keep working:
     ```sql
     INSERT INTO tenant_domains (account_id, hostname, kind, verified_at)
     SELECT account_id, '<current-host>', 'custom', NOW() FROM tenant_settings WHERE slug = 'stellmedia'
     ON CONFLICT DO NOTHING;
     ```
7. **Onboarding a client:** the admin panel steps.
8. **Suspension:** what stops and what keeps working.
9. **Local development:**
   - `*.localhost` resolves to 127.0.0.1 in Chrome/Firefox
   - env from Step 2
   - add `http://*.localhost:3000/**` to the local auth redirect list
10. **Known limitations:**
    - suspended users' existing JWTs can still query Supabase directly until expiry (fixed in Phase 4)
    - auth emails are platform-branded
    - custom-domain SSL is manual until Phase 5

- [ ] **Step 4: Commit**

```bash
git add docs/white-label.md .env.local.example src/app/globals.css src/app/icon.tsx
git commit -m "docs(platform): white-label deployment guide and env vars"
```

---

### Task 13: End-to-end verification

**Files:** none (verification only; fix any defects found in the owning task's files and commit them as `fix(platform): …`).

- [ ] **Step 1: Full automated suite**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: all green. Paste the summary lines into the report.

- [ ] **Step 2: Local stack E2E** (Supabase CLI + Inbucket at http://127.0.0.1:54324)

1. `npx supabase start && npx supabase db reset`. Set `.env.local` platform vars per Task 12 with `PLATFORM_BASE_DOMAIN=localhost`, `ADMIN_HOSTNAME=admin.localhost` and `PLATFORM_TENANT_ORIGIN_TEMPLATE=http://{slug}.localhost:3000`. Then `npm run dev`.
2. Create a user via the Supabase Studio, insert it into `platform_admins`, and sign in at `http://admin.localhost:3000/login` → lands on `/admin`.
3. Create client "Acme" (slug `acme`, logo PNG) → the invite appears in Inbucket → open the link → `http://acme.localhost:3000/reset-password` → set a password → `/dashboard` shows the Acme logo and name, and the tab title says Acme.
4. In Acme, invite a teammate → the invite link host is `acme.localhost:3000` → sign up from it in a private window → join succeeds without a `wrong_workspace` redirect.
5. Sign in on `acme.localhost` as the admin user (who belongs to a different account) → redirected to `/login?error=wrong_workspace`.
6. `curl -H "x-tenant-id: <other id>" http://acme.localhost:3000/dashboard -I` → no change in behaviour (header stripped).
7. Suspend Acme in the admin panel. Within 60s: `acme.localhost:3000` shows the suspended page; `curl -H "Authorization: Bearer <acme api key>" http://localhost:3000/api/v1/me` → 403; `http://nope.localhost:3000` → workspace-not-found.
8. Reactivate → everything works again within 60s.
9. Use chrome-devtools MCP `take_screenshot` on the Acme login, the Acme dashboard sidebar and the admin client list, and attach them to the report.

- [ ] **Step 3: Request a code review** with superpowers:requesting-code-review over the whole branch diff against `main`.

- [ ] **Step 4: Update the plan** — tick every checkbox that's done, and list anything unverified (e.g. no local Supabase CLI) explicitly.
