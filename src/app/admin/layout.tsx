import { notFound } from "next/navigation";
import { getAdminOrNull } from "@/lib/admin";
import { AdminNav } from "./AdminNav";

// The admin gate is per-request auth — it must never be statically prerendered.
// Without this, a build where ADMIN_EMAIL is absent can bake a static 404 for the
// whole tree (see lib/admin.ts loadAdmin) and serve it to the real admin forever.
// force-dynamic is the belt to loadAdmin's suspenders. Applies to every /admin/*.
export const dynamic = "force-dynamic";

// Server-side guard for the ENTIRE /admin tree. A non-admin (or logged-out)
// visitor gets a plain 404 — the surface never reveals it exists. The dark,
// mono, red-accented chrome is deliberately unlike the user-facing paper theme:
// it signals "internal / privileged".
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await getAdminOrNull();
  if (!admin) notFound();

  return (
    <div className="flex min-h-screen bg-[#0b0c0f] text-[#e6e8eb] [font-feature-settings:'tnum'] selection:bg-[#ff4d4d]/30">
      <AdminNav email={admin.email} />
      <main className="min-w-0 flex-1 overflow-x-auto p-8">{children}</main>
    </div>
  );
}
