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
