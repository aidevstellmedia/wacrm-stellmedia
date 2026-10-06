import Link from "next/link";
import { format } from "date-fns";
import { requirePlatformAdmin } from "@/lib/platform/guard";
import { listTenants } from "@/lib/platform/tenants";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default async function ClientsPage() {
  await requirePlatformAdmin();
  const rows = await listTenants();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-foreground">Clients</h1>
        <Link href="/admin/clients/new" className={buttonVariants()}>New client</Link>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Address</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Members</TableHead>
            <TableHead>WhatsApp</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.accountId}>
              <TableCell>
                <Link href={`/admin/clients/${r.accountId}`} className="font-medium hover:underline">{r.name}</Link>
                {r.status === "incomplete" && (
                  <Link href={`/admin/clients/${r.accountId}`} className="ml-2 text-xs text-primary hover:underline">
                    Complete setup
                  </Link>
                )}
              </TableCell>
              <TableCell>{r.domains[0] ?? "—"}</TableCell>
              <TableCell>
                <Badge variant={r.status === "active" ? "default" : r.status === "suspended" ? "destructive" : "secondary"}>
                  {r.status}
                </Badge>
              </TableCell>
              <TableCell>{r.memberCount}</TableCell>
              <TableCell>{r.whatsappConnected ? "Connected" : "—"}</TableCell>
              <TableCell>{format(new Date(r.createdAt), "yyyy-MM-dd")}</TableCell>
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground">No clients yet.</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
