import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdminOrNull } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { Logo } from "@/components/Brand";

// Post-login fork, shown ONLY to the owner admin. A normal user never reaches
// this — getAdminOrNull returns null for them and we send them straight to the
// app. The owner picks which surface to enter; both stay one click away after
// (admin nav has "← back to app", the dashboard/onboarding show an "Admin" link).
export const dynamic = "force-dynamic";

export default async function ChoosePage() {
  const admin = await getAdminOrNull();
  if (!admin) redirect("/dashboard");

  // Route the "user" card to onboarding when setup isn't done, else the
  // dashboard. "Done" is having a resume, not the status string: the resume is
  // the one thing the whole app is useless without (every match scores against
  // it), the dashboard's upload only appears once a profile row exists, and the
  // onboarding page is the sole always-available upload surface. Keying on
  // status alone stranded an account whose status was anything but "onboarding"
  // yet had no resume — it was sent to a dashboard that then showed nowhere to
  // upload. Onboarding re-hydrates existing preferences, so a finished user who
  // lost their resume lands back here to re-add it without losing settings.
  const row = await prisma.user
    .findUnique({
      where: { id: admin.id },
      select: { status: true, profile: { select: { resumeName: true } } },
    })
    .catch(() => null);
  const needsSetup = row?.status === "onboarding" || !row?.profile?.resumeName;
  const userHref = needsSetup ? "/onboarding" : "/dashboard";

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
            href={userHref}
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
