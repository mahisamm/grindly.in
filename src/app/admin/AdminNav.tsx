"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/Brand";

const LINKS = [
  ["/admin", "Overview"],
  ["/admin/analytics", "Analytics"],
  ["/admin/access", "Access"],
  ["/admin/agent-health", "Agent health"],
  ["/admin/applications", "Applications"],
  ["/admin/users", "Users"],
  ["/admin/integrations", "Integrations"],
  ["/admin/audit", "Audit log"],
  ["/admin/settings", "Settings"],
];

export function AdminNav({ email }: { email: string }) {
  const path = usePathname();
  const isActive = (href: string) =>
    href === "/admin" ? path === "/admin" : path.startsWith(href);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface/70 p-4 backdrop-blur">
      <Link href="/admin" className="mb-6 flex items-center gap-2">
        <Logo size={26} withWordmark={false} />
        <span className="font-display text-base font-bold tracking-tight text-foreground">
          Grindly <span className="text-brand italic">ADMIN</span>
        </span>
      </Link>

      <nav className="flex flex-col gap-1">
        {LINKS.map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className={`rounded-lg px-3 py-2 font-sans text-sm transition ${
              isActive(href)
                ? "bg-brand/10 font-medium text-brand"
                : "text-muted hover:bg-surface-2 hover:text-foreground"
            }`}
          >
            {label}
          </Link>
        ))}
      </nav>

      <div className="mt-auto border-t border-border pt-4">
        <div className="truncate font-sans text-xs text-muted" title={email}>
          {email}
        </div>
        <Link href="/dashboard" className="mt-2 inline-block font-sans text-xs text-muted hover:text-foreground">
          ← back to app
        </Link>
      </div>
    </aside>
  );
}
