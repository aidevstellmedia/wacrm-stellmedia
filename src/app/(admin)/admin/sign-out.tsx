"use client";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

export function AdminSignOut() {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        await createClient().auth.signOut();
        window.location.href = "/login";
      }}
    >
      Sign out
    </Button>
  );
}
