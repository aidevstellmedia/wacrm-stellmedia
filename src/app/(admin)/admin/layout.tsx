import Link from "next/link";
import type { Metadata } from "next";
import { requirePlatformAdmin } from "@/lib/platform/guard";
import { AdminSignOut } from "./sign-out";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requirePlatformAdmin();
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <span className="text-sm font-semibold text-foreground">Platform admin</span>
          <nav className="flex gap-4 text-sm text-muted-foreground">
            <Link href="/admin" className="hover:text-foreground">Clients</Link>
            <Link href="/admin/admins" className="hover:text-foreground">Admins</Link>
            <Link href="/admin/audit" className="hover:text-foreground">Audit log</Link>
          </nav>
          <span className="ml-auto text-xs text-muted-foreground">{admin.email}</span>
          <AdminSignOut />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
