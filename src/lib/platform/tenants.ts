// Tenant provisioning and admin data access. Service role throughout —
// every exported function is only reachable via actions.ts, which calls
// requirePlatformAdmin() first.

import { platformAdmin } from "./admin-client";
import { readPlatformConfig, tenantOrigin, tenantSubdomainHost } from "./config";

export class PlatformError extends Error {}

export interface TenantListRow {
  accountId: string;
  name: string;
  slug: string | null;
  status: "active" | "suspended" | "incomplete";
  domains: string[];
  memberCount: number;
  whatsappConnected: boolean;
  createdAt: string;
}

type BrandingFile = { file: File; ext: string } | null;

const db = () => platformAdmin();

export async function writeAudit(
  actorUserId: string,
  action: string,
  accountId: string | null,
  details: Record<string, unknown> = {},
) {
  const { error } = await db()
    .from("platform_audit_log")
    .insert({ actor_user_id: actorUserId, action, account_id: accountId, details });
  if (error) console.error("[platform] audit write failed:", error.message);
}

export async function listTenants(): Promise<TenantListRow[]> {
  // Fine at tens of tenants; paginate if this grows past a few hundred.
  const [accounts, settings, domains, profiles, configs, admins] = await Promise.all([
    db().from("accounts").select("id, name, owner_user_id, created_at").order("created_at", { ascending: false }),
    db().from("tenant_settings").select("account_id, slug, status"),
    db().from("tenant_domains").select("account_id, hostname"),
    db().from("profiles").select("account_id"),
    db().from("whatsapp_config").select("account_id"),
    db().from("platform_admins").select("user_id"),
  ]);
  for (const r of [accounts, settings, domains, profiles, configs, admins]) if (r.error) throw new Error(r.error.message);

  const settingsBy = new Map((settings.data ?? []).map((s) => [s.account_id as string, s]));
  // A platform admin's own personal account is not a client: hide it unless
  // it has actually been set up as a tenant.
  const adminIds = new Set((admins.data ?? []).map((a) => a.user_id as string));
  const visible = (accounts.data ?? []).filter(
    (a) => settingsBy.has(a.id) || !adminIds.has(a.owner_user_id as string),
  );
  return visible.map((a) => {
    const s = settingsBy.get(a.id);
    return {
      accountId: a.id,
      name: a.name,
      slug: (s?.slug as string) ?? null,
      status: s ? (s.status as "active" | "suspended") : "incomplete",
      domains: (domains.data ?? []).filter((d) => d.account_id === a.id).map((d) => d.hostname as string),
      memberCount: (profiles.data ?? []).filter((p) => p.account_id === a.id).length,
      whatsappConnected: (configs.data ?? []).some((c) => c.account_id === a.id),
      createdAt: a.created_at,
    };
  });
}

async function uploadBranding(accountId: string, kind: "logo" | "favicon", file: File, ext: string): Promise<string> {
  const path = `${accountId}/${kind}.${ext}`;
  const { error } = await db().storage.from("tenant-branding").upload(path, file, { upsert: true, contentType: file.type });
  if (error) throw new PlatformError(`Could not upload ${kind}: ${error.message}`);
  return path;
}

async function findUserIdByEmail(rawEmail: string): Promise<string | null> {
  const email = rawEmail.trim().toLowerCase();
  // profiles.email is filled by handle_new_user; avoids paging auth.admin.listUsers.
  const { data, error } = await db().from("profiles").select("user_id").eq("email", email).maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.user_id as string) ?? null;
}

async function ownerEmailFor(accountId: string): Promise<{ ownerId: string | null; email: string | null }> {
  const { data: acct, error } = await db().from("accounts").select("owner_user_id").eq("id", accountId).maybeSingle();
  if (error) throw new Error(error.message);
  const ownerId = (acct?.owner_user_id as string) ?? null;
  if (!ownerId) return { ownerId: null, email: null };
  const { data: prof, error: profErr } = await db().from("profiles").select("email").eq("user_id", ownerId).maybeSingle();
  if (profErr) throw new Error(profErr.message);
  return { ownerId, email: (prof?.email as string) ?? null };
}

export async function completeTenantSetup(
  accountId: string,
  input: { companyName: string; slug: string; logo: BrandingFile; favicon: BrandingFile },
): Promise<void> {
  const cfg = readPlatformConfig();
  const taken = () => new PlatformError(`The address "${input.slug}" is already taken.`);
  // Only incomplete accounts (no settings row yet) may run setup.
  const { data: already, error: alreadyErr } = await db()
    .from("tenant_settings").select("account_id").eq("account_id", accountId).maybeSingle();
  if (alreadyErr) throw new Error(alreadyErr.message);
  if (already) throw new PlatformError("This client is already set up.");
  const { error: nameErr } = await db().from("accounts").update({ name: input.companyName }).eq("id", accountId);
  if (nameErr) throw new Error(nameErr.message);

  const { data: existingSlug, error: slugErr } = await db()
    .from("tenant_settings").select("account_id").eq("slug", input.slug).maybeSingle();
  if (slugErr) throw new Error(slugErr.message);
  if (existingSlug && existingSlug.account_id !== accountId) throw taken();

  // Domain first, settings row last: the settings row marks "setup complete",
  // so a partial failure leaves the account listed as incomplete.
  const hostname = tenantSubdomainHost(cfg, input.slug);
  const { error: domErr } = await db().from("tenant_domains").upsert(
    { account_id: accountId, hostname, kind: "subdomain", verified_at: new Date().toISOString() },
    { onConflict: "hostname", ignoreDuplicates: true },
  );
  if (domErr) {
    if (domErr.code === "23505") throw taken();
    throw new Error(domErr.message);
  }
  // ignoreDuplicates no-ops when another account already owns the hostname.
  const { data: domRow, error: domSelErr } = await db()
    .from("tenant_domains").select("account_id").eq("hostname", hostname).maybeSingle();
  if (domSelErr) throw new Error(domSelErr.message);
  if (!domRow || domRow.account_id !== accountId) throw taken();

  const patch: Record<string, unknown> = { account_id: accountId, slug: input.slug };
  if (input.logo) patch.logo_path = await uploadBranding(accountId, "logo", input.logo.file, input.logo.ext);
  if (input.favicon) patch.favicon_path = await uploadBranding(accountId, "favicon", input.favicon.file, input.favicon.ext);
  const { error: setErr } = await db().from("tenant_settings").upsert(patch, { onConflict: "account_id" });
  if (setErr) {
    if (setErr.code === "23505") throw taken();
    throw new Error(setErr.message);
  }
}

export async function createTenant(input: {
  companyName: string; slug: string; ownerEmail: string; ownerName: string;
  logo: BrandingFile; favicon: BrandingFile;
}): Promise<{ accountId: string }> {
  const cfg = readPlatformConfig();
  if (await findUserIdByEmail(input.ownerEmail)) {
    throw new PlatformError("A user with this email already exists. Each person can belong to only one client.");
  }
  const { data: taken, error: takenErr } = await db()
    .from("tenant_settings").select("account_id").eq("slug", input.slug).maybeSingle();
  if (takenErr) throw new Error(takenErr.message);
  if (taken) throw new PlatformError(`The address "${input.slug}" is already taken.`);
  const { data: takenHost, error: takenHostErr } = await db()
    .from("tenant_domains").select("account_id").eq("hostname", tenantSubdomainHost(cfg, input.slug)).maybeSingle();
  if (takenHostErr) throw new Error(takenHostErr.message);
  if (takenHost) throw new PlatformError(`The address "${input.slug}" is already taken.`);

  const redirectTo = `${tenantOrigin(cfg, input.slug)}/auth/callback?next=/reset-password`;
  const { data, error } = await db().auth.admin.inviteUserByEmail(input.ownerEmail, {
    data: { full_name: input.ownerName },
    redirectTo,
  });
  if (error || !data.user) throw new PlatformError(`Invite failed: ${error?.message ?? "no user returned"}`);

  // handle_new_user (017) has created the owner's account + profile.
  const { data: acct, error: acctErr } = await db()
    .from("accounts").select("id").eq("owner_user_id", data.user.id).maybeSingle();
  if (acctErr) throw new Error(acctErr.message);
  if (!acct) throw new PlatformError("Owner invited, but their account was not created. Check the handle_new_user trigger.");

  await completeTenantSetup(acct.id, { companyName: input.companyName, slug: input.slug, logo: input.logo, favicon: input.favicon });
  return { accountId: acct.id };
}

export async function getTenantDetail(accountId: string): Promise<{
  row: TenantListRow;
  logoPath: string | null;
  faviconPath: string | null;
  ownerEmail: string | null;
  domains: { id: string; hostname: string; kind: string }[];
} | null> {
  const row = (await listTenants()).find((t) => t.accountId === accountId);
  if (!row) return null;

  const [settings, domains, owner] = await Promise.all([
    db().from("tenant_settings").select("logo_path, favicon_path").eq("account_id", accountId).maybeSingle(),
    db().from("tenant_domains").select("id, hostname, kind").eq("account_id", accountId).order("created_at"),
    ownerEmailFor(accountId),
  ]);
  if (settings.error) throw new Error(settings.error.message);
  if (domains.error) throw new Error(domains.error.message);

  return {
    row,
    logoPath: (settings.data?.logo_path as string) ?? null,
    faviconPath: (settings.data?.favicon_path as string) ?? null,
    ownerEmail: owner.email,
    domains: (domains.data ?? []).map((d) => ({ id: d.id as string, hostname: d.hostname as string, kind: d.kind as string })),
  };
}

export async function updateTenantBranding(
  accountId: string,
  input: { companyName: string; logo: BrandingFile; favicon: BrandingFile },
): Promise<void> {
  // Check setup first so we don't upload files or rename an incomplete account.
  const { data: existing, error: existErr } = await db()
    .from("tenant_settings").select("account_id").eq("account_id", accountId).maybeSingle();
  if (existErr) throw new Error(existErr.message);
  if (!existing) throw new PlatformError("Finish setting up this client first.");

  const { error: nameErr } = await db().from("accounts").update({ name: input.companyName }).eq("id", accountId);
  if (nameErr) throw new Error(nameErr.message);

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }; // busts the branding cache
  if (input.logo) patch.logo_path = await uploadBranding(accountId, "logo", input.logo.file, input.logo.ext);
  if (input.favicon) patch.favicon_path = await uploadBranding(accountId, "favicon", input.favicon.file, input.favicon.ext);
  const { data, error } = await db().from("tenant_settings").update(patch).eq("account_id", accountId).select("account_id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new PlatformError("Finish setting up this client first.");
}

export async function setTenantStatus(accountId: string, status: "active" | "suspended"): Promise<void> {
  const now = new Date().toISOString();
  const { data, error } = await db()
    .from("tenant_settings")
    .update({ status, suspended_at: status === "suspended" ? now : null, updated_at: now })
    .eq("account_id", accountId)
    .select("account_id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new PlatformError("Finish setting up this client first.");
}

export async function addTenantDomain(accountId: string, hostname: string): Promise<void> {
  if (hostname === readPlatformConfig().adminHostname) throw new PlatformError("That hostname is reserved.");
  const { error } = await db().from("tenant_domains").insert({ account_id: accountId, hostname, kind: "custom" });
  if (error) {
    if (error.code === "23505") throw new PlatformError("That domain is already in use.");
    throw new Error(error.message);
  }
}

export async function removeTenantDomain(accountId: string, domainId: string): Promise<void> {
  const { data: row, error } = await db()
    .from("tenant_domains").select("id, account_id, kind").eq("id", domainId).eq("account_id", accountId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new PlatformError("Domain not found.");

  if (row.kind === "subdomain") {
    const { data: subs, error: subErr } = await db()
      .from("tenant_domains").select("id").eq("account_id", row.account_id).eq("kind", "subdomain");
    if (subErr) throw new Error(subErr.message);
    if ((subs ?? []).length <= 1) throw new PlatformError("Cannot remove the client's only platform subdomain.");
  }
  const { error: delErr } = await db().from("tenant_domains").delete().eq("id", domainId).eq("account_id", accountId);
  if (delErr) throw new Error(delErr.message);
}

export async function resendOwnerInvite(accountId: string): Promise<void> {
  const cfg = readPlatformConfig();
  const { ownerId, email } = await ownerEmailFor(accountId);
  if (!ownerId || !email) throw new PlatformError("This client has no owner email on file.");

  const { data: settings, error: setErr } = await db()
    .from("tenant_settings").select("slug").eq("account_id", accountId).maybeSingle();
  if (setErr) throw new Error(setErr.message);
  const slug = settings?.slug as string | undefined;
  if (!slug) throw new PlatformError("Finish setting up this client (address) before resending the invite.");

  const { data: userRes, error: userErr } = await db().auth.admin.getUserById(ownerId);
  if (userErr || !userRes?.user) throw new Error(userErr?.message ?? "Owner auth user not found");
  if (userRes.user.last_sign_in_at) throw new PlatformError("The owner has already activated their account.");

  const { error } = await db().auth.admin.inviteUserByEmail(email, {
    redirectTo: `${tenantOrigin(cfg, slug)}/auth/callback?next=/reset-password`,
  });
  if (error) throw new PlatformError(`Invite failed: ${error.message}`);
}

async function emailsByUserId(userIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (userIds.length === 0) return map;
  const { data, error } = await db().from("profiles").select("user_id, email").in("user_id", userIds);
  if (error) throw new Error(error.message);
  for (const p of data ?? []) map.set(p.user_id as string, (p.email as string) ?? null);
  return map;
}

export async function listPlatformAdmins(): Promise<{ userId: string; email: string | null; createdAt: string }[]> {
  const { data, error } = await db().from("platform_admins").select("user_id, created_at").order("created_at");
  if (error) throw new Error(error.message);
  const emails = await emailsByUserId((data ?? []).map((a) => a.user_id as string));
  return (data ?? []).map((a) => ({
    userId: a.user_id as string,
    email: emails.get(a.user_id as string) ?? null,
    createdAt: a.created_at as string,
  }));
}

export async function addPlatformAdmin(email: string): Promise<void> {
  const userId = await findUserIdByEmail(email);
  if (!userId) throw new PlatformError("No user with that email. They must sign up or be invited first.");
  const { error } = await db()
    .from("platform_admins").upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });
  if (error) throw new Error(error.message);
}

export async function removePlatformAdmin(actorUserId: string, userId: string): Promise<void> {
  if (actorUserId === userId) throw new PlatformError("You cannot remove yourself as a platform admin.");
  const { data, error } = await db().from("platform_admins").select("user_id");
  if (error) throw new Error(error.message);
  if ((data ?? []).length <= 1) throw new PlatformError("Cannot remove the last platform admin.");
  const { error: delErr } = await db().from("platform_admins").delete().eq("user_id", userId);
  if (delErr) throw new Error(delErr.message);
}

export async function listAudit(limit = 200): Promise<
  { id: string; action: string; accountId: string | null; actorEmail: string | null; details: Record<string, unknown>; createdAt: string }[]
> {
  const { data, error } = await db()
    .from("platform_audit_log")
    .select("id, action, account_id, actor_user_id, details, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  const actorIds = [...new Set((data ?? []).map((r) => r.actor_user_id as string | null).filter((x): x is string => !!x))];
  const emails = await emailsByUserId(actorIds);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    action: r.action as string,
    accountId: (r.account_id as string) ?? null,
    actorEmail: r.actor_user_id ? emails.get(r.actor_user_id as string) ?? null : null,
    details: (r.details as Record<string, unknown>) ?? {},
    createdAt: r.created_at as string,
  }));
}
