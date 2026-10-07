import Link from "next/link";
import { format } from "date-fns";
import { requirePlatformAdmin } from "@/lib/platform/guard";
import { listTenants, listUnassignedUsers } from "@/lib/platform/tenants";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { DeleteUnassignedUserForm } from "./unassigned-user-forms";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default async function ClientsPage() {
  await requirePlatformAdmin();
  const [rows, strays] = await Promise.all([listTenants(), listUnassignedUsers()]);
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
      {strays.length > 0 && (
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer text-sm font-semibold text-foreground">
            Users not in any client ({strays.length})
          </summary>
          <p className="my-3 text-sm text-muted-foreground">
            People who signed up but never joined a client, usually an unused invite signup.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Signed up</TableHead>
                <TableHead>Last sign-in</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {strays.map((u) => (
                <TableRow key={u.accountId}>
                  <TableCell>{u.email ?? "—"}</TableCell>
                  <TableCell>{u.name}</TableCell>
                  <TableCell>{format(new Date(u.createdAt), "yyyy-MM-dd")}</TableCell>
                  <TableCell>{u.lastSignInAt ? format(new Date(u.lastSignInAt), "yyyy-MM-dd HH:mm") : "Never"}</TableCell>
                  <TableCell><DeleteUnassignedUserForm accountId={u.accountId} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </details>
      )}
    </div>
  );
}
