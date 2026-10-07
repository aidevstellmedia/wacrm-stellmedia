// Tenant provisioning and admin data access. Service role throughout —
// every exported function is only reachable via actions.ts, which calls
// requirePlatformAdmin() first.

import { platformAdmin } from "./admin-client";
import { readPlatformConfig, tenantOrigin, tenantSubdomainHost } from "./config";

export class PlatformError extends Error {}

/** The account row is gone but its auth user could not be deleted. */
export class PartialDeleteError extends PlatformError {
  readonly partial = true;
  constructor(readonly accountId: string, readonly ownerUserId: string, readonly cause_: string) {
    super(
      `Account removed, but the login could not be deleted (user ${ownerUserId}). Delete it in Supabase → Authentication.`,
    );
  }
}

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

type AccountKind = "tenant" | "incomplete-client" | "stray" | "admin";

/**
 * Single source of truth for what an account is, used by listTenants,
 * listUnassignedUsers and deleteUnassignedUser so they can never disagree.
 *  - tenant: has a tenant_settings row.
 *  - admin: settings-less account owned by a platform admin (hidden everywhere).
 *  - incomplete-client: settings-less, owner tagged platform_client_owner by createTenant.
 *  - stray: settings-less, untagged, non-admin (e.g. an unused invite signup).
 * Only owners of settings-less, non-admin accounts are looked up in auth.
 */
async function classifyAccounts(
  accounts: { id: string; owner_user_id: string }[],
  settingsIds: Set<string>,
  adminIds: Set<string>,
): Promise<Map<string, AccountKind>> {
  const kinds = new Map<string, AccountKind>();
  await Promise.all(
    accounts.map(async (a) => {
      if (settingsIds.has(a.id)) return void kinds.set(a.id, "tenant");
      if (adminIds.has(a.owner_user_id)) return void kinds.set(a.id, "admin");
      const { data, error } = await db().auth.admin.getUserById(a.owner_user_id);
      if (error) throw new Error(error.message);
      const tagged = data?.user?.user_metadata?.platform_client_owner === true;
      kinds.set(a.id, tagged ? "incomplete-client" : "stray");
    }),
  );
  return kinds;
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
  const adminIds = new Set((admins.data ?? []).map((a) => a.user_id as string));
  const kinds = await classifyAccounts(
    (accounts.data ?? []).map((a) => ({ id: a.id as string, owner_user_id: a.owner_user_id as string })),
    new Set(settingsBy.keys()),
    adminIds,
  );
  // Admin personal accounts and stray signups are not clients.
  const visible = (accounts.data ?? []).filter((a) => {
    const k = kinds.get(a.id);
    return k === "tenant" || k === "incomplete-client";
  });
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

export interface UnassignedUser {
  accountId: string;
  ownerUserId: string;
  email: string | null;
  name: string;
  createdAt: string;
  lastSignInAt: string | null;
}

/** Accounts that are neither clients nor admin-owned: signups that never joined a client. */
export async function listUnassignedUsers(): Promise<UnassignedUser[]> {
  const [accounts, settings, admins] = await Promise.all([
    db().from("accounts").select("id, name, owner_user_id, created_at").order("created_at", { ascending: false }),
    db().from("tenant_settings").select("account_id"),
    db().from("platform_admins").select("user_id"),
  ]);
  for (const r of [accounts, settings, admins]) if (r.error) throw new Error(r.error.message);
  const rows = (accounts.data ?? []).map((a) => ({
    id: a.id as string, name: a.name as string, owner_user_id: a.owner_user_id as string, created_at: a.created_at as string,
  }));
  const kinds = await classifyAccounts(
    rows,
    new Set((settings.data ?? []).map((s) => s.account_id as string)),
    new Set((admins.data ?? []).map((a) => a.user_id as string)),
  );
  const strays = rows.filter((a) => kinds.get(a.id) === "stray");
  const emails = await emailsByUserId(strays.map((a) => a.owner_user_id));
  return Promise.all(
    strays.map(async (a) => {
      const { data, error } = await db().auth.admin.getUserById(a.owner_user_id);
      if (error) throw new Error(error.message);
      return {
        accountId: a.id,
        ownerUserId: a.owner_user_id,
        email: emails.get(a.owner_user_id) ?? null,
        name: a.name,
        createdAt: a.created_at,
        lastSignInAt: data?.user?.last_sign_in_at ?? null,
      };
    }),
  );
}

// The table list redeem_invitation (019) uses, plus later account-scoped tables
// (api_keys 026, webhook_endpoints 028, ai_configs 029, ai_knowledge_documents 030,
// quick_replies 035, deals 001). Pure log tables (ai_usage_log) and chunks (cascade
// from documents) are skipped. Pending invitations are checked separately.
const DATA_TABLES = [
  "contacts", "conversations", "broadcasts", "automations", "flows", "pipelines",
  "message_templates", "tags", "custom_fields", "contact_notes", "whatsapp_config",
  "api_keys", "webhook_endpoints", "quick_replies", "deals", "ai_configs", "ai_knowledge_documents",
] as const;

export async function deleteUnassignedUser(accountId: string): Promise<{ email: string | null }> {
  const clientErr = () => new PlatformError("This account belongs to a client and can't be deleted here.");
  const { data: acct, error: acctErr } = await db()
    .from("accounts").select("id, owner_user_id").eq("id", accountId).maybeSingle();
  if (acctErr) throw new Error(acctErr.message);
  if (!acct) throw new PlatformError("Account not found.");
  const ownerUserId = acct.owner_user_id as string;

  const [settings, admin] = await Promise.all([
    db().from("tenant_settings").select("account_id").eq("account_id", accountId).maybeSingle(),
    db().from("platform_admins").select("user_id").eq("user_id", ownerUserId).maybeSingle(),
  ]);
  if (settings.error) throw new Error(settings.error.message);
  if (admin.error) throw new Error(admin.error.message);
  const kinds = await classifyAccounts(
    [{ id: accountId, owner_user_id: ownerUserId }],
    new Set(settings.data ? [accountId] : []),
    new Set(admin.data ? [ownerUserId] : []),
  );
  if (kinds.get(accountId) !== "stray") throw clientErr();

  const { data: profs, error: profErr } = await db()
    .from("profiles").select("user_id, email").eq("account_id", accountId);
  if (profErr) throw new Error(profErr.message);
  if ((profs ?? []).length !== 1) throw new PlatformError("This account has other members and can't be deleted.");

  const found = await Promise.all([
    ...DATA_TABLES.map((t) => db().from(t).select("account_id").eq("account_id", accountId).limit(1)),
    // Pending outgoing invitations count as data.
    db().from("account_invitations").select("account_id").eq("account_id", accountId).is("accepted_at", null).limit(1),
  ]);
  for (const r of found) if (r.error) throw new Error(r.error.message);
  if (found.some((r) => (r.data ?? []).length > 0)) throw new PlatformError("This account has data and can't be deleted.");

  // Re-check right before deleting (membership may have changed since the first read).
  const { data: again, error: againErr } = await db().from("profiles").select("user_id").eq("account_id", accountId);
  if (againErr) throw new Error(againErr.message);
  if ((again ?? []).length !== 1 || again![0].user_id !== ownerUserId) {
    throw new PlatformError("This account changed while deleting; refresh and try again.");
  }

  // Account first: accounts.owner_user_id is ON DELETE RESTRICT, so the auth
  // user can't go while the account exists. Deleting the account cascades the
  // profile row (profiles.account_id ON DELETE CASCADE). Then delete the auth user.
  const { error: delAcctErr } = await db().from("accounts").delete().eq("id", accountId);
  if (delAcctErr) throw new Error(delAcctErr.message);
  const { error: delUserErr } = await db().auth.admin.deleteUser(ownerUserId);
  if (delUserErr) throw new PartialDeleteError(accountId, ownerUserId, delUserErr.message);
  return { email: (profs![0].email as string) ?? null };
}

const ROLE_ORDER = ["owner", "admin", "agent", "viewer"];

export async function listTenantMembers(accountId: string): Promise<
  { userId: string; email: string | null; fullName: string | null; role: string; lastSignInAt: string | null }[]
> {
  // Capped at 200 members; fine at this scale (one auth lookup per member).
  const { data, error } = await db()
    .from("profiles")
    .select("user_id, email, full_name, account_role")
    .eq("account_id", accountId)
    .order("account_role")
    .order("email")
    .limit(200);
  if (error) throw new Error(error.message);
  const rank = (r: string) => {
    const i = ROLE_ORDER.indexOf(r);
    return i === -1 ? ROLE_ORDER.length : i;
  };
  const sorted = [...(data ?? [])].sort(
    (a, b) =>
      rank(a.account_role as string) - rank(b.account_role as string) ||
      String(a.email ?? "").localeCompare(String(b.email ?? "")),
  );
  return Promise.all(
    sorted.map(async (p) => {
      const { data: u, error: uErr } = await db().auth.admin.getUserById(p.user_id as string);
      if (uErr) throw new Error(uErr.message);
      return {
        userId: p.user_id as string,
        email: (p.email as string) ?? null,
        fullName: (p.full_name as string) || null,
        role: p.account_role as string,
        lastSignInAt: u?.user?.last_sign_in_at ?? null,
      };
    }),
  );
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
    data: { full_name: input.ownerName, platform_client_owner: true },
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
