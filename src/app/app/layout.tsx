import Link from "next/link";
import { redirect } from "next/navigation";
import { Logo } from "@/components/Brand";
import { MobileNav } from "@/components/MobileNav";
import { currentUser } from "@/lib/auth";
import { daysRemaining, effectivePlan } from "@/lib/plans";

export const dynamic = "force-dynamic";

/**
 * The signed-in shell.
 *
 * The auth check lives here rather than in each page, so a new page under /app
 * is protected by existing rather than by someone remembering. Redirect, not
 * 401, because this is a navigation — a JSON error would render as a blank
 * screen with a message in the console.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");

  const plan = effectivePlan(user);
  const left = daysRemaining(user);

  const planChip =
    // An admin is not a prospect. Showing the operator of the site an upgrade
    // link on every page is the kind of small wrongness that makes a product
    // feel like it does not know who it is talking to.
    plan === "admin" ? (
      <span className="text-muted font-mono text-[11px] tracking-[0.1em] whitespace-nowrap uppercase">
        Admin
      </span>
    ) : plan === "pass" ? (
      <span className="text-muted font-mono text-[11px] tracking-[0.1em] whitespace-nowrap uppercase">
        Season Pass · {left} day{left === 1 ? "" : "s"} left
      </span>
    ) : (
      <Link href="/pricing" className="text-brand text-sm whitespace-nowrap underline">
        Get a Season Pass
      </Link>
    );

  return (
    <div className="flex min-h-full flex-col">
      {/* Two headers rather than one that wraps.
          On a phone the desktop header collapsed to three text links across two
          ragged lines with "Sign out" sitting a few pixels lower than the rest,
          and it cost about a hundred pixels of the fold to do it. Below `lg`
          the header carries the wordmark and the plan, and every destination
          moves to the bar at the bottom of the screen — within thumb reach and
          out of the scroll. */}
      <header className="border-border border-b">
        <nav className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3.5 sm:px-6 sm:py-4">
          <Link href="/app" className="inline-flex shrink-0" aria-label="Grindly home">
            <Logo size={26} />
          </Link>

          {/* phone + tablet: plan only */}
          <div className="flex min-w-0 items-center lg:hidden">{planChip}</div>

          {/* desktop: the full row */}
          <div className="hidden items-center gap-5 text-sm lg:flex">
            {planChip}
            {user.role === "admin" && (
              <Link href="/admin" className="text-muted hover:text-ink">
                Admin
              </Link>
            )}
            <Link href="/app/settings" className="text-muted hover:text-ink">
              Account
            </Link>
            <form action="/api/logout" method="post">
              <button type="submit" className="text-muted hover:text-ink cursor-pointer">
                Sign out
              </button>
            </form>
          </div>
        </nav>
      </header>

      <main className="has-mobile-nav flex-1">{children}</main>
      <MobileNav />
    </div>
  );
}
