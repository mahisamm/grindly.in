import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { currentUser, isApproved } from "@/lib/auth";
import { Logo } from "@/components/Brand";
import { ExportData } from "@/app/app/settings/AccountForms";
import { DeleteAccount } from "@/app/app/settings/DeleteAccount";
import { ReportProblem } from "@/components/ReportProblem";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Waiting for access — Grindly",
  robots: { index: false, follow: false },
};

/**
 * Where someone lands when their account exists but is not in the beta yet.
 *
 * The whole point is that it is not a dead end and not a lie. It says exactly
 * what state they are in, who decides, and what they can still do — which is
 * everything about their own account, including deleting it. A closed beta that
 * signs someone up and then shows them a locked door with no explanation
 * teaches them the product is broken.
 *
 * A blocked account sees a different sentence. Conflating "not yet" with "no"
 * would leave someone refreshing forever.
 */
export default async function PendingPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  // Already in. Bouncing them here would be a loop with the layout, which sends
  // unapproved users this way.
  if (isApproved(user)) redirect("/app");

  const blocked = user.accessStatus === "blocked";

  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-6 py-16">
      <Link href="/" className="mb-10 inline-flex">
        <Logo />
      </Link>

      <p className="text-brand font-mono text-xs tracking-[0.16em] uppercase">
        {blocked ? "Account suspended" : "Account review"}
      </p>

      <h1 className="font-display mt-3 text-3xl font-bold text-balance">
        {blocked ? "This account cannot use Grindly" : "You are on the list"}
      </h1>

      {blocked ? (
        <p className="text-muted mt-4 leading-relaxed">
          Access to this account has been withdrawn. Your resumes and reports are still
          here and still yours — you can download everything from your account page, and
          delete it all from the same screen.
        </p>
      ) : (
        <>
          <p className="text-muted mt-4 leading-relaxed">
            New accounts are occasionally held for a quick review. Yours was created and
            is in the queue — nothing more is needed from you.
          </p>
          <p className="text-muted mt-3 leading-relaxed">
            You will be able to sign in and use everything the moment it is approved.
            This page will let you through automatically; there is nothing to click.
          </p>
        </>
      )}

      <div className="bg-surface border-border mt-8 rounded-xl border p-5">
        <p className="font-mono text-[10px] tracking-[0.12em] uppercase opacity-60">
          Signed in as
        </p>
        <p className="mt-1.5 text-sm">{user.email}</p>
      </div>

      <form action="/api/logout" method="post" className="mt-8">
        <button type="submit" className="btn">
          Sign out
        </button>
      </form>

      {/* The account controls live HERE rather than behind a link to settings,
          because /app is gated as a whole and a link into it would bounce
          straight back. Someone who is waiting — or who has been blocked —
          still owns their data and must be able to take it and leave. */}
      <section className="bg-surface border-border mt-10 rounded-xl border p-5">
        <h2 className="font-display text-lg font-semibold">Your data</h2>
        <ExportData />
      </section>

      <section className="mt-4 rounded-xl border p-5" style={{ borderColor: "#a3271b" }}>
        <h2 className="font-display text-lg font-semibold">Delete your account</h2>
        <p className="text-muted mt-2 text-sm leading-relaxed">
          Removes the account and everything in it, immediately and permanently.
        </p>
        <DeleteAccount email={user.email} />
      </section>

      <p className="text-muted mt-8 text-xs leading-relaxed">
        Nothing you do here costs anything, and no card is ever needed to start.
      </p>
      <ReportProblem />
    </main>
  );
}
