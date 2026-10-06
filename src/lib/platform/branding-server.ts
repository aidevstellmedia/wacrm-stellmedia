import { cache } from "react";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { resolveBranding, type TenantBranding } from "./branding";
import { readPlatformConfig } from "./config";
import { lookupTenant } from "./tenant-lookup";
import { TENANT_HEADER_HOST } from "./tenant-routing";

/** Branding for the current request (server only). The host header is trusted
 *  only because middleware strips and re-sets it (see tenant-routing.ts). */
export const getTenantBranding = cache(async (): Promise<TenantBranding> => {
  const cfg = readPlatformConfig();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const host = (await headers()).get(TENANT_HEADER_HOST);
  return resolveBranding(
    host,
    async (h) => lookupTenant(await createClient(), h),
    cfg,
    supabaseUrl,
  );
});
