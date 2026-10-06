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
