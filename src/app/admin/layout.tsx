import { notFound } from "next/navigation";
import { getAdminOrNull } from "@/lib/admin";
import { AdminNav } from "./AdminNav";

// The admin gate is per-request auth — it must never be statically prerendered.
// Without this, a build where ADMIN_EMAIL is absent can bake a static 404 for the
// whole tree (see lib/admin.ts loadAdmin) and serve it to the real admin forever.
// force-dynamic is the belt to loadAdmin's suspenders. Applies to every /admin/*.
export const dynamic = "force-dynamic";

// Server-side guard for the ENTIRE /admin tree. A non-admin (or logged-out)
// visitor gets a plain 404 — the surface never reveals it exists. Chrome shares
// the user-facing paper/vermilion theme so admin reads as the same product; the
// "ADMIN" mark in the nav is what signals "internal / privileged".
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await getAdminOrNull();
  if (!admin) notFound();

  // Column on a phone (top bar above content), row from `lg` (sidebar beside it).
  // `min-w-0` on main is what actually lets the tables' own scroll containers
  // work — without it a wide table stretches the flex item and the whole page
  // scrolls sideways instead.
  return (
    <div className="grid-bg flex min-h-screen flex-col text-foreground [font-feature-settings:'tnum'] selection:bg-brand/30 lg:flex-row">
      <AdminNav email={admin.email} />
      <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
    </div>
  );
}
