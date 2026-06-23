"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  ["/admin", "Overview"],
  ["/admin/users", "Users"],
  ["/admin/integrations", "Integrations"],
  ["/admin/audit", "Audit log"],
];

export function AdminNav({ email }: { email: string }) {
  const path = usePathname();
  const isActive = (href: string) =>
    href === "/admin" ? path === "/admin" : path.startsWith(href);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-[#262a33] bg-[#0e1014] p-4">
      <Link href="/admin" className="mb-6 flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded bg-[#ff4d4d] text-sm font-bold text-black">N</span>
        <span className="font-mono text-sm font-bold tracking-tight text-[#e6e8eb]">
          NexPath <span className="text-[#ff4d4d]">ADMIN</span>
        </span>
      </Link>

      <nav className="flex flex-col gap-1">
        {LINKS.map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className={`rounded px-3 py-2 font-mono text-sm transition ${
              isActive(href)
                ? "bg-[#1d2027] text-[#e6e8eb]"
                : "text-[#8b919c] hover:bg-[#15171c] hover:text-[#e6e8eb]"
            }`}
          >
            {label}
          </Link>
        ))}
      </nav>

      <div className="mt-auto border-t border-[#262a33] pt-4">
        <div className="truncate font-mono text-xs text-[#8b919c]" title={email}>
          {email}
        </div>
        <Link href="/dashboard" className="mt-2 inline-block font-mono text-xs text-[#8b919c] hover:text-[#e6e8eb]">
          ← back to app
        </Link>
      </div>
    </aside>
  );
}
