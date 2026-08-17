import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/auth";
import { describe } from "@/lib/config";
import { formatAmount } from "@/lib/plans";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin — Grindly" };

/**
 * The operator's page: is it working, who is using it, what is broken.
 *
 * Deliberately one page rather than eight. The previous build had admin
 * sections for applications, agent health, integrations and support — a
 * console for a machine that no longer exists. What an operator of THIS product
 * actually needs to know fits above the fold: is the agent able to render, are
 * people getting scores, and what errored.
 */
export default async function AdminPage() {
  const user = await currentUser();
  // notFound() would be the same information; a redirect is friendlier for a
  // signed-in non-admin who followed a stale link.
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/app");

  const caps = describe();
  const since = sevenDaysAgo();

  // Aggregates computed IN the database. These were `findMany` over every
  // resume and every paid order, sorted in JS — two unbounded full-table reads
  // into Node's heap, on every admin page load, to produce two numbers.
  const [users, resumes, variants, revenueAgg, medianRows, recentErrors, recent] =
    await Promise.all([
      prisma.user.count(),
      prisma.resume.count(),
      prisma.variant.count(),
      prisma.order.aggregate({ where: { status: "paid" }, _sum: { amount: true } }),
      prisma.$queryRaw<{ median: number | null }[]>`
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY score)::int AS median
        FROM resumes WHERE score IS NOT NULL
      `,
      prisma.errorEvent.findMany({
        where: { resolvedAt: null },
        orderBy: { lastSeenAt: "desc" },
        take: 10,
      }),
      prisma.user.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 15,
        select: {
          id: true, email: true, plan: true, createdAt: true,
          _count: { select: { resumes: true } },
        },
      }),
    ]);

  const revenue = revenueAgg._sum.amount ?? 0;
  const median = medianRows[0]?.median ?? null;

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-display text-3xl font-bold">Admin</h1>
        <Link href="/app" className="text-muted hover:text-ink text-sm">
          ← Back to the app
        </Link>
      </div>

      <section className="mt-8">
        <h2 className="font-mono text-[11px] tracking-[0.14em] uppercase opacity-60">
          This deployment
        </h2>
        <div className="bg-surface border-border mt-3 rounded-xl border p-5 text-sm">
          <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
            <Row label="Environment" value={caps.env} />
            <Row label="Sign-in" value={caps.auth.google ? "password + Google" : "password only"} />
            <Row label="Payments" value={caps.payments.provider} />
            <Row label="Email" value={caps.email} />
            <Row
              label="Rewrites"
              value={caps.llmProviders.length ? caps.llmProviders.join(", ") : "disabled (no LLM key)"}
            />
          </dl>
          {caps.missing.length > 0 && (
            <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--border)" }}>
              <p className="font-mono text-[10px] tracking-[0.12em] uppercase" style={{ color: "#a8730f" }}>
                Not configured
              </p>
              <ul className="text-muted mt-1.5 list-disc space-y-0.5 pl-4">
                {caps.missing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="font-mono text-[11px] tracking-[0.14em] uppercase opacity-60">Usage</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Accounts" value={users} />
          <Stat label="Resumes" value={resumes} />
          <Stat label="Rewrites kept" value={variants} />
          <Stat label="Median score" value={median ?? "—"} />
          {/* Labelled honestly: in stub mode these orders are grants, not money.
              Reporting them as "Revenue" told an operator they had been paid. */}
          <Stat
            label={caps.payments.enabled ? "Revenue" : "Granted (stub)"}
            value={formatAmount(revenue)}
          />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="font-mono text-[11px] tracking-[0.14em] uppercase opacity-60">
          Unresolved errors
        </h2>
        {recentErrors.length === 0 ? (
          <p className="text-muted mt-3 text-sm">Nothing logged.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-border border-b text-left">
                  <Th>Source</Th>
                  <Th>Kind</Th>
                  <Th>Message</Th>
                  <Th>Seen</Th>
                  <Th>Last</Th>
                </tr>
              </thead>
              <tbody>
                {recentErrors.map((e) => (
                  <tr key={e.id} className="border-border border-b">
                    <Td>{e.source}</Td>
                    <Td>{e.kind}</Td>
                    <Td className="max-w-[24rem] truncate">{e.message}</Td>
                    <Td className="tabular-nums">{e.count}</Td>
                    <Td>{new Date(e.lastSeenAt).toLocaleString("en-IN")}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="font-mono text-[11px] tracking-[0.14em] uppercase opacity-60">
          Signed up this week
        </h2>
        {recent.length === 0 ? (
          <p className="text-muted mt-3 text-sm">Nobody yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-border border-b text-left">
                  <Th>Email</Th>
                  <Th>Plan</Th>
                  <Th>Resumes</Th>
                  <Th>Joined</Th>
                </tr>
              </thead>
              <tbody>
                {recent.map((u) => (
                  <tr key={u.id} className="border-border border-b">
                    <Td>{u.email}</Td>
                    <Td>{u.plan}</Td>
                    <Td className="tabular-nums">{u._count.resumes}</Td>
                    <Td>{new Date(u.createdAt).toLocaleDateString("en-IN")}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function sevenDaysAgo() {
  return new Date(Date.now() - 7 * 86_400_000);
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-surface border-border rounded-xl border p-4">
      <p className="font-mono text-[10px] tracking-[0.12em] uppercase opacity-60">{label}</p>
      <p className="font-display mt-1.5 text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="font-mono text-xs">{value}</dd>
    </>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-muted py-2 pr-4 font-mono text-[10px] font-medium tracking-[0.1em] uppercase">
      {children}
    </th>
  );
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`py-2 pr-4 ${className}`}>{children}</td>;
}
