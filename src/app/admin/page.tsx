import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/auth";
import { describe } from "@/lib/config";
import { formatAmount } from "@/lib/plans";
import { adminStats, signupsByDay } from "@/lib/adminStats";
import { ResolveError } from "./ResolveError";
import { AccessQueue } from "./AccessQueue";
import { ProblemReports } from "./ProblemReports";
import { AccountTable } from "./AccountTable";
import { AdminNav, isSection, type SectionKey } from "./Nav";
import { BandBars, Donut, KpiCard, SignupArea, StatusPill } from "./Charts";
import { Funnel, ScoreStat, Section, Stat, StatGrid } from "./Panels";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin — Grindly" };

const RANGES = [7, 30, 90] as const;

/**
 * The operator's dashboard.
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
 *
 * The page is SECTIONED rather than one scroll. It was one scroll, and on
 * eighty-seven accounts it came out 6,763 pixels tall — which is a dashboard
 * you scroll past rather than read. Each section now answers one question and
 * loads only what that question needs.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ s?: string; days?: string }>;
}) {
  const user = await currentUser();
  // notFound() would be the same information; a redirect is friendlier for a
  // signed-in non-admin who followed a stale link.
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/app");

  const params = await searchParams;
  const section: SectionKey = isSection(params.s) ? params.s : "overview";
  const days = RANGES.includes(Number(params.days) as (typeof RANGES)[number])
    ? (Number(params.days) as (typeof RANGES)[number])
    : 30;

  const caps = describe();
  const [stats, signups, pendingCount] = await Promise.all([
    adminStats(),
    section === "overview" ? signupsByDay(days) : Promise.resolve([]),
    prisma.user.count({ where: { role: { not: "admin" }, accessStatus: "pending" } }),
  ]);

  return (
    <main className="mx-auto max-w-7xl px-5 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold sm:text-3xl">Admin</h1>
          <p className="text-muted mt-1 font-mono text-[10px] tracking-[0.1em] uppercase">
            {user.email} · {caps.env}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {stats.health.unresolvedErrors > 0 && (
            <StatusPill tone="bad">{stats.health.unresolvedErrors} errors</StatusPill>
          )}
          {pendingCount > 0 && <StatusPill tone="warn">{pendingCount} waiting</StatusPill>}
          <Link href="/app" className="text-muted hover:text-ink text-sm whitespace-nowrap">
            ← Back to the app
          </Link>
        </div>
      </header>

      <div className="flex flex-col gap-6 lg:flex-row lg:gap-10">
        <AdminNav active={section} waiting={pendingCount} />
        <div className="min-w-0 flex-1">
          {section === "overview" && <Overview stats={stats} signups={signups} days={days} />}
          {section === "access" && <Access />}
          {section === "people" && <People />}
          {section === "quality" && <Quality stats={stats} />}
          {section === "money" && <Money stats={stats} caps={caps} />}
          {section === "problems" && <Problems stats={stats} />}
          {section === "health" && <Health stats={stats} caps={caps} />}
        </div>
      </div>
    </main>
  );
}

type Stats = Awaited<ReturnType<typeof adminStats>>;
type Caps = ReturnType<typeof describe>;

/* ── overview ────────────────────────────────────────────────────── */

function Overview({
  stats,
  signups,
  days,
}: {
  stats: Stats;
  signups: { date: string; count: number }[];
  days: number;
}) {
  const runs = stats.work.runsByStatus;
  const runTotal = Object.values(runs).reduce((a, b) => a + b, 0);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Accounts"
          value={stats.users.total}
          trend={{ now: stats.users.newThisWeek, before: stats.users.newWeekBefore }}
          sub={`${stats.users.approved} approved · ${stats.users.pending} waiting${
            stats.users.blocked ? ` · ${stats.users.blocked} blocked` : ""
          }`}
        />
        <KpiCard
          label="Active this week"
          value={stats.active.week}
          trend={{ now: stats.active.week, before: stats.active.weekBefore }}
          sub={`${stats.active.day} today · ${stats.active.month} in 30 days`}
        />
        <KpiCard
          label="Resumes"
          value={stats.work.resumes}
          trend={{ now: stats.work.resumesThisWeek, before: stats.work.resumesWeekBefore }}
          sub={`${stats.work.resumesThisWeek} uploaded this week`}
        />
        <KpiCard
          label="Rebuild runs"
          value={stats.work.rebuilds}
          trend={{ now: stats.work.rebuildsThisWeek, before: stats.work.rebuildsWeekBefore }}
          sub={`${stats.work.rebuildsThisWeek} this week`}
          accent
        />
      </div>

      <p className="text-muted mt-3 text-xs leading-relaxed">
        The chip beside each number compares this period against the one before it — a real
        count, not a projection. &ldquo;Active&rdquo; means an account that <i>did</i>{" "}
        something, from the audit log; nothing here records page views, and a traffic number
        invented by proxy would be the kind of unfalsifiable metric this product argues
        against.
      </p>

      <Section title="Signups" note="One point per day, including the days nobody signed up.">
        <div className="mb-3 flex gap-1.5">
          {RANGES.map((r) => (
            <Link
              key={r}
              href={r === 30 ? "/admin" : `/admin?days=${r}`}
              aria-current={days === r ? "true" : undefined}
              className="rounded-full border px-3 py-1 font-mono text-[10px] tracking-[0.08em] uppercase"
              style={
                days === r
                  ? { background: "var(--cta)", color: "var(--on-cta)", borderColor: "var(--cta)" }
                  : { color: "var(--muted)", borderColor: "var(--line-2)" }
              }
            >
              {r} days
            </Link>
          ))}
        </div>
        <div className="bg-surface border-border rounded-xl border p-4">
          <SignupArea points={signups} />
        </div>
      </Section>

      <div className="mt-8 grid gap-6 xl:grid-cols-2">
        <div>
          <h2 className="font-mono text-[11px] tracking-[0.14em] uppercase opacity-70">
            Rebuild outcomes
          </h2>
          <p className="text-muted mt-1.5 max-w-2xl text-xs leading-relaxed">
            Every run ever started. &ldquo;Beaten by the original&rdquo; is a success: it means
            nothing we produced was better than what the user already had, and we said so
            instead of shipping it.
          </p>
          <div className="bg-surface border-border mt-3 rounded-xl border p-5">
            <Donut
              centreLabel="runs"
              centreValue={runTotal}
              // Failure is INK, not a second red. --brand is #b92b1a and the
              // danger red is #a3271b: side by side in a 16px ring they are the
              // same colour, and "kept" and "failed" are the two slices a
              // reader most needs to tell apart at a glance.
              slices={[
                { label: "Kept a rebuild", count: runs.done ?? 0, tone: "var(--brand)" },
                { label: "Beaten by the original", count: runs.empty ?? 0, tone: "var(--warn)" },
                { label: "Failed", count: runs.failed ?? 0, tone: "var(--ink-color)" },
                { label: "Cancelled", count: runs.cancelled ?? 0, tone: "var(--line-2)" },
                { label: "Running now", count: runs.running ?? 0, tone: "var(--muted)" },
              ]}
            />
          </div>
        </div>

        <div>
          <h2 className="font-mono text-[11px] tracking-[0.14em] uppercase opacity-70">
            Score distribution
          </h2>
          <p className="text-muted mt-1.5 max-w-2xl text-xs leading-relaxed">
            Every scored resume, in the product&rsquo;s own grade bands — the same letters
            printed on a user&rsquo;s report, so this chart cannot disagree with what they were
            told.
          </p>
          <div className="bg-surface border-border mt-3 rounded-xl border p-5">
            <BandBars
              rows={stats.quality.scoreBands.map((b) => ({
                label: b.label,
                note: b.range,
                count: b.count,
                tone:
                  b.label === "A" || b.label === "B"
                    ? "var(--brand)"
                    : b.label === "C"
                      ? "var(--warn)"
                      : "#a3271b",
              }))}
            />
          </div>
        </div>
      </div>

      <Section
        title="Does the product work for them"
        note="Distinct accounts reaching each step, not events — one enthusiastic user running forty rebuilds must not read as forty people getting value."
      >
        <Funnel
          steps={[
            { label: "Signed up", count: stats.funnel.signedUp, note: "Created an account." },
            {
              label: "Uploaded a resume",
              count: stats.funnel.uploaded,
              note: "Got a readiness score. This is the first moment the product is useful.",
            },
            {
              label: "Ran a rebuild",
              count: stats.funnel.rebuilt,
              note: "Asked for rewrites or built from the editor.",
            },
            {
              label: "Took a document",
              count: stats.funnel.tookADocument,
              note: "Exported a file or built their own edit — the point of the whole thing.",
            },
          ]}
        />
      </Section>
    </>
  );
}

/* ── access ──────────────────────────────────────────────────────── */

async function Access() {
  const [pending, decided] = await Promise.all([
    // The queue is a queue: oldest request first, because the person who has
    // been waiting longest is the person to answer next.
    prisma.user.findMany({
      where: { role: { not: "admin" }, accessStatus: "pending" },
      orderBy: { createdAt: "asc" },
      take: 50,
      select: { id: true, email: true, name: true, accessStatus: true, createdAt: true, approvedAt: true },
    }),
    // Decided accounts, so a decision can be undone without hunting for it.
    // Ordered by when the decision was made, nulls last so a blocked account —
    // which has its approvedAt cleared — falls back to its signup date rather
    // than to the top.
    prisma.user.findMany({
      where: { role: { not: "admin" }, accessStatus: { not: "pending" } },
      orderBy: [{ approvedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: 8,
      select: { id: true, email: true, name: true, accessStatus: true, createdAt: true, approvedAt: true },
    }),
  ]);

  return (
    <>
      <Section
        title={`Waiting${pending.length ? ` · ${pending.length}` : ""}`}
        note="Anyone who signs up lands here. They see a page telling them they are waiting; approving lets them straight in with no further step. Blocking stops an account without deleting anything — they keep their data and can still export it."
      >
        <AccessQueue
          users={pending.map(serialiseUser)}
          emptyNote="Nobody is waiting. New signups will appear here."
        />
      </Section>

      {decided.length > 0 && (
        <Section
          title="Recently decided"
          note="The last eight decisions, newest first. Reversible — revoking keeps everything the account has made."
        >
          <AccessQueue users={decided.map(serialiseUser)} emptyNote="" />
        </Section>
      )}
    </>
  );
}

/* ── people ──────────────────────────────────────────────────────── */

async function People() {
  const rows = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      email: true,
      plan: true,
      accessStatus: true,
      createdAt: true,
      _count: { select: { resumes: true } },
    },
  });

  return (
    <Section
      title="Accounts"
      note="The fifty most recent, newest first. Filtering happens in the page — there is nothing to wait for."
    >
      <AccountTable
        rows={rows.map((r) => ({
          id: r.id,
          email: r.email,
          plan: r.plan,
          accessStatus: r.accessStatus,
          resumes: r._count.resumes,
          createdAt: r.createdAt.toISOString(),
        }))}
      />
    </Section>
  );
}

/* ── quality ─────────────────────────────────────────────────────── */

function Quality({ stats }: { stats: Stats }) {
  const runs = stats.work.runsByStatus;
  const runTotal = Object.values(runs).reduce((a, b) => a + b, 0);
  const failed = (runs.failed ?? 0) + (runs.cancelled ?? 0);

  return (
    <>
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

      <Section title="Score distribution" note="Every scored resume, in the product's own grade bands.">
        <div className="bg-surface border-border mt-3 rounded-xl border p-5">
          <BandBars
            rows={stats.quality.scoreBands.map((b) => ({
              label: b.label,
              note: b.range,
              count: b.count,
            }))}
          />
        </div>
      </Section>
    </>
  );
}

/* ── money ───────────────────────────────────────────────────────── */

function Money({ stats, caps }: { stats: Stats; caps: Caps }) {
  return (
    <Section
      title="Money"
      note={
        caps.payments.enabled
          ? "Paid orders only. Amounts are in rupees."
          : "Payments are in STUB mode — these orders were granted, not paid. Nobody has been charged."
      }
    >
      <StatGrid>
        <KpiCard
          label={caps.payments.enabled ? "Revenue" : "Granted (stub)"}
          value={formatAmount(stats.money.revenue)}
          trend={{ now: stats.money.revenueThisMonth, before: stats.money.revenueMonthBefore }}
          sub={`${formatAmount(stats.money.revenueThisMonth)} in the last 30 days`}
        />
        <Stat label="Paid orders" value={stats.money.paidOrders} />
        <Stat
          label="Paying accounts"
          value={stats.money.payingUsers}
          sub={
            stats.users.total
              ? `${Math.round((stats.money.payingUsers / stats.users.total) * 100)}% of accounts`
              : "no accounts yet"
          }
        />
        <Stat
          label="Revenue per account"
          value={stats.users.total ? formatAmount(Math.round(stats.money.revenue / stats.users.total)) : "—"}
          sub="Total, divided by every account. Not a forecast."
        />
      </StatGrid>
    </Section>
  );
}

/* ── problems ────────────────────────────────────────────────────── */

async function Problems({ stats }: { stats: Stats }) {
  const problems = await prisma.problemReport.findMany({
    orderBy: [{ resolvedAt: "asc" }, { createdAt: "desc" }],
    take: 25,
    select: {
      id: true,
      message: true,
      path: true,
      resumeId: true,
      resolvedAt: true,
      createdAt: true,
      user: { select: { email: true } },
    },
  });

  return (
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
  );
}

/* ── health ──────────────────────────────────────────────────────── */

async function Health({ stats, caps }: { stats: Stats; caps: Caps }) {
  const recentErrors = await prisma.errorEvent.findMany({
    where: { resolvedAt: null },
    orderBy: { lastSeenAt: "desc" },
    take: 10,
  });

  return (
    <>
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
            Nothing unresolved. {stats.health.errorsThisWeek} were seen and dealt with this week.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-border border-b text-left">
                  <Th>Kind</Th>
                  <Th>Message</Th>
                  <Th>Where</Th>
                  <Th className="text-right">Seen</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {recentErrors.map((e) => (
                  <tr key={e.id} className="border-border border-b last:border-0">
                    <td className="py-2 pr-4">
                      <StatusPill tone={e.kind === "llm-provider" ? "warn" : "bad"}>{e.kind}</StatusPill>
                    </td>
                    <td className="max-w-[24rem] truncate py-2 pr-4">{e.message}</td>
                    <td className="text-muted max-w-[12rem] truncate py-2 pr-4 font-mono text-xs">
                      {e.context ?? "—"}
                    </td>
                    <td className="py-2 pr-4 text-right font-mono text-xs tabular-nums">{e.count}</td>
                    <td className="py-2 text-right">
                      <ResolveError id={e.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

/* ── shared bits ─────────────────────────────────────────────────── */

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
      <dt className="text-muted font-mono text-[10px] tracking-[0.12em] uppercase">{label}</dt>
      <dd className="mb-1 sm:mb-0">{value}</dd>
    </>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`text-muted pb-2 pr-4 font-mono text-[10px] font-normal tracking-[0.12em] uppercase ${className}`}
    >
      {children}
    </th>
  );
}
