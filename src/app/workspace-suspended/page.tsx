import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function WorkspaceSuspendedPage() {
  const t = await getTranslations("Workspace");
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold text-foreground">{t("suspendedTitle")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("suspendedBody")}</p>
      </div>
    </main>
  );
}
