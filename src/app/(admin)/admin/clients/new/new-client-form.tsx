"use client";

import { useActionState, useState } from "react";
import { createClientAction, type ActionState } from "@/lib/platform/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initial: ActionState = { error: null };

function suggestSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export function NewClientForm({ baseDomain }: { baseDomain: string | null }) {
  const [state, formAction, isPending] = useActionState(createClientAction, initial);
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="companyName">Company name</Label>
        <Input
          id="companyName"
          name="companyName"
          required
          onChange={(e) => {
            if (!slugEdited) setSlug(suggestSlug(e.target.value));
          }}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="slug">Slug</Label>
        <Input
          id="slug"
          name="slug"
          required
          value={slug}
          onChange={(e) => {
            setSlugEdited(true);
            setSlug(e.target.value);
          }}
        />
        {baseDomain && (
          <p className="text-xs text-muted-foreground">{slug || "slug"}.{baseDomain}</p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ownerName">Owner name</Label>
        <Input id="ownerName" name="ownerName" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ownerEmail">Owner email</Label>
        <Input id="ownerEmail" name="ownerEmail" type="email" required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="logo">Logo (PNG, WebP or JPEG, max 512 KB)</Label>
        <Input id="logo" name="logo" type="file" accept="image/png,image/webp,image/jpeg" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="favicon">Favicon (PNG or ICO, max 128 KB)</Label>
        <Input id="favicon" name="favicon" type="file" accept="image/png,image/x-icon" />
      </div>
      {state.error && (
        <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert>
      )}
      <Button type="submit" disabled={isPending}>{isPending ? "Creating…" : "Create client"}</Button>
    </form>
  );
}
