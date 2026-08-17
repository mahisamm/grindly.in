import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/auth";
import { daysRemaining, effectivePlan, limitsFor } from "@/lib/plans";
import { usageToday } from "@/lib/quota";
import { DeleteAccount } from "./DeleteAccount";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account — Grindly" };

export default async function SettingsPage() {
  const user = await currentUser();
  if (!user) return null;

  const [counts, usage] = await Promise.all([
    prisma.resume.count({ where: { userId: user.id } }),
    usageToday(user.id),
  ]);
  const plan = effectivePlan(user);
  const limits = limitsFor(user);
  const left = daysRemaining(user);

  return (
    <div className="mx-auto max-w-3xl px-5 py-8 sm:px-6 sm:py-10">
      <Link href="/app" className="text-muted hover:text-ink text-sm">
        ← All resumes
      </Link>
      <h1 className="font-display mt-4 text-3xl font-bold">Account</h1>

      <section className="bg-surface border-border mt-8 rounded-xl border p-6">
        <h2 className="font-display text-lg font-semibold">You</h2>
        <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted">Email</dt>
          <dd>{user.email}</dd>
          <dt className="text-muted">Plan</dt>
          <dd>
            {plan === "pass" ? `Season Pass · ${left} day${left === 1 ? "" : "s"} left` : "Free"}
            {plan === "free" && (
              <>
                {" · "}
                <Link href="/pricing" className="text-brand underline">upgrade</Link>
              </>
            )}
          </dd>
          <dt className="text-muted">Resumes</dt>
          <dd className="tabular-nums">{counts} of {limits.resumes}</dd>
          <dt className="text-muted">Rewrites today</dt>
          <dd className="tabular-nums">
            {usage.variantRuns.used} of {usage.variantRuns.limit}
          </dd>
          <dt className="text-muted">Reviews today</dt>
          <dd className="tabular-nums">
            {usage.adviceRuns.used} of {usage.adviceRuns.limit}
          </dd>
        </dl>

        {/* Sign out lives here as well as in the desktop header, because below
            `lg` that header is only the wordmark and the plan — the rest of the
            navigation moved to the bottom bar, and a bottom bar is for
            destinations, not for an action that ends the session. */}
        <form action="/api/logout" method="post" className="mt-6">
          <button type="submit" className="btn w-full justify-center sm:w-auto">
            Sign out
          </button>
        </form>
      </section>

      {user.role === "admin" && (
        <section className="bg-surface border-border mt-6 rounded-xl border p-6">
          <h2 className="font-display text-lg font-semibold">Admin</h2>
          <p className="text-muted mt-2 text-sm">
            You have an admin account on this server.
          </p>
          <Link href="/admin" className="btn mt-4 inline-flex">
            Open the admin page
          </Link>
        </section>
      )}

      <section className="bg-surface mt-6 rounded-xl border p-6" style={{ borderColor: "#a3271b" }}>
        <h2 className="font-display text-lg font-semibold">Delete your account</h2>
        <p className="text-muted mt-2 text-sm leading-relaxed">
          This removes your account, every resume you have uploaded, every rebuilt
          PDF, and every score. It happens immediately and it cannot be undone —
          there is no backup we can restore you from.
        </p>
        <DeleteAccount email={user.email} />
      </section>
    </div>
  );
}
