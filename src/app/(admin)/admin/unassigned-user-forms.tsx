"use client";

import { useActionState, useState } from "react";
import { deleteUnassignedUserAction, type ActionState } from "@/lib/platform/actions";
import { Button } from "@/components/ui/button";

const initial: ActionState = { error: null };

export function DeleteUnassignedUserForm({ accountId }: { accountId: string }) {
  const [state, formAction, isPending] = useActionState(deleteUnassignedUserAction, initial);
  const [confirming, setConfirming] = useState(false);
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="accountId" value={accountId} />
      {confirming ? (
        <>
          <Button type="submit" variant="destructive" size="sm" disabled={isPending}>Confirm delete</Button>
          <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <Button type="button" variant="destructive" size="sm" onClick={() => setConfirming(true)}>Delete</Button>
      )}
      {state.error && <span className="text-xs text-destructive">{state.error}</span>}
    </form>
  );
}
