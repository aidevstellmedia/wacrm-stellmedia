import type { PlatformConfig } from "./config";
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

/** Resolve branding for a tenant host. Never throws: a failed lookup must not
 *  take page rendering down, so it logs and returns the fallback branding. */
export async function resolveBranding(
  host: string | null,
  lookup: (host: string) => Promise<TenantRecord | null>,
  cfg: PlatformConfig,
  supabaseUrl: string,
): Promise<TenantBranding> {
  let tenant: TenantRecord | null = null;
  if (host) {
    try {
      tenant = await lookup(host);
    } catch (err) {
      console.error("[platform] branding lookup failed; using fallback branding", err);
    }
  }
  return brandingFromTenant(tenant, cfg, supabaseUrl);
}
