import { normalizeHostname } from "./hostname";
import { TENANT_HEADER_HOST } from "./tenant-routing";

// Origin for links (e.g. invites) on a tenant host. The hostname comes
// from x-tenant-host, which middleware validated; only an optional port
// and an http/https scheme are taken from other headers.
export function tenantRequestOrigin(
  headers: Headers,
  requestUrl: string,
): string | null {
  const tenantHost = headers.get(TENANT_HEADER_HOST);
  if (!tenantHost) return null;

  const raw = (
    headers.get("x-forwarded-host")?.split(",")[0] ?? headers.get("host") ?? ""
  ).trim();
  const portMatch = raw.match(/:(\d+)$/);
  const port =
    portMatch && normalizeHostname(raw) === tenantHost ? `:${portMatch[1]}` : "";

  const fwdProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  let proto = "https";
  if (fwdProto === "http" || fwdProto === "https") {
    proto = fwdProto;
  } else {
    try {
      const p = new URL(requestUrl).protocol.replace(":", "");
      if (p === "http" || p === "https") proto = p;
    } catch {
      // keep https
    }
  }
  return `${proto}://${tenantHost}${port}`;
}
