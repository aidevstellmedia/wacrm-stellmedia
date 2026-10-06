import { normalizeHostname } from "./hostname";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;
const RESERVED = new Set(["admin", "www", "app", "api"]);

export function validateSlug(raw: string) {
  const slug = raw.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    return { ok: false as const, error: "Use 2–40 lowercase letters, numbers or hyphens (not at the start or end)." };
  }
  if (RESERVED.has(slug)) return { ok: false as const, error: `"${slug}" is reserved.` };
  return { ok: true as const, slug };
}

const FILE_RULES = {
  logo: { max: 512 * 1024, types: { "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg" } as Record<string, string> },
  favicon: { max: 128 * 1024, types: { "image/png": "png", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico" } as Record<string, string> },
};

export function validateBrandingFile(file: File | null, kind: "logo" | "favicon") {
  if (!file || file.size === 0) return { ok: true as const, file: null, ext: null };
  const rule = FILE_RULES[kind];
  const ext = rule.types[file.type];
  if (!ext) return { ok: false as const, error: `${kind === "logo" ? "Logo" : "Favicon"} must be ${kind === "logo" ? "PNG, WebP or JPEG" : "PNG or ICO"}.` };
  if (file.size > rule.max) return { ok: false as const, error: `${kind === "logo" ? "Logo" : "Favicon"} must be at most ${rule.max / 1024} KB.` };
  return { ok: true as const, file, ext };
}

export function validateCustomDomain(raw: string, baseDomain: string | null) {
  const trimmed = raw.trim();
  if (trimmed.includes("/") || trimmed.includes(":")) return { ok: false as const, error: "Enter a bare hostname like crm.acme.com." };
  const hostname = normalizeHostname(trimmed);
  if (!hostname || !hostname.includes(".")) return { ok: false as const, error: "Enter a bare hostname like crm.acme.com." };
  if (baseDomain && (hostname === baseDomain || hostname.endsWith(`.${baseDomain}`))) {
    return { ok: false as const, error: "Subdomains of the platform domain are managed automatically." };
  }
  return { ok: true as const, hostname };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function validateEmail(raw: string) {
  const email = raw.trim().toLowerCase();
  return EMAIL_RE.test(email) ? { ok: true as const, email } : { ok: false as const, error: "Enter a valid email address." };
}
