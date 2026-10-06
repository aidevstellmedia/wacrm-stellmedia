import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function WorkspaceNotFoundPage() {
  const t = await getTranslations("Workspace");
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold text-foreground">{t("notFoundTitle")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("notFoundBody")}</p>
      </div>
    </main>
  );
}
