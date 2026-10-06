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
