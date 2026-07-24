import { redirect } from "next/navigation";
import Link from "next/link";
import { Logo } from "@/components/Brand";
import { Maintenance } from "@/components/Doodles";
import { readAdminSettings } from "@/lib/adminSettings";

// Beta: Google is the only way in, so there's no separate sign-up form — this
// route normally just forwards to the single /login entry. (The old email/phone
// signup form lives in git history if we re-enable password auth later.)
//
// When sign-ups are paused it becomes the "we're doing maintenance" page
// instead. The Google callback redirects here after declining to create an
// account, which is the only moment a new sign-up is distinguishable from a
// returning user — /login is deliberately left alone so existing accounts sign
// in exactly as before.
export default function SignupPage() {
  if (!readAdminSettings().signupMaintenance) redirect("/login");

  return (
    <main className="grid-bg relative flex min-h-screen items-center justify-center px-5 py-12">
      <div className="relative z-[1] w-full min-w-0 max-w-[460px]">
        <Link href="/" className="mb-7 flex justify-center">
          <Logo size={34} />
        </Link>

        <div className="animate-in">
          <div className="rounded-lg border border-[var(--line-2)] bg-surface p-6 text-center shadow-[10px_10px_0_rgba(23,20,15,0.08)] sm:p-9">
            <Maintenance className="mx-auto text-ink" size={104} />

            <h1 className="display mt-5 text-[clamp(1.7rem,2.4vw,2.1rem)] tracking-[-0.01em]">
              New sign-ups are paused
            </h1>
            <p className="mt-2.5 text-sm text-[var(--ink-soft)]">
              Grindly is down for maintenance while we finish some work on the
              agent. We&apos;re not taking new accounts right now — please check
              back a little later.
            </p>

            <p className="mt-5 rounded-md border border-[var(--line-2)] bg-[var(--paper)] px-4 py-3 text-sm text-[var(--ink-soft)]">
              Already have an account? You can still{" "}
              <Link href="/login" className="font-semibold text-ink underline">
                sign in
              </Link>{" "}
              as usual.
            </p>

            <Link
              href="/"
              className="press mt-6 inline-flex w-full items-center justify-center rounded-full border border-[var(--line-2)] bg-[var(--paper)] px-4 py-3 font-semibold transition hover:border-ink hover:bg-ink hover:text-[var(--paper)]"
            >
              Back to home
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
