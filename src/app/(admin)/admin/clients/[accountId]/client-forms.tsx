"use client";

import { useActionState } from "react";
import {
  addDomainAction,
  completeSetupAction,
  removeDomainAction,
  resendInviteAction,
  setStatusAction,
  updateBrandingAction,
  type ActionState,
} from "@/lib/platform/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initial: ActionState = { error: null };

function Feedback({ state }: { state: ActionState }) {
  if (state.error) {
    return <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert>;
  }
  if (state.ok) return <p className="text-xs text-muted-foreground">Saved</p>;
  return null;
}

function FileFields() {
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="logo">Logo (PNG, WebP or JPEG, max 512 KB)</Label>
        <Input id="logo" name="logo" type="file" accept="image/png,image/webp,image/jpeg" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="favicon">Favicon (PNG or ICO, max 128 KB)</Label>
        <Input id="favicon" name="favicon" type="file" accept="image/png,image/x-icon" />
      </div>
    </>
  );
}

export function CompleteSetupForm({ accountId, companyName }: { accountId: string; companyName: string }) {
  const [state, formAction, isPending] = useActionState(completeSetupAction, initial);
  return (
    <form action={formAction} className="max-w-xl space-y-4">
      <input type="hidden" name="accountId" value={accountId} />
      <div className="space-y-1.5">
        <Label htmlFor="companyName">Company name</Label>
        <Input id="companyName" name="companyName" defaultValue={companyName} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="slug">Slug</Label>
        <Input id="slug" name="slug" required />
      </div>
      <FileFields />
      <Feedback state={state} />
      <Button type="submit" disabled={isPending}>Complete setup</Button>
    </form>
  );
}

export function BrandingForm({ accountId, companyName }: { accountId: string; companyName: string }) {
  const [state, formAction, isPending] = useActionState(updateBrandingAction, initial);
  return (
    <form action={formAction} className="max-w-xl space-y-4">
      <input type="hidden" name="accountId" value={accountId} />
      <div className="space-y-1.5">
        <Label htmlFor="companyName">Company name</Label>
        <Input id="companyName" name="companyName" defaultValue={companyName} required />
      </div>
      <FileFields />
      <Feedback state={state} />
      <Button type="submit" disabled={isPending}>Save branding</Button>
    </form>
  );
}

export function AddDomainForm({ accountId }: { accountId: string }) {
  const [state, formAction, isPending] = useActionState(addDomainAction, initial);
  return (
    <form action={formAction} className="max-w-xl space-y-2">
      <input type="hidden" name="accountId" value={accountId} />
      <div className="flex gap-2">
        <Input name="hostname" placeholder="crm.acme.com" required aria-label="Custom domain" />
        <Button type="submit" disabled={isPending}>Add domain</Button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function RemoveDomainForm({ accountId, domainId }: { accountId: string; domainId: string }) {
  const [state, formAction, isPending] = useActionState(removeDomainAction, initial);
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="domainId" value={domainId} />
      <Button
        type="submit"
        variant="destructive"
        size="sm"
        disabled={isPending}
        onClick={(e) => {
          if (!confirm("Remove this domain?")) e.preventDefault();
        }}
      >
        Remove
      </Button>
      {state.error && <span className="text-xs text-destructive">{state.error}</span>}
    </form>
  );
}

export function ResendInviteForm({ accountId }: { accountId: string }) {
  const [state, formAction, isPending] = useActionState(resendInviteAction, initial);
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="accountId" value={accountId} />
      <Button type="submit" variant="outline" disabled={isPending}>Resend owner invite</Button>
      <Feedback state={state} />
    </form>
  );
}

export function StatusForm({ accountId, suspended }: { accountId: string; suspended: boolean }) {
  const [state, formAction, isPending] = useActionState(setStatusAction, initial);
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="status" value={suspended ? "active" : "suspended"} />
      <Button
        type="submit"
        variant={suspended ? "outline" : "destructive"}
        disabled={isPending}
        onClick={(e) => {
          const msg = suspended ? "Reactivate this client?" : "Suspend this client? Their workspace will be paused.";
          if (!confirm(msg)) e.preventDefault();
        }}
      >
        {suspended ? "Reactivate" : "Suspend"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}
