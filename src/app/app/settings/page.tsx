import Link from "next/link";
import { FeedbackButton } from "@/components/FeedbackButton";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/auth";
import { daysRemaining, effectivePlan, formatLimit, limitsFor } from "@/lib/plans";
import { usageToday } from "@/lib/quota";
import { DeleteAccount } from "./DeleteAccount";
import { ChangePassword, EmailSettings, ExportData } from "./AccountForms";
import { ThemeToggle } from "@/components/ThemeToggle";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account — Grindly" };

export default async function SettingsPage() {
  const user = await currentUser();
  if (!user) return null;

  const [counts, usage, credentials] = await Promise.all([
    prisma.resume.count({ where: { userId: user.id } }),
    usageToday(user.id),
    // Whether this account has a password at all decides what the forms below
    // can offer: a Google-only account has nothing to change and must not be
    // shown a field implying it does.
    prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true, emailVerifiedAt: true },
    }),
  ]);
  const googleOnly = !credentials?.passwordHash;
  const plan = effectivePlan(user);
  const limits = limitsFor(user);
  const left = daysRemaining(user);

  return (
    <div className="mx-auto max-w-3xl px-5 py-8 sm:px-6 sm:py-10">
      <Link
        href="/app"
        // min-h-6 + inline-flex: a standalone navigation link needs a target a
        // thumb can hit. WCAG 2.2 exempts links inside a sentence; this is not
        // one, it is the only way back on a phone.
        className="text-muted hover:text-ink inline-flex min-h-6 items-center text-sm"
      >
        ← Dashboard
      </Link>
      <h1 className="font-display mt-4 text-3xl font-bold">Account</h1>

      <section className="bg-surface border-border mt-8 rounded-xl border p-6">
        <h2 className="font-display text-lg font-semibold">You</h2>
        <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted">Email</dt>
          <dd>{user.email}</dd>
          <dt className="text-muted">Plan</dt>
          <dd>
            {plan === "admin"
              ? "Admin · no limits"
              : plan === "pass"
                ? `Season Pass · ${left} day${left === 1 ? "" : "s"} left`
                : plan === "pack"
                  ? "Company pack"
                  : "Free"}
            {plan === "free" && (
              <>
                {" · "}
                <Link
                  href="/pricing"
                  className="text-brand inline-flex min-h-6 items-center underline"
                >
                  upgrade
                </Link>
              </>
            )}
          </dd>
          <dt className="text-muted">Resumes</dt>
          <dd className="tabular-nums">{counts} of {formatLimit(limits.resumes)}</dd>
          {/* The label states the WINDOW: a free account's allowance is
              lifetime (nothing resets at midnight — that is the pricing
              model), while paid tiers count per day. A row reading "today"
              beside a refusal about a total would look like a bug. */}
          <dt className="text-muted">
            Rewrites{usage.variantRuns.lifetime ? " (free total)" : " today"}
          </dt>
          <dd className="tabular-nums">
            {usage.variantRuns.used} of {formatLimit(usage.variantRuns.limit)}
          </dd>
          <dt className="text-muted">
            Reviews{usage.adviceRuns.lifetime ? " (free total)" : " today"}
          </dt>
          <dd className="tabular-nums">
            {usage.adviceRuns.used} of {formatLimit(usage.adviceRuns.limit)}
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

      <section className="bg-surface border-border mt-6 rounded-xl border p-6">
        <h2 className="font-display text-lg font-semibold">Email address</h2>
        <EmailSettings
          email={user.email}
          verified={Boolean(credentials?.emailVerifiedAt)}
          googleOnly={googleOnly}
        />
      </section>

      <section className="bg-surface border-border mt-6 rounded-xl border p-6">
        <h2 className="font-display text-lg font-semibold">Password</h2>
        <ChangePassword googleOnly={googleOnly} />
      </section>

      <section className="bg-surface border-border mt-6 rounded-xl border p-6">
        <h2 className="font-display text-lg font-semibold">Appearance</h2>
        <p className="text-muted mt-2 text-sm leading-relaxed">
          A job search happens at odd hours. System follows your device, which is
          usually the right answer without anyone choosing.
        </p>
        <div className="mt-4 inline-flex">
          <ThemeToggle />
        </div>
      </section>

      <section className="bg-surface border-border mt-6 rounded-xl border p-6">
        <h2 className="font-display text-lg font-semibold">Your data</h2>
        <ExportData />
      </section>

      <section className="bg-surface border-border mt-6 rounded-xl border p-6">
        <h2 className="font-display text-lg font-semibold">Help</h2>
        <p className="text-muted mt-2 text-sm leading-relaxed">
          <b>Support</b> is a conversation: the assistant answers straight away and a person
          steps in when it matters. <b>Contact &amp; feedback</b> is a one-way note — anything
          you noticed, no answer expected — with our email on it.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/app/support" className="btn btn-primary inline-flex text-sm">
            Support
          </Link>
          <FeedbackButton />
        </div>
      </section>

      {user.role === "admin" && (
        <section className="bg-surface border-border mt-6 rounded-xl border p-6">
          <h2 className="font-display text-lg font-semibold">Admin</h2>
          <p className="text-muted mt-2 text-sm">
            You have an admin account. Everything for running the service lives on a separate
            dashboard — this app is the user&rsquo;s view of Grindly.
          </p>
          <Link href="/admin" className="btn btn-primary mt-4 inline-flex">
            Go to admin dashboard →
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
