# White-label multi-tenant platform — Phase 1 (tenant foundation + branding) & Phase 2 (super-admin panel)

## Context
Stell Media wants to resell this WhatsApp CRM (fork of upstream ArnasDon/wacrm) to clients under each client's own brand, and manage all clients as super admin. Agreed decisions (from brainstorming):

- **Shared platform**: one Docker deployment on the VPS + one Supabase cloud project. Client = existing `accounts` row (migration 017 already isolates every table by `account_id` via `is_account_member()` RLS). Keep code deployable as a single-client instance later for clients that contractually need their own DB.
- **Per-client branding**: logo, favicon, app/display name. Colors stay platform-wide (Stell Media palette as default theme); the existing theme picker (`src/lib/themes.ts`) stays.
- **Access**: subdomain `<slug>.crm.stellmedia.com` by default + optional custom domain. Nginx Proxy Manager (already on VPS) terminates SSL: one wildcard cert via DNS challenge (manual, once); custom domains added manually in NPM until Phase 5 automates it.
- **Invite-only**: public `/signup` disabled. One WhatsApp number per client. One user ↔ one client (existing invariant).
- **Super admin**: separate `platform_admins` table; admin UI at `admin.crm.stellmedia.com`, **same repo**, isolated folders.
- **Suspension = soft**: UI login blocked, API keys rejected, outbound sends/broadcasts/automations/flows/AI replies paused; inbound webhook messages still stored.
- Existing Stell Media account becomes client #1 (slug `stellmedia`). Billing out of scope.
- **Upstream merges must stay cheap**: platform code in new folders (`src/lib/platform/`, `src/app/(admin)/`), migrations numbered `100_platform_*.sql` (after upstream's 0xx; all idempotent like existing ones), minimal edits to upstream files.

Phases 3–5 are follow-ups (own spec → plan cycle each), outlined at the bottom.

**Step 0 when leaving plan mode**: copy this design to `docs/superpowers/specs/2026-10-06-white-label-multitenancy-design.md`, commit it, then invoke `superpowers:writing-plans` for the task-level implementation plan (TDD). Also: `changeAbout.txt` contains a live Meta access token — add to `.gitignore`/delete, and rotate the token.

Next.js note: Next 16 renamed Middleware → Proxy (`node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md`). The repo still uses `src/middleware.ts`; keep the upstream file name (merge-friendliness) and confirm it still runs under 16.3.5; add logic via imported modules, not inline.

## Phase 1 — Tenant foundation + branding

### Database: `supabase/migrations/100_platform_tenancy.sql`
- `tenant_settings` (PK `account_id` → `accounts.id` ON DELETE CASCADE): `slug TEXT UNIQUE` (lowercase, `^[a-z0-9-]{2,40}$`, reserved: `admin`, `www`, `app`, `api`), `logo_path`, (display name = existing `accounts.name`, no duplicate column) `favicon_path`, `status` (`active|suspended`, default active), `suspended_at`, timestamps.
- `tenant_domains`: `id`, `account_id`, `hostname TEXT UNIQUE` (lowercased), `kind` (`subdomain|custom`), `verified_at`, `npm_proxy_host_id INT NULL` (Phase 5), `created_at`.
- `platform_admins`: `user_id` PK → auth.users, `created_at`.
- `platform_audit_log`: `id`, `actor_user_id`, `action`, `account_id NULL`, `details JSONB`, `created_at`.
- RLS enabled on all four; **no** policies for anon/authenticated except: platform admins (`is_platform_admin()` SECURITY DEFINER helper) full access; members may SELECT their own `tenant_settings` row.
- `resolve_tenant(p_hostname TEXT)` SECURITY DEFINER RPC, granted to `anon`/`authenticated`: returns only `account_id, slug, display_name (= accounts.name), logo_path, favicon_path, status` for that hostname. This is how proxy/pages read branding pre-auth without the service-role key.
- Public storage bucket `tenant-branding` (path `<account_id>/logo.*`, `<account_id>/favicon.*`); write only via service role.
- Backfill: tenant_settings for the existing Stell Media account (slug `stellmedia`), domain rows for `stellmedia.crm.stellmedia.com` **and the current production hostname** (so the existing Meta webhook URL keeps working), insert the user's user_id into `platform_admins` (by email `ai.dev@stellmedia.com`, guarded `IF EXISTS`).
- Append assertions to `supabase/ci/verify-schema.sql` for the new tables/RPC.

### Request flow: `src/lib/platform/tenant-resolve.ts` (called from `src/middleware.ts`)
1. Hostname from `x-forwarded-host` (NPM) falling back to `host`; lowercase, strip port.
2. **Exempt paths** (never tenant-gated, never 404): `/api/whatsapp/webhook*` (Meta posts to one URL; account resolved by phone_number_id as today), `/api/v1/*` (account comes from the API key), `/auth/callback`, static assets.
3. `ADMIN_HOSTNAME` env (e.g. `admin.crm.stellmedia.com`) → admin mode: only `(admin)` routes + auth pages; dashboard routes redirect to `/admin`.
4. Otherwise `resolve_tenant(host)` with an in-memory TTL cache (~60s, `Map<host, {tenant, expires}>`); unknown host → rewrite to `/workspace-not-found`; `status=suspended` → rewrite to `/workspace-suspended`.
5. **Delete any client-supplied `x-tenant-*` request headers**, then set our own `x-tenant-id` / `x-tenant-host` for server components. Rule: these headers are only ever trusted because middleware overwrites them.
6. **Host↔account binding (security-critical)**: on a tenant host, for signed-in users on the existing `protectedPaths` (dashboard routes) and authed `/api/whatsapp/*` routes **only** — never on `/join/*`, `/auth/*`, `/login`, `/signup`, `/reset-password` — read their `profiles.account_id` (cache per user id ~60s); if ≠ tenant account_id → sign out + redirect `/login?error=wrong_workspace`. Reason: a new teammate signing up from an invite first gets a personal account from `handle_new_user`; `accept_invitation` (019, lines ~160–229) then moves `profiles.account_id` to the inviting account and deletes the empty personal one — the check must not fire before that accept happens. Platform admins are *not* exempt (impersonation is Phase 4).
7. Local dev: `PLATFORM_DEFAULT_TENANT_HOST` env lets `localhost` map to a tenant; if unset and no match, behave as today (single-tenant fallback = the dedicated-instance mode).
- Remove `/signup` from reachable routes (redirect to `/login`) unless `?invite=` is present — the invite flow (`/join/[token]`, `/signup?invite=`) keeps working.
- Add `/admin` to the login-required paths so a logged-out admin on the admin host gets the login page (not a 404); after login, admin host redirects `/dashboard` → `/admin`.
- Caching: `next.config.ts` sets `public, s-maxage=300` on pages. Branded pages vary by host — add `Vary: Host` (or mark tenant-rendered pages `private`) so no shared cache serves tenant A's branding on tenant B's host.
- Update `src/middleware.test.ts`: keep its protected-paths directory check satisfied, add tests for exempt paths, unknown host, suspended, wrong-workspace redirect, admin host, spoofed `x-tenant-id` stripped, and **the invite scenario**: user whose account ≠ tenant can reach `/join/<token>` and `/auth/callback` on the tenant host without being signed out.

### Branding in the UI: `src/lib/platform/branding.ts`
- `getTenantBranding()` (server; reads `x-tenant-id` via `headers()`, then the cached tenant) → `{ displayName, logoUrl, faviconUrl }`, fallback to Stell Media defaults.
- Metadata: `generateMetadata()` → title default/template from `displayName`, `icons` from `faviconUrl` (fallback `/icon`). **Before implementing**, check Next 16 docs on dynamic APIs (`headers()`) in layouts/`generateMetadata`; `next.config.ts` currently has no `cacheComponents`, so root `src/app/layout.tsx` is acceptable — if that changes, move branded metadata into the `(dashboard)`, `(auth)`, `join` layouts instead.
- `src/app/icon.tsx`: recolor to the Stell Media palette (fallback icon only).
- `src/components/layout/sidebar.tsx` logo row (~line 190): render `<img src={logoUrl}>` when present else current `MessageSquare` mark; name = `displayName`. Pass branding from `src/app/(dashboard)/layout.tsx` via a small `BrandingProvider` context (`src/lib/platform/branding-context.tsx`).
- Auth pages (`src/app/(auth)/layout.tsx`, `src/app/join/layout.tsx`): logo + name header.
- `messages/*` strings containing "wacrm" → `{brand}` placeholder, filled with `displayName`.
- Theme: set the Stell Media palette as default (adjust `violet` tokens in `globals.css` or add `stellmedia` theme in `themes.ts` and make it `DEFAULT_THEME`); picker unchanged.

## Phase 2 — Super-admin panel (same repo)

### Structure
- `src/app/(admin)/admin/` — `layout.tsx` (server-side `requirePlatformAdmin()` → `notFound()` otherwise), `page.tsx` (clients list), `clients/new/page.tsx`, `clients/[accountId]/page.tsx`, `admins/page.tsx`, `audit/page.tsx`.
- `src/lib/platform/admin-client.ts` — service-role client, same pattern as `src/lib/automations/admin-client.ts`.
- `src/lib/platform/guard.ts` — `requirePlatformAdmin()` (user session + `platform_admins` row + admin hostname) used by every page **and every server action**.
- `src/lib/platform/actions.ts` — server actions, each writes `platform_audit_log`.
- Reuse existing UI primitives in `src/components/ui/` and settings card styling.

### Features
1. **Clients list**: display name, slug/domains, status, member count, WhatsApp connected (`whatsapp_config` exists), created_at.
2. **Create client**: company name, slug, logo, favicon, owner email + name. Server action:
   - `supabaseAdmin.auth.admin.inviteUserByEmail(email, { data: { full_name }, redirectTo: https://<slug>.crm.stellmedia.com/auth/callback?next=/reset-password })` → existing `handle_new_user` trigger (017 line ~659) creates the account + owner profile (no trigger changes).
   - Look up the new account by `owner_user_id`, rename to company name, insert `tenant_settings` + subdomain `tenant_domains`, upload branding to `tenant-branding/<account_id>/`.
   - Reject if the email already has a user (one-account-per-user invariant) with a clear message.
   - **Partial-failure safe**: validate slug/files first; after the invite, every later step is idempotent. The clients list also shows accounts that have no `tenant_settings` yet, with a "Complete setup" action that re-runs the remaining steps.
   - Verify `/reset-password` accepts an `invite`-type session (not only `recovery`) via `src/app/auth/callback/route.ts`; if not, add a small `/set-password` page.
3. **Client detail**: edit display name/logo/favicon; add/remove domains (custom domain shows NPM + DNS instructions; manual until Phase 5); resend owner invite; suspend/reactivate (bust tenant cache — TTL ≤60s acceptable).
4. **Platform admins**: add (existing user by email) / remove (cannot remove self/last).
5. **Audit log**: read-only list.

### Soft-suspend enforcement (server-side)
- UI: proxy rewrite to `/workspace-suspended` (Phase 1 step 4).
- API keys: in `src/lib/api-keys/store.ts` key verification → reject if tenant suspended (403 `workspace_suspended`).
- Outbound: shared `assertTenantActive(accountId)` in `src/lib/platform/tenant-status.ts`, called at the credential-loading / send entry points: `src/lib/whatsapp/send-message.ts`, `src/lib/whatsapp/broadcast-core.ts` (`createBroadcast`, `deliverBroadcast`), `src/lib/automations/meta-send.ts`, `src/lib/flows/meta-send.ts` (`loadAccountMetaCredentials`), `src/lib/ai/auto-reply.ts`. Implementer must grep every importer of `@/lib/whatsapp/meta-api` to confirm no send path is missed.
- Inbound `src/app/api/whatsapp/webhook/route.ts`: keep storing messages; skip triggering automations/flows/AI for suspended tenants.
- Known limitation (accepted for soft suspend): a suspended user's existing JWT could still hit Supabase REST directly until expiry; a DB-level gate via `is_account_member` is deferred to Phase 4, which touches that function anyway.

### Env / ops
- New env: `ADMIN_HOSTNAME`, `PLATFORM_BASE_DOMAIN` (`crm.stellmedia.com`), `PLATFORM_DEFAULT_TENANT_HOST` (dev). Document in `docs/white-label.md` + `.env.example`.
- NPM (manual, once): proxy host `*.crm.stellmedia.com` + `admin.crm.stellmedia.com` → app container, wildcard Let's Encrypt via DNS challenge; ensure NPM forwards `Host`/`X-Forwarded-Host`.
- Supabase Auth → URL configuration: add `https://*.crm.stellmedia.com/**` to Redirect URLs; each custom domain added manually (Phase 5 can automate). Auth emails stay platform-branded (one template per project).
- DNS: wildcard `*.crm.stellmedia.com` A record → VPS.

## Verification
- `npm run typecheck`, `npm run lint`, `npm test` (vitest): new unit tests for hostname normalisation, `tenant-resolve` (exempt paths, unknown/suspended/admin host, wrong-workspace binding), `assertTenantActive`, `requirePlatformAdmin`, slug validation; updated `src/middleware.test.ts`.
- Migrations: `supabase db reset` locally + `supabase/ci/verify-schema.sql`; re-run `100_*` twice to prove idempotency.
- Manual E2E (local, `/etc/hosts` entries `acme.crm.localhost`, `admin.crm.localhost`, or `*.localhost`): sign in on admin host → create client "Acme" → invite email (Supabase Inbucket locally) → set password on acme host → sidebar/tab/login show Acme branding → log in as Stell Media user on acme host → rejected → suspend Acme → acme host shows suspended page, API key returns 403, broadcast send refused, inbound webhook still stored → reactivate.
- Use chrome-devtools MCP to screenshot branded login/sidebar for both tenants.

## Follow-up phases (separate spec → plan each)
3. **Features + limits**: `tenant_entitlements` (module toggles: broadcasts, automations, flows, AI, API, webhooks; caps: members, contacts, broadcasts/month, AI replies/month); enforced server-side at the same entry points + nav hiding; block with "contact your provider" message.
4. **Read-only support view**: `platform_impersonations` (admin, account, expires_at, reason) + `is_account_member()` returns true for platform admin with active impersonation **only when min_role = 'viewer'** (writes stay denied, no edits to existing policies); effective-account override in `src/hooks/use-auth.tsx`; banner + audit log. Also adds DB-level suspended gate.
5. **Custom domains via NPM API**: admin action checks DNS resolves to VPS IP → NPM `POST /api/tokens` then `POST /api/nginx/proxy-hosts` (`certificate_id: "new"`, `ssl_forced`, letsencrypt meta) → store `npm_proxy_host_id`; delete on removal; NPM creds server-only env; app and NPM on a shared Docker network. Optionally add the domain to Supabase Auth redirect URLs via the Management API.
