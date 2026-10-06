"use client";

import { createContext, useContext, type ReactNode } from "react";
import { MessageSquare } from "lucide-react";
import type { TenantBranding } from "./branding";

const BrandingContext = createContext<TenantBranding>({
  displayName: "Stell Media CRM",
  logoUrl: null,
  faviconUrl: null,
  signupEnabled: true,
});

export function BrandingProvider({ value, children }: { value: TenantBranding; children: ReactNode }) {
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): TenantBranding {
  return useContext(BrandingContext);
}

/** Tenant logo, or the default chat mark on a primary tile. */
export function BrandMark({ size = "sm" }: { size?: "sm" | "lg" }) {
  const { logoUrl, displayName } = useBranding();
  const box = size === "lg" ? "h-12 w-12" : "h-8 w-8";
  if (logoUrl) {
    // Logos are often wide wordmarks (e.g. Stell Media's is ~3.6:1), so fix
    // the height and let the width follow, capped.
    const h = size === "lg" ? "h-12 max-w-[240px]" : "h-8 max-w-[180px]";
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary storage host, tiny image
    return <img src={logoUrl} alt={displayName} className={`${h} w-auto object-contain`} />;
  }
  return (
    <div className={`flex ${box} items-center justify-center rounded-lg bg-primary text-primary-foreground`}>
      <MessageSquare className={size === "lg" ? "h-6 w-6" : "h-4 w-4"} />
    </div>
  );
}
