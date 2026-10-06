import Link from "next/link";
import { format } from "date-fns";
import { requirePlatformAdmin } from "@/lib/platform/guard";
import { listAudit } from "@/lib/platform/tenants";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default async function AuditPage() {
  await requirePlatformAdmin();
  const rows = await listAudit();
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-foreground">Audit log</h1>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Client</TableHead>
            <TableHead>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const json = JSON.stringify(r.details);
            return (
              <TableRow key={r.id}>
                <TableCell className="whitespace-nowrap">{format(new Date(r.createdAt), "yyyy-MM-dd HH:mm")}</TableCell>
                <TableCell>{r.actorEmail ?? "—"}</TableCell>
                <TableCell>{r.action}</TableCell>
                <TableCell>
                  {r.accountId ? (
                    <Link href={`/admin/clients/${r.accountId}`} className="font-mono text-xs hover:underline">
                      {r.accountId.slice(0, 8)}
                    </Link>
                  ) : "—"}
                </TableCell>
                <TableCell>
                  <code className="text-xs" title={json}>{json.length > 80 ? `${json.slice(0, 80)}…` : json}</code>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
