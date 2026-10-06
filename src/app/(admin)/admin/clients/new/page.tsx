import { requirePlatformAdmin } from "@/lib/platform/guard";
import { readPlatformConfig } from "@/lib/platform/config";
import { NewClientForm } from "./new-client-form";

export default async function NewClientPage() {
  await requirePlatformAdmin();
  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-lg font-semibold text-foreground">New client</h1>
      <NewClientForm baseDomain={readPlatformConfig().baseDomain} />
    </div>
  );
}
