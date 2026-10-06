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
