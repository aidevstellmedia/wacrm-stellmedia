"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "./guard";
import { readPlatformConfig } from "./config";
import * as tenants from "./tenants";
import { validateBrandingFile, validateCustomDomain, validateEmail, validateSlug } from "./validation";

/** `values` echoes submitted text fields on failure so forms can keep them (files can't be kept). */
export type ActionState = { error: string | null; ok?: boolean; values?: Record<string, string> };

type BrandingFile = { file: File; ext: string } | null;

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
}
function file(fd: FormData, key: string): File | null {
  const v = fd.get(key);
  return v instanceof File ? v : null;
}
function brandingInputs(fd: FormData): { error: string } | { logo: BrandingFile; favicon: BrandingFile } {
  const logo = validateBrandingFile(file(fd, "logo"), "logo");
  if (!logo.ok) return { error: logo.error };
  const fav = validateBrandingFile(file(fd, "favicon"), "favicon");
  if (!fav.ok) return { error: fav.error };
  return {
    logo: logo.file && logo.ext ? { file: logo.file, ext: logo.ext } : null,
    favicon: fav.file && fav.ext ? { file: fav.file, ext: fav.ext } : null,
  };
}
async function run(fn: () => Promise<void>): Promise<ActionState> {
  try {
    await fn();
    return { error: null, ok: true };
  } catch (e) {
    if (e instanceof tenants.PlatformError) return { error: e.message };
    throw e; // includes next/navigation redirect/notFound signals
  }
}
function revalidateClient(accountId: string) {
  revalidatePath("/admin");
  revalidatePath(`/admin/clients/${accountId}`);
}

export async function createClientAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requirePlatformAdmin();
  const values = { companyName: str(fd, "companyName"), slug: str(fd, "slug"), ownerName: str(fd, "ownerName"), ownerEmail: str(fd, "ownerEmail") };
  const companyName = str(fd, "companyName").trim();
  if (!companyName) return { error: "Company name is required.", values };
  const slug = validateSlug(str(fd, "slug"));
  if (!slug.ok) return { error: slug.error, values };
  const email = validateEmail(str(fd, "ownerEmail"));
  if (!email.ok) return { error: email.error, values };
  const files = brandingInputs(fd);
  if ("error" in files) return { error: files.error, values };

  let accountId = "";
  const res = await run(async () => {
    ({ accountId } = await tenants.createTenant({
      companyName, slug: slug.slug, ownerEmail: email.email, ownerName: str(fd, "ownerName").trim(), ...files,
    }));
    await tenants.writeAudit(admin.userId, "tenant.create", accountId, { slug: slug.slug, ownerEmail: email.email });
  });
  if (res.error) return { ...res, values };
  revalidatePath("/admin");
  redirect(`/admin/clients/${accountId}`);
}

export async function completeSetupAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requirePlatformAdmin();
  const values = { companyName: str(fd, "companyName"), slug: str(fd, "slug") };
  const accountId = str(fd, "accountId");
  if (!accountId) return { error: "Missing client.", values };
  const companyName = str(fd, "companyName").trim();
  if (!companyName) return { error: "Company name is required.", values };
  const slug = validateSlug(str(fd, "slug"));
  if (!slug.ok) return { error: slug.error, values };
  const files = brandingInputs(fd);
  if ("error" in files) return { error: files.error, values };

  const res = await run(async () => {
    await tenants.completeTenantSetup(accountId, { companyName, slug: slug.slug, ...files });
    await tenants.writeAudit(admin.userId, "tenant.complete_setup", accountId, { slug: slug.slug });
  });
  if (res.ok) revalidateClient(accountId);
  return res.error ? { ...res, values } : res;
}

export async function updateBrandingAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requirePlatformAdmin();
  const accountId = str(fd, "accountId");
  if (!accountId) return { error: "Missing client." };
  const companyName = str(fd, "companyName").trim();
  if (!companyName) return { error: "Company name is required." };
  const files = brandingInputs(fd);
  if ("error" in files) return { error: files.error };

  const res = await run(async () => {
    await tenants.updateTenantBranding(accountId, { companyName, ...files });
    await tenants.writeAudit(admin.userId, "tenant.update_branding", accountId, {
      companyName, logo: !!files.logo, favicon: !!files.favicon,
    });
  });
  if (res.ok) revalidateClient(accountId);
  return res;
}

export async function setStatusAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requirePlatformAdmin();
  const accountId = str(fd, "accountId");
  if (!accountId) return { error: "Missing client." };
  const status = str(fd, "status");
  if (status !== "active" && status !== "suspended") return { error: "Invalid status." };

  const res = await run(async () => {
    await tenants.setTenantStatus(accountId, status);
    await tenants.writeAudit(admin.userId, status === "suspended" ? "tenant.suspend" : "tenant.reactivate", accountId);
  });
  if (res.ok) revalidateClient(accountId);
  return res;
}

export async function addDomainAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requirePlatformAdmin();
  const values = { hostname: str(fd, "hostname") };
  const accountId = str(fd, "accountId");
  if (!accountId) return { error: "Missing client." };
  const domain = validateCustomDomain(str(fd, "hostname"), readPlatformConfig().baseDomain);
  if (!domain.ok) return { error: domain.error, values };

  const res = await run(async () => {
    await tenants.addTenantDomain(accountId, domain.hostname);
    await tenants.writeAudit(admin.userId, "tenant.domain_add", accountId, { hostname: domain.hostname });
  });
  if (res.ok) revalidateClient(accountId);
  return res.error ? { ...res, values } : res;
}

export async function removeDomainAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requirePlatformAdmin();
  const accountId = str(fd, "accountId");
  const domainId = str(fd, "domainId");
  if (!accountId || !domainId) return { error: "Missing domain." };

  const res = await run(async () => {
    await tenants.removeTenantDomain(accountId, domainId);
    await tenants.writeAudit(admin.userId, "tenant.domain_remove", accountId, { domainId });
  });
  if (res.ok) revalidateClient(accountId);
  return res;
}

export async function resendInviteAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requirePlatformAdmin();
  const accountId = str(fd, "accountId");
  if (!accountId) return { error: "Missing client." };

  const res = await run(async () => {
    await tenants.resendOwnerInvite(accountId);
    await tenants.writeAudit(admin.userId, "tenant.resend_invite", accountId);
  });
  if (res.ok) revalidateClient(accountId);
  return res;
}

export async function deleteUnassignedUserAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requirePlatformAdmin();
  const accountId = str(fd, "accountId");
  if (!accountId) return { error: "Missing account." };

  const res = await run(async () => {
    const { email } = await tenants.deleteUnassignedUser(accountId);
    await tenants.writeAudit(admin.userId, "user.delete_unassigned", null, { accountId, email });
  });
  if (res.ok) revalidatePath("/admin");
  return res;
}

export async function addAdminAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requirePlatformAdmin();
  const email = validateEmail(str(fd, "email"));
  if (!email.ok) return { error: email.error };

  const res = await run(async () => {
    await tenants.addPlatformAdmin(email.email);
    await tenants.writeAudit(admin.userId, "platform.admin_add", null, { email: email.email });
  });
  if (res.ok) revalidatePath("/admin/admins");
  return res;
}

export async function removeAdminAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requirePlatformAdmin();
  const userId = str(fd, "userId");
  if (!userId) return { error: "Missing admin." };

  const res = await run(async () => {
    await tenants.removePlatformAdmin(admin.userId, userId);
    await tenants.writeAudit(admin.userId, "platform.admin_remove", null, { userId });
  });
  if (res.ok) revalidatePath("/admin/admins");
  return res;
}
