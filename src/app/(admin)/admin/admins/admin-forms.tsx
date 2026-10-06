"use client";

import { useActionState } from "react";
import { addAdminAction, removeAdminAction, type ActionState } from "@/lib/platform/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const initial: ActionState = { error: null };

export function AddAdminForm() {
  const [state, formAction, isPending] = useActionState(addAdminAction, initial);
  return (
    <form action={formAction} className="max-w-xl space-y-2">
      <div className="flex gap-2">
        <Input name="email" type="email" placeholder="admin@example.com" required aria-label="Admin email" />
        <Button type="submit" disabled={isPending}>Add admin</Button>
      </div>
      {state.error && <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert>}
      {state.ok && <p className="text-xs text-muted-foreground">Saved</p>}
    </form>
  );
}

export function RemoveAdminForm({ userId }: { userId: string }) {
  const [state, formAction, isPending] = useActionState(removeAdminAction, initial);
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="userId" value={userId} />
      <Button
        type="submit"
        variant="destructive"
        size="sm"
        disabled={isPending}
        onClick={(e) => {
          if (!confirm("Remove this platform admin?")) e.preventDefault();
        }}
      >
        Remove
      </Button>
      {state.error && <span className="text-xs text-destructive">{state.error}</span>}
    </form>
  );
}
