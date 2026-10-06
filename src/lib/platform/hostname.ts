// Hostname helpers shared by middleware, branding and the admin panel.
// NPM (Nginx Proxy Manager) forwards the browser's host in
// `x-forwarded-host`; a bare deployment only has `host`.

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

export function normalizeHostname(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let host = raw.split(",")[0].trim().toLowerCase();
  host = host.replace(/:\d+$/, "").replace(/\.$/, "");
  if (!host || host.length > 253 || !HOSTNAME_RE.test(host)) return null;
  return host;
}

export function requestHostname(headers: Headers): string | null {
  return (
    normalizeHostname(headers.get("x-forwarded-host")) ??
    normalizeHostname(headers.get("host"))
  );
}
