import { notFound } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/platform/guard";
import { format } from "date-fns";
import { getTenantDetail, listTenantMembers } from "@/lib/platform/tenants";
import { readPlatformConfig, tenantOrigin } from "@/lib/platform/config";
import { brandingAssetUrl } from "@/lib/platform/branding";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AddDomainForm,
  BrandingForm,
  CompleteSetupForm,
  RemoveDomainForm,
  ResendInviteForm,
  StatusForm,
} from "./client-forms";

// Defeats CDN/browser caching of freshly uploaded branding assets.
function cacheBuster(): string {
  return Date.now().toString();
}

export default async function ClientDetailPage({ params }: { params: Promise<{ accountId: string }> }) {
  await requirePlatformAdmin();
  const { accountId } = await params;
  const detail = await getTenantDetail(accountId);
  if (!detail) notFound();
  const members = await listTenantMembers(accountId);

  const { row, domains, ownerEmail } = detail;
  const cfg = readPlatformConfig();
  const baseDomain = cfg.baseDomain;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const version = cacheBuster();
  const logoUrl = brandingAssetUrl(supabaseUrl, detail.logoPath, version);
  const faviconUrl = brandingAssetUrl(supabaseUrl, detail.faviconPath, version);
  const address = row.slug ? tenantOrigin(cfg, row.slug) : null;

  return (
    <div className="space-y-8">
      <section className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-foreground">{row.name}</h1>
          <Badge variant={row.status === "active" ? "default" : row.status === "suspended" ? "destructive" : "secondary"}>
            {row.status}
          </Badge>
        </div>
        {address && (
          <a href={address} target="_blank" rel="noreferrer" className="text-sm text-primary hover:underline">
            {address}
          </a>
        )}
        <p className="text-sm text-muted-foreground">Owner: {ownerEmail ?? "—"}</p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">{row.status === "incomplete" ? "Complete setup" : "Branding"}</h2>
        {row.status !== "incomplete" && (
          <div className="flex items-center gap-4">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <span className="inline-flex rounded-md bg-white px-1.5 py-1">
                <img src={logoUrl} alt="Logo" className="h-12 max-w-40 object-contain" />
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">No logo</span>
            )}
            {faviconUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <span className="inline-flex rounded-md bg-white px-1.5 py-1">
                <img src={faviconUrl} alt="Favicon" className="size-8 object-contain" />
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">No favicon</span>
            )}
          </div>
        )}
        {row.status === "incomplete" ? (
          <CompleteSetupForm accountId={accountId} companyName={row.name} />
        ) : (
          <BrandingForm accountId={accountId} companyName={row.name} />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Domains</h2>
        <ul className="space-y-2">
          {domains.map((d) => (
            <li key={d.id} className="flex items-center gap-3 text-sm">
              <span>{d.hostname}</span>
              <Badge variant="outline">{d.kind}</Badge>
              <RemoveDomainForm accountId={accountId} domainId={d.id} />
            </li>
          ))}
          {domains.length === 0 && <li className="text-sm text-muted-foreground">No domains.</li>}
        </ul>
        <AddDomainForm accountId={accountId} />
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>Point a CNAME for this hostname at <code>{baseDomain ?? "the platform domain"}</code> (or an A record at the server IP).</li>
          <li>In Nginx Proxy Manager add a Proxy Host for it → app container, and request a Let&apos;s Encrypt certificate.</li>
          <li>Add <code>https://&lt;hostname&gt;/**</code> to Supabase → Authentication → URL Configuration → Redirect URLs.</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Team members ({members.length})</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Last sign-in</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => (
              <TableRow key={m.userId}>
                <TableCell>{m.email ?? "—"}</TableCell>
                <TableCell>{m.fullName ?? "—"}</TableCell>
                <TableCell><Badge variant="outline">{m.role}</Badge></TableCell>
                <TableCell>{m.lastSignInAt ? format(new Date(m.lastSignInAt), "yyyy-MM-dd HH:mm") : "Never"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Owner invite</h2>
        <ResendInviteForm accountId={accountId} />
      </section>

      {row.status !== "incomplete" && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-destructive">Danger zone</h2>
          <StatusForm accountId={accountId} suspended={row.status === "suspended"} />
        </section>
      )}
    </div>
  );
}
