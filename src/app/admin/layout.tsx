import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { describe } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * The admin is a different site, not a page inside the user's app.
 *
 * Its own chrome — an ink-black bar with the wordmark, the environment, one
 * door back ("Switch to user view") and sign-out — and none of the user app's
 * header, phone nav, account menu or ambient background. The operator should
 * never wonder which side they are on: the bar tells them at a glance, and the
 * only way across is the labelled door.
 *
 * The gate lives here as well as in the page, so a future second admin route
 * cannot forget it.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login?next=/admin");
  if (user.role !== "admin") redirect("/app");
  const caps = describe();

  return (
    <div className="flex min-h-full flex-col">
      <header style={{ background: "var(--ink)", color: "var(--paper)" }}>
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <Link href="/admin" className="font-display text-lg font-bold tracking-tight">
              GRINDLY<span style={{ color: "var(--vermilion)" }}>.</span>{" "}
              <span className="font-mono text-[11px] font-normal tracking-[0.18em] uppercase opacity-80">
                admin
              </span>
            </Link>
            <span
              className="rounded-full px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] uppercase"
              style={{ background: "rgba(255,255,255,0.12)" }}
            >
              {caps.env}
            </span>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="hidden font-mono text-[11px] opacity-70 sm:inline">{user.email}</span>
            <Link
              href="/app"
              className="rounded-lg border px-3 py-1.5 text-sm font-medium"
              style={{ borderColor: "rgba(255,255,255,0.35)" }}
            >
              ← Switch to user view
            </Link>
            <form action="/api/logout" method="post">
              <button type="submit" className="cursor-pointer text-sm underline-offset-4 hover:underline">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
