import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { platformAdmin } from "./admin-client";
import { readPlatformConfig } from "./config";
import { requestHostname } from "./hostname";

/** Gate for every admin page AND every admin server action. 404 (not
 *  403) so the admin panel's existence isn't advertised on client hosts. */
export async function requirePlatformAdmin(): Promise<{ userId: string; email: string | null }> {
  const cfg = readPlatformConfig();
  const host = requestHostname(await headers());
  if (!cfg.adminHostname || host !== cfg.adminHostname) notFound();

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data, error } = await platformAdmin().from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (error) {
    console.error("Failed to check platform admin status:", error);
    notFound();
  }
  if (!data) notFound();

  return { userId: user.id, email: user.email ?? null };
}
