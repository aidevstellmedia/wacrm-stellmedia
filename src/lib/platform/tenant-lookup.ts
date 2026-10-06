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

export function forgetProfileAccount(userId: string): void {
  profileCache.delete(userId);
}

export function __resetTenantLookupCachesForTests(): void {
  tenantCache.clear();
  profileCache.clear();
}
