import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdminOrNull } from "@/lib/admin";
import { Logo } from "@/components/Brand";

// Post-login fork, shown ONLY to the owner admin. A normal user never reaches
// this — getAdminOrNull returns null for them and we send them straight to the
// app. The owner picks which surface to enter; both stay one click away after
// (admin nav has "← back to app", the dashboard has an "Admin" switch link).
export const dynamic = "force-dynamic";

export default async function ChoosePage() {
  const admin = await getAdminOrNull();
  if (!admin) redirect("/dashboard");

  return (
    <main className="grid-bg flex min-h-screen items-center justify-center px-5">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Logo size={34} />
          <h1 className="font-display mt-5 text-3xl font-black tracking-tight text-foreground">
            Welcome back, <span className="accent-italic">{admin.name || "admin"}</span>
          </h1>
          <p className="mt-2 text-sm text-muted">Signed in as {admin.email}. How do you want to enter?</p>
        </div>

        <div className="grid gap-4">
          <Link
            href="/dashboard"
            className="sticker group block rounded-2xl border border-border bg-surface p-5 transition"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-display text-lg font-bold text-foreground">Continue as user</div>
                <p className="mt-0.5 text-sm text-muted">Your own dashboard — profile, matches, applications.</p>
              </div>
              <span className="text-2xl text-brand transition group-hover:translate-x-0.5">→</span>
            </div>
          </Link>

          <Link
            href="/admin"
            className="sticker group block rounded-2xl border border-border bg-surface p-5 transition"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-display text-lg font-bold text-foreground">
                  Open admin console <span className="text-brand italic">·</span>
                </div>
                <p className="mt-0.5 text-sm text-muted">Users, access, analytics, agent health, settings.</p>
              </div>
              <span className="text-2xl text-brand transition group-hover:translate-x-0.5">→</span>
            </div>
          </Link>
        </div>
      </div>
    </main>
  );
}
