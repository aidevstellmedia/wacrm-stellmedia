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

// Fail closed and loud: a set-but-malformed value must not silently turn
// platform mode off (which would serve every tenant host as single-tenant).
function requireHostname(name: string, raw: string | undefined): string | null {
  const value = normalizeHostname(raw);
  if (!value && raw?.trim()) {
    throw new Error(`Invalid ${name}: "${raw}" (use a bare hostname like crm.example.com)`);
  }
  return value;
}

export function readPlatformConfig(
  env: Record<string, string | undefined> = process.env,
): PlatformConfig {
  const baseDomain = requireHostname("PLATFORM_BASE_DOMAIN", env.PLATFORM_BASE_DOMAIN);
  const adminHostname = requireHostname("ADMIN_HOSTNAME", env.ADMIN_HOSTNAME);
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
