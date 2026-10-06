# White-label platform mode

## What platform mode does

Platform mode turns one deployment into a multi-client (white-label) CRM. It is enabled if and only if `PLATFORM_BASE_DOMAIN` or `ADMIN_HOSTNAME` is set; with neither set the app behaves exactly as upstream. In platform mode every request host must be a registered client domain (a `*.crm.stellmedia.com` subdomain or a custom domain), each host is bound to one account, public sign-up is disabled (clients are invited by a platform admin), and the super-admin panel (`/admin`) is served on `ADMIN_HOSTNAME` only.

## Local development

This is the complete walkthrough for running platform mode on your machine. `*.localhost` resolves to 127.0.0.1 in Chrome and Firefox, so no DNS or hosts-file edits are needed.

### 1. Start local Supabase

```bash
npx supabase start
npx supabase status        # prints API URL, keys, DB URL
```

With the defaults: API `http://127.0.0.1:54321`, DB `postgresql://postgres:postgres@127.0.0.1:54322/postgres`, Studio `http://127.0.0.1:54323`, Inbucket (mail) `http://127.0.0.1:54324`. `supabase start` applies everything in `supabase/migrations/`, including `100_platform_tenancy.sql`. To re-apply from scratch: `npx supabase db reset`.

### 2. Create `.env.local`

Next loads `.env.local` with higher priority than `.env`, so it overrides `.env` (which points at the real Supabase project). Create `.env.local` in the repo root, taking the values from `npx supabase status` (`PUBLISHABLE_KEY`/`ANON_KEY`, `SERVICE_ROLE_KEY`):

```env
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<ANON_KEY from supabase status>
SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY from supabase status>
ENCRYPTION_KEY=<64 hex chars, e.g. `openssl rand -hex 32`>
META_APP_SECRET=local-dev-placeholder
NEXT_PUBLIC_SITE_URL=http://localhost:3000

# Platform mode
PLATFORM_BASE_DOMAIN=localhost
ADMIN_HOSTNAME=admin.localhost
PLATFORM_NAME=Stell Media CRM
PLATFORM_DEFAULT_TENANT_HOST=stellmedia.localhost
PLATFORM_TENANT_ORIGIN_TEMPLATE=http://{slug}.localhost:3000
```

Restart `npm run dev` after any env change. Browse to `http://admin.localhost:3000` (admin panel) and `http://stellmedia.localhost:3000` (the Stell Media client).

### 3. Allow local auth redirects

Local Supabase only redirects to allowed URLs. `supabase/config.toml` currently has no `[auth]` section, so add one (local only; do not commit it if you do not want to change CI behaviour):

```toml
[auth]
site_url = "http://localhost:3000"
additional_redirect_urls = [
  "http://localhost:3000/**",
  "http://*.localhost:3000/**",
]
```

Then `npx supabase stop && npx supabase start` to apply.

### 4. Make yourself a platform admin

The migration's backfill only promotes `ai.dev@stellmedia.com`, and only if that user already exists when the migration runs. On a fresh local database, sign up / create your user first (Studio at `http://127.0.0.1:54323` > Authentication > Add user), then run in the SQL editor or with `psql postgresql://postgres:postgres@127.0.0.1:54322/postgres`:

```sql
insert into platform_admins (user_id)
select id from auth.users where email = 'you@example.com'
on conflict do nothing;
```

Then sign in at `http://admin.localhost:3000`.

### 5. Invite emails (Inbucket)

Local Supabase sends no real email. Open Inbucket at <http://127.0.0.1:54324>, find the invite or password-reset message and click its link.

For the link to land on the client's host with a working session, the invite and recovery templates must use the `token_hash` form (see "Supabase Auth" below). Locally, set them in `supabase/config.toml` with a `content_path` HTML file:

```toml
[auth.email.template.invite]
subject = "You've been invited"
content_path = "./supabase/templates/invite.html"

[auth.email.template.recovery]
subject = "Reset your password"
content_path = "./supabase/templates/recovery.html"
```

`supabase/templates/invite.html`:

```html
<h2>You have been invited</h2>
<p><a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=invite">Accept invitation</a></p>
```

`supabase/templates/recovery.html`:

```html
<h2>Reset password</h2>
<p><a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=recovery">Reset password</a></p>
```

Restart Supabase after editing templates.

## DNS

Create these A records pointing at the VPS IP:

- `*.crm.stellmedia.com`
- `admin.crm.stellmedia.com`

## Nginx Proxy Manager

- One proxy host for `*.crm.stellmedia.com` and `admin.crm.stellmedia.com`, forwarding to the app container (`http://<container>:3000`).
- SSL: "Request a new certificate" with "Use a DNS Challenge" (wildcards require it) and your DNS provider's API credentials.
- Turn "Force SSL" on.
- Custom client domains: one proxy host each, with a normal HTTP-challenge certificate.
- NPM forwards `Host` by default; do not override it. Tenant resolution depends on it.

## Supabase Auth

- Redirect URLs: add `https://*.crm.stellmedia.com/**` and `https://admin.crm.stellmedia.com/**`, plus each custom domain (`https://<domain>/**`).
- Set the **Invite user** email template link to:

  ```html
  <a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=invite">Accept invitation</a>
  ```

  Why: admin-created invites carry no PKCE verifier, and `redirectTo` already contains `?next=`, which is why `&` is correct.
- Set the **Reset password** template to:

  ```html
  <a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=recovery">Reset password</a>
  ```

  so resets return to the client's own domain.

## Environment variables

```env
# Setting either of the first two turns platform mode on: every host
# must be a registered client domain, public sign-up is disabled, and
# /admin is served on ADMIN_HOSTNAME only.
PLATFORM_BASE_DOMAIN=crm.stellmedia.com
ADMIN_HOSTNAME=admin.crm.stellmedia.com
# Name shown on the admin host and when no client matches.
PLATFORM_NAME=Stell Media CRM
# Local dev only:
# PLATFORM_DEFAULT_TENANT_HOST=stellmedia.localhost
# PLATFORM_TENANT_ORIGIN_TEMPLATE=http://{slug}.localhost:3000
```

## Migration

- Apply `supabase/migrations/100_platform_tenancy.sql`.
- It makes `ai.dev@stellmedia.com` a platform admin and creates the Stell Media client `stellmedia`.
- Add your current production hostname so existing users keep working:

  ```sql
  INSERT INTO tenant_domains (account_id, hostname, kind, verified_at)
  SELECT account_id, '<current-host>', 'custom', NOW() FROM tenant_settings WHERE slug = 'stellmedia'
  ON CONFLICT DO NOTHING;
  ```

## Onboarding a client

1. Sign in at `https://admin.crm.stellmedia.com` as a platform admin.
2. Create a client: name and slug (2-40 chars, lowercase letters/digits/hyphens; `admin`, `www`, `app`, `api` are reserved) and the first admin's email. This provisions the account and sends the invite.
3. Optionally set branding (name, logo, favicon, colours) for the client.
4. The client opens the invite email and sets a password; they land on `https://<slug>.crm.stellmedia.com`.
5. For a custom domain, add the DNS record and an NPM proxy host with its certificate, then register the hostname on the client in the admin panel.

## Suspension

Suspending a client is a soft suspend.

- Stops: dashboard UI (shows a suspended page), dashboard `/api/*` (403 `workspace_suspended`), API keys (403), and outbound sends, broadcasts, automations, flows and AI.
- Keeps working: inbound WhatsApp webhook messages are still received and stored; data is retained. Reactivating restores everything.

## Known limitations

- Suspended users' existing JWTs can still query Supabase directly until they expire (fixed in Phase 4).
- Auth emails are platform-branded, not per client.
- Custom-domain SSL is manual until Phase 5.
