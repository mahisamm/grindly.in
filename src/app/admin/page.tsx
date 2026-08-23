import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { currentUser, type SessionUser } from "@/lib/auth";
import { describe } from "@/lib/config";
import { formatAmount, LIMITS, PRODUCTS, formatLimit } from "@/lib/plans";
import {
  adminStats, signupsByDay, conversionStats, trafficStats, revenueSeries, ticketStats,
} from "@/lib/adminStats";
import { readAdminSettings } from "@/lib/adminSettings";
import { classifyPending } from "@/lib/feedback";
import { ResolveError } from "./ResolveError";
import { AccessQueue } from "./AccessQueue";
import { ProblemReports } from "./ProblemReports";
import { AccountTable } from "./AccountTable";
import { AdminsPanel } from "./AdminsPanel";
import { SettingsSwitches } from "./SettingsSwitches";
import { AdminNav, resolveSection, type SectionKey } from "./Nav";
import { TicketsPanel } from "./TicketsPanel";
import { TrafficPanel, RevenuePanel, ConversionRow } from "./Analytics";
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
  searchParams: Promise<{ s?: string; days?: string; t?: string; status?: string }>;
}) {
  const user = await currentUser();
  // notFound() would be the same information; a redirect is friendlier for a
  // signed-in non-admin who followed a stale link.
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/app");

  const params = await searchParams;
  const section: SectionKey = resolveSection(params.s);
  const days = RANGES.includes(Number(params.days) as (typeof RANGES)[number])
    ? (Number(params.days) as (typeof RANGES)[number])
    : 30;

  const caps = describe();
  const [stats, signups, pendingCount, tickets] = await Promise.all([
    adminStats(),
    section === "dashboard" ? signupsByDay(days) : Promise.resolve([]),
    prisma.user.count({ where: { role: { not: "admin" }, accessStatus: "pending" } }),
    ticketStats(),
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
          {tickets.awaitingYou > 0 && (
            <StatusPill tone="warn">{tickets.awaitingYou} ticket{tickets.awaitingYou === 1 ? "" : "s"}</StatusPill>
          )}
          <Link href="/app" className="text-muted hover:text-ink text-sm whitespace-nowrap">
            ← Back to the app
          </Link>
        </div>
      </header>

      <div className="flex flex-col gap-6 lg:flex-row lg:gap-10">
        <AdminNav active={section} waiting={pendingCount} tickets={tickets.unread} />
        <div className="min-w-0 flex-1">
          {section === "dashboard" && (
            <>
              <Conversion />
              <Overview stats={stats} signups={signups} days={days} />
            </>
          )}
          {section === "analytics" && (
            <>
              <Traffic />
              <Revenue stats={stats} caps={caps} />
              <Quality stats={stats} />
            </>
          )}
          {section === "users" && (
            <>
              <Access />
              <People />
            </>
          )}
          {section === "complaints" && (
            <>
              <Problems stats={stats} />
              <Feedback />
            </>
          )}
          {section === "tickets" && <TicketsPanel ticketId={params.t} status={params.status} adminUser={user} />}
          {section === "errors" && <Health stats={stats} caps={caps} />}
          {section === "settings" && <Settings user={user} />}
        </div>
      </div>
    </main>
  );
}

type Stats = Awaited<ReturnType<typeof adminStats>>;
type Caps = ReturnType<typeof describe>;

/* ── conversion (dashboard top row) ─────────────────────────────── */

async function Conversion() {
  const c = await conversionStats();
  return <ConversionRow c={c} />;
}

/* ── traffic + revenue (analytics) ──────────────────────────────── */

async function Traffic() {
  const t = await trafficStats();
  return <TrafficPanel t={t} />;
}

async function Revenue({ stats, caps }: { stats: Stats; caps: Caps }) {
  const r = await revenueSeries();
  return (
    <>
      <RevenuePanel r={r} />
      <Money stats={stats} caps={caps} />
    </>
  );
}

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
        note="Who waits here depends on the “Open sign-ups” switch in Settings: open (the default) sends new accounts straight in and this queue stays empty; closed, everyone lands here until approved. Blocking stops an account without deleting anything — they keep their data and can still export it."
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
  const now = new Date();
  const rows = await prisma.user.findMany({
    where: { role: { not: "admin" }, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: {
      id: true,
      email: true,
      name: true,
      plan: true,
      planExpiresAt: true,
      accessStatus: true,
      createdAt: true,
      _count: { select: { resumes: true } },
    },
  });
  // Three side tables in three queries, joined in memory — a per-row
  // sub-select for five hundred accounts is the kind of page that takes four
  // seconds and gets closed before it paints.
  const [lastActive, rebuilds, paid, unlocked] = await Promise.all([
    prisma.$queryRaw<{ user_id: string; last: Date }[]>`
      SELECT user_id, MAX(created_at) AS last FROM audit_logs
      WHERE user_id IS NOT NULL GROUP BY user_id`.catch(() => []),
    prisma.$queryRaw<{ user_id: string; n: bigint }[]>`
      SELECT user_id, COUNT(*) AS n FROM variant_runs
      WHERE status = 'done' GROUP BY user_id`.catch(() => []),
    prisma.$queryRaw<{ user_id: string; amount: bigint; currency: string }[]>`
      SELECT user_id, SUM(amount) AS amount, MIN(currency) AS currency FROM orders
      WHERE status = 'paid' GROUP BY user_id`.catch(() => []),
    prisma.$queryRaw<{ user_id: string }[]>`
      SELECT DISTINCT user_id FROM targets WHERE unlocked_at IS NOT NULL`.catch(() => []),
  ]);
  const lastBy = new Map(lastActive.map((r) => [r.user_id, r.last]));
  const runsBy = new Map(rebuilds.map((r) => [r.user_id, Number(r.n)]));
  const paidBy = new Map(paid.map((r) => [r.user_id, { amount: Number(r.amount), currency: r.currency }]));
  const unlockedSet = new Set(unlocked.map((r) => r.user_id));

  return (
    <Section
      title="Accounts"
      note="Every non-admin account (up to the 500 newest). Segments and the filter happen in the page. 'Last active' is the newest audit-log action — a sign-in, an upload, a rebuild — not a page view."
    >
      <AccountTable
        now={now.getTime()}
        rows={rows.map((r) => {
          const planLive =
            (r.plan === "pack" || r.plan === "pass") && (!r.planExpiresAt || r.planExpiresAt > now);
          const p = paidBy.get(r.id);
          return {
            id: r.id,
            email: r.email,
            name: r.name,
            plan: r.plan,
            accessStatus: r.accessStatus,
            resumes: r._count.resumes,
            rebuilds: runsBy.get(r.id) ?? 0,
            paid: p?.amount ?? 0,
            currency: p?.currency ?? "INR",
            paying: planLive || unlockedSet.has(r.id),
            createdAt: r.createdAt.toISOString(),
            lastActiveAt: lastBy.get(r.id)?.toISOString() ?? null,
          };
        })}
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
          label="Free accounts"
          value={stats.users.total - stats.money.payingUsers}
          sub="Never bought a pass or a pack."
        />
        <Stat
          label="Converted"
          value={stats.money.payingUsers}
          sub={
            stats.users.total
              ? `${Math.round((stats.money.payingUsers / stats.users.total) * 100)}% of accounts have paid at least once`
              : "no accounts yet"
          }
          tone="good"
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

/* ── feedback ────────────────────────────────────────────────────── */

async function Feedback() {
  // Classifies a small batch of whatever is still unsorted, then reads the
  // result of every batch ever run — including this one. Best-effort: see
  // lib/feedback.ts for what happens to a report that fails to classify.
  await classifyPending();

  const [positive, negative, unclassified] = await Promise.all([
    prisma.problemReport.findMany({
      where: { sentiment: "positive" },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { id: true, summary: true, message: true, createdAt: true, user: { select: { email: true } } },
    }),
    prisma.problemReport.findMany({
      where: { sentiment: "negative" },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { id: true, summary: true, message: true, createdAt: true, user: { select: { email: true } } },
    }),
    prisma.problemReport.count({ where: { sentiment: null } }),
  ]);

  return (
    <Section
      title="Feedback"
      note='There is no separate feedback form — every row here started as a report typed into the "Problems" widget. A model reads the text and sorts it into these two columns and writes the one-line summary; nobody is asked to rate anything twice.'
    >
      {unclassified > 0 && (
        <p className="text-muted mt-3 text-xs">
          {unclassified} not yet classified — reload this page to pick up more (12 per visit).
        </p>
      )}
      <div className="mt-3 grid gap-6 md:grid-cols-2">
        <FeedbackColumn title="Positive" tone="good" rows={positive} />
        <FeedbackColumn title="Negative" tone="bad" rows={negative} />
      </div>
    </Section>
  );
}

function FeedbackColumn({
  title,
  tone,
  rows,
}: {
  title: string;
  tone: "good" | "bad";
  rows: { id: string; summary: string | null; message: string; createdAt: Date; user: { email: string } | null }[];
}) {
  return (
    <div>
      <h3 className="font-mono text-[11px] tracking-[0.14em] uppercase opacity-60">
        {title} <span className="text-muted normal-case">· {rows.length}</span>
      </h3>
      {rows.length === 0 ? (
        <p className="text-muted mt-2 text-xs">Nothing here yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.id} className="bg-surface border-border rounded-lg border p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm leading-snug">{r.summary ?? r.message}</p>
                <StatusPill tone={tone}>{tone === "good" ? "+" : "−"}</StatusPill>
              </div>
              <p className="text-muted mt-1.5 font-mono text-[10px] tracking-[0.08em] uppercase">
                {r.user?.email ?? "account deleted"} ·{" "}
                {r.createdAt.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
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

/* ── settings ────────────────────────────────────────────────────── */

async function Settings({ user }: { user: SessionUser }) {
  const [admins, settings] = await Promise.all([
    prisma.user.findMany({ where: { role: "admin" }, orderBy: { email: "asc" }, select: { id: true, email: true } }),
    Promise.resolve(readAdminSettings()),
  ]);

  return (
    <>
      <Section
        title="Feature flags"
        note="File-backed, not database-backed — flipping one of these cannot itself fail because the database is having a bad night. Takes effect immediately, no redeploy."
      >
        <SettingsSwitches
          initial={{
            signupsPaused: settings.signupsPaused,
            rebuildsPaused: settings.rebuildsPaused,
            openSignups: settings.openSignups,
          }}
        />
      </Section>

      <Section
        title="Admin accounts"
        note="Anyone listed here has full access to this page and to every account's data. The last admin cannot be revoked from here."
      >
        <AdminsPanel admins={admins} selfId={user.id} />
      </Section>

      <Section
        title="Plans & quotas"
        note="Read-only. Prices are what Razorpay was told to charge for a live order (see lib/plans.ts, PRODUCTS) — changing one here without changing it there would desync what this page shows from what a receipt says, so both live in code and go through review like anything else that touches billing."
      >
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-border border-b text-left">
                <Th>Plan</Th>
                <Th className="text-right">Resumes</Th>
                <Th className="text-right">Rebuilds/day</Th>
                <Th className="text-right">Advice/day</Th>
                <Th className="text-right">Uploads/day</Th>
                <Th className="text-right">Targets/resume</Th>
              </tr>
            </thead>
            <tbody>
              {(Object.entries(LIMITS) as [keyof typeof LIMITS, (typeof LIMITS)[keyof typeof LIMITS]][]).map(
                ([plan, limits]) => (
                  <tr key={plan} className="border-border border-b last:border-0">
                    <td className="py-2 pr-4 font-medium capitalize">{plan}</td>
                    <td className="py-2 pr-4 text-right font-mono text-xs tabular-nums">
                      {formatLimit(limits.resumes)}
                    </td>
                    <td className="py-2 pr-4 text-right font-mono text-xs tabular-nums">
                      {formatLimit(limits.variantRunsPerDay)}
                    </td>
                    <td className="py-2 pr-4 text-right font-mono text-xs tabular-nums">
                      {formatLimit(limits.adviceRunsPerDay)}
                    </td>
                    <td className="py-2 pr-4 text-right font-mono text-xs tabular-nums">
                      {formatLimit(limits.uploadsPerDay)}
                    </td>
                    <td className="py-2 text-right font-mono text-xs tabular-nums">
                      {formatLimit(limits.targetsPerResume)}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          {Object.values(PRODUCTS).map((p) => (
            <div key={p.sku} className="bg-surface border-border min-w-48 flex-1 rounded-xl border p-4">
              <p className="text-sm font-semibold">{p.name}</p>
              <p className="font-display mt-1 text-xl font-bold">{formatAmount(p.amount, p.currency)}</p>
              <p className="text-muted mt-1 text-xs leading-snug">
                {p.kind === "plan"
                  ? `Grants ${p.grants} for ${p.days} days.`
                  : "Unlocks one company target, permanently."}{" "}
                {p.blurb}
              </p>
            </div>
          ))}
        </div>
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
