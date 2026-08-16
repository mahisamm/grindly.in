import Link from "next/link";
import { redirect } from "next/navigation";
import { Logo } from "@/components/Brand";
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

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-border border-b">
        <nav className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <Link href="/app" className="inline-flex">
            <Logo size={26} />
          </Link>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            {plan === "pass" ? (
              <span className="text-muted font-mono text-[11px] tracking-[0.1em] uppercase">
                Season Pass · {left} day{left === 1 ? "" : "s"} left
              </span>
            ) : (
              <Link href="/pricing" className="text-brand text-sm underline">
                Get a Season Pass
              </Link>
            )}
            {user.role === "admin" && (
              <Link href="/admin" className="text-muted hover:text-ink">
                Admin
              </Link>
            )}
            <Link href="/app/settings" className="text-muted hover:text-ink">
              Account
            </Link>
            <form action="/api/logout" method="post">
              <button type="submit" className="text-muted hover:text-ink">
                Sign out
              </button>
            </form>
          </div>
        </nav>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
