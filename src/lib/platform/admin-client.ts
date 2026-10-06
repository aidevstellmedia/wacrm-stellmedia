import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Service-role client for platform code (admin panel, tenant status,
// cross-tenant guards). Same lazy pattern as src/lib/automations/admin-client.ts.
let _client: SupabaseClient | null = null;

export function platformAdmin(): SupabaseClient {
  if (!_client) {
    _client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _client;
}
