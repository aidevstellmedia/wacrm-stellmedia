import { format } from "date-fns";
import { requirePlatformAdmin } from "@/lib/platform/guard";
import { listPlatformAdmins } from "@/lib/platform/tenants";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AddAdminForm, RemoveAdminForm } from "./admin-forms";

export default async function AdminsPage() {
  await requirePlatformAdmin();
  const admins = await listPlatformAdmins();
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-foreground">Platform admins</h1>
      <AddAdminForm />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Email</TableHead>
            <TableHead>Added</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {admins.map((a) => (
            <TableRow key={a.userId}>
              <TableCell>{a.email ?? a.userId}</TableCell>
              <TableCell>{format(new Date(a.createdAt), "yyyy-MM-dd")}</TableCell>
              <TableCell><RemoveAdminForm userId={a.userId} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
