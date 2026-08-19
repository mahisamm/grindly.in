import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/auth";
import { describe } from "@/lib/config";
import { formatAmount } from "@/lib/plans";
import { adminStats, recentSignups, signupsByDay } from "@/lib/adminStats";
import { ResolveError } from "./ResolveError";
import { AccessQueue } from "./AccessQueue";
import { ProblemReports } from "./ProblemReports";
import { DailyBars, Funnel, ScoreStat, Section, Stat, StatGrid } from "./Panels";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin — Grindly" };

/**
 * The operator's page: who is waiting, what is working, what is broken.
 *
 * Every number here is a count of rows that exist, and every panel says what it
 * was counted from. That note is not decoration — it is the difference between
 * a dashboard someone trusts at 2am and one they quietly stop opening, and it
 * is what stops "active users" being read as "visitors".
 *
 * What is deliberately NOT here: page views, sessions, bounce rate, anything
 * predictive. Nothing in this application records a request, and inventing a
 * traffic number by proxy would be exactly the unfalsifiable metric the landing
 * page refuses to sell. See lib/adminStats.ts.
 */
export default async function AdminPage() {
  const user = await currentUser();
  // notFound() would be the same information; a redirect is friendlier for a
  // signed-in non-admin who followed a stale link.
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/app");

  const caps = describe();

  const [stats, signups, queue, recentErrors, problems, recent] = await Promise.all([
    adminStats(),
    signupsByDay(30),
    // Pending first and oldest first — the queue is a queue. Recently decided
    // accounts follow, so an approval can be undone without hunting for it.
    prisma.user.findMany({
      where: { role: { not: "admin" } },
      orderBy: [{ accessStatus: "asc" }, { createdAt: "asc" }],
      take: 50,
      select: {
        id: true, email: true, name: true, accessStatus: true,
        createdAt: true, approvedAt: true,
      },
    }),
    prisma.errorEvent.findMany({
      where: { resolvedAt: null },
      orderBy: { lastSeenAt: "desc" },
      take: 10,
    }),
    prisma.problemReport.findMany({
      orderBy: [{ resolvedAt: "asc" }, { createdAt: "desc" }],
      take: 25,
      select: {
        id: true, message: true, path: true, resumeId: true,
        resolvedAt: true, createdAt: true,
        user: { select: { email: true } },
      },
    }),
    // Every window on this page is measured inside lib/adminStats, because a
    // component may not read the clock — see the note on recentSignups.
    recentSignups(7),
  ]);

  const pending = queue.filter((u) => u.accessStatus === "pending");
  const decided = queue.filter((u) => u.accessStatus !== "pending");
  const runs = stats.work.runsByStatus;
  const runTotal = Object.values(runs).reduce((a, b) => a + b, 0);
  const failed = (runs.failed ?? 0) + (runs.cancelled ?? 0);

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-display text-3xl font-bold">Admin</h1>
        <Link href="/app" className="text-muted hover:text-ink text-sm">
          ← Back to the app
        </Link>
      </div>

      {/* The queue is first because it is the only thing on this page that
          someone is waiting on the other end of. */}
      <Section
        title={`Access requests${pending.length ? ` · ${pending.length} waiting` : ""}`}
        note="Anyone who signs up lands here. They see a page telling them they are waiting; approving lets them straight in with no further step. Blocking stops an account without deleting anything — they keep their data and can still export it."
      >
        <AccessQueue
          users={pending.map(serialiseUser)}
          emptyNote="Nobody is waiting. New signups will appear here."
        />
      </Section>

      <Section title="Who is here">
        <StatGrid>
          <Stat
            label="Accounts"
            value={stats.users.total}
            sub={`${stats.users.approved} approved · ${stats.users.pending} waiting${stats.users.blocked ? ` · ${stats.users.blocked} blocked` : ""}`}
          />
          <Stat
            label="New this week"
            value={stats.users.newThisWeek}
            sub={`${stats.users.newThisMonth} in the last 30 days`}
          />
          <Stat
            label="Active this week"
            value={stats.active.week}
            sub={`${stats.active.day} today · ${stats.active.month} this month`}
          />
          <Stat
            label="Paying"
            value={stats.money.payingUsers}
            sub={
              stats.users.total
                ? `${Math.round((stats.money.payingUsers / stats.users.total) * 100)}% of accounts`
                : "no accounts yet"
            }
          />
        </StatGrid>
        <p className="text-muted mt-3 text-xs leading-relaxed">
          &ldquo;Active&rdquo; means an account that <i>did</i> something — uploaded,
          rebuilt, edited, exported — counted from the audit log. It is not a visitor
          count: nothing here records page views, and a number invented by proxy would
          be the kind of unfalsifiable metric this product exists to argue against.
        </p>
      </Section>

      <Section title="Signups, last 30 days" note="One bar per day, including the days nobody signed up.">
        <DailyBars data={signups} />
      </Section>

      <Section
        title="Does the product work for them"
        note="Distinct accounts reaching each step, not events — one enthusiastic user running forty rebuilds must not read as forty people getting value."
      >
        <Funnel
          steps={[
            { label: "Signed up", count: stats.funnel.signedUp, note: "Created an account." },
            { label: "Uploaded a resume", count: stats.funnel.uploaded, note: "Got a readiness score. This is the first moment the product is useful." },
            { label: "Ran a rebuild", count: stats.funnel.rebuilt, note: "Asked for rewrites or built from the editor." },
            { label: "Took a document", count: stats.funnel.tookADocument, note: "Exported a file or built their own edit — the point of the whole thing." },
          ]}
        />
      </Section>

      <Section title="What it produced">
        <StatGrid>
          <Stat label="Resumes" value={stats.work.resumes} sub={`${stats.work.resumesThisWeek} this week`} />
          <Stat label="Rebuild runs" value={stats.work.rebuilds} sub={`${stats.work.rebuildsThisWeek} this week`} />
          <Stat
            label="Runs that failed"
            value={runTotal ? `${Math.round((failed / runTotal) * 100)}%` : "—"}
            sub={`${failed} of ${runTotal} · ${runs.empty ?? 0} beat by the original`}
            tone={runTotal && failed / runTotal > 0.15 ? "bad" : undefined}
          />
          <Stat
            label="Documents taken"
            value={stats.work.exports + stats.work.editorBuilds}
            sub={`${stats.work.exports} exports · ${stats.work.editorBuilds} editor builds · ${stats.work.coverLetters} letters`}
          />
        </StatGrid>
      </Section>

      <Section
        title="Is it any good"
        note="The score is a pure function of the resume text, so these move only when documents do."
      >
        <StatGrid>
          <ScoreStat label="Median score" score={stats.quality.medianScore} sub="Across every resume measured." />
          <Stat
            label="Median gain"
            value={stats.quality.medianGain === null ? "—" : `+${stats.quality.medianGain}`}
            sub="Points a kept rebuild adds over the resume it came from."
            tone="good"
          />
          <Stat
            label="At or above 80"
            value={
              stats.quality.keptVariants
                ? `${Math.round((stats.quality.atOrAboveFloor / stats.quality.keptVariants) * 100)}%`
                : "—"
            }
            sub={`${stats.quality.atOrAboveFloor} of ${stats.quality.keptVariants} rebuilds cleared the floor`}
          />
          <Stat
            label="Applications logged"
            value={stats.applications.logged}
            sub={`${stats.applications.replied} moved past “sent”`}
          />
        </StatGrid>
      </Section>

      <Section
        title="Money"
        note={
          caps.payments.enabled
            ? "Paid orders only. Amounts are in rupees."
            : "Payments are in STUB mode — these orders were granted, not paid. Nobody has been charged."
        }
      >
        <StatGrid>
          <Stat
            label={caps.payments.enabled ? "Revenue" : "Granted (stub)"}
            value={formatAmount(stats.money.revenue)}
            sub={`${formatAmount(stats.money.revenueThisMonth)} in the last 30 days`}
          />
          <Stat label="Paid orders" value={stats.money.paidOrders} />
          <Stat
            label="Revenue per account"
            value={stats.users.total ? formatAmount(Math.round(stats.money.revenue / stats.users.total)) : "—"}
            sub="Total, divided by every account. Not a forecast."
          />
          <Stat label="Payment provider" value={caps.payments.provider} />
        </StatGrid>
      </Section>

      <Section
        title={`Problems reported${stats.health.openProblemReports ? ` · ${stats.health.openProblemReports} open` : ""}`}
        note="Typed by users from the widget in the corner of the app. These are the faults nothing threw — where the software did the wrong thing quietly, which in a product built on measurement is the more dangerous kind."
      >
        <ProblemReports
          reports={problems.map((p) => ({
            id: p.id,
            message: p.message,
            path: p.path,
            resumeId: p.resumeId,
            email: p.user?.email ?? null,
            resolvedAt: p.resolvedAt ? p.resolvedAt.toISOString() : null,
            createdAt: p.createdAt.toISOString(),
          }))}
        />
      </Section>

      <Section
        title="This deployment"
        note="What the server can actually do right now, read from its own configuration."
      >
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
              <p className="font-mono text-[10px] tracking-[0.12em] uppercase" style={{ color: "var(--warn)" }}>
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
      </Section>

      <Section
        title={`Unresolved errors${stats.health.providerFailures ? " · a provider is failing" : ""}`}
        note="Faults the software noticed, from the web app, the Python agent and the browser. Deduplicated by fingerprint, so one bad afternoon is one row with a count."
      >
        {recentErrors.length === 0 ? (
          <p className="text-muted mt-3 text-sm">
            Nothing unresolved. {stats.health.errorsThisWeek} were seen and dealt with this
            week.
          </p>
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
                  <Th>Context</Th>
                  {/* No heading: a screen reader is told what the control does
                      by the button itself. */}
                  <Th> </Th>
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
                    <Td className="text-muted max-w-[12rem] truncate font-mono text-xs">
                      {e.context ?? ""}
                    </Td>
                    <Td>
                      <ResolveError id={e.id} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Signed up this week">
        {recent.length === 0 ? (
          <p className="text-muted mt-3 text-sm">Nobody yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-border border-b text-left">
                  <Th>Email</Th>
                  <Th>Access</Th>
                  <Th>Plan</Th>
                  <Th>Resumes</Th>
                  <Th>Joined</Th>
                </tr>
              </thead>
              <tbody>
                {recent.map((u) => (
                  <tr key={u.id} className="border-border border-b">
                    <Td>{u.email}</Td>
                    <Td>{u.accessStatus}</Td>
                    <Td>{u.plan}</Td>
                    <Td className="tabular-nums">{u._count.resumes}</Td>
                    <Td>{new Date(u.createdAt).toLocaleDateString("en-IN")}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {decided.length > 0 && (
        <Section
          title="Already decided"
          note="Reversible. Revoking keeps everything the account has made."
        >
          <AccessQueue users={decided.map(serialiseUser)} emptyNote="" />
        </Section>
      )}
    </div>
  );
}

function serialiseUser(u: {
  id: string;
  email: string;
  name: string | null;
  accessStatus: string;
  createdAt: Date;
  approvedAt: Date | null;
}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    accessStatus: u.accessStatus,
    createdAt: u.createdAt.toISOString(),
    approvedAt: u.approvedAt ? u.approvedAt.toISOString() : null,
  };
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
