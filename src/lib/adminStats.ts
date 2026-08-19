/**
 * The numbers an operator of THIS product actually needs.
 *
 * Written against what the database can honestly answer, which is a shorter
 * list than a generic analytics dashboard offers and a more useful one. Two
 * things are deliberately absent:
 *
 *   PAGE VIEWS AND SESSIONS. Nothing in this application records a request.
 *   There is no tracking script, no first-party analytics table, and adding one
 *   to a product whose landing page is about not collecting things people did
 *   not agree to is a decision for its owner, not a side effect of building a
 *   dashboard. So "active users" here means accounts that DID something —
 *   measured from the audit log — and the panel says so rather than implying it
 *   counts visitors.
 *
 *   ANYTHING PREDICTIVE. No churn score, no projected revenue. With single
 *   digits of users those are noise wearing a suit.
 *
 * Every figure below is a count of rows that exist. The panel prints them next
 * to what they were computed from, so a number that looks wrong can be checked.
 */
import { prisma } from "./prisma";

const DAY = 86_400_000;

export type Range = { label: string; since: Date };

export type AdminStats = {
  users: {
    total: number;
    pending: number;
    approved: number;
    blocked: number;
    newThisWeek: number;
    newThisMonth: number;
  };
  /** Accounts that DID something in the window — not visitors. */
  active: { day: number; week: number; month: number };
  work: {
    resumes: number;
    resumesThisWeek: number;
    rebuilds: number;
    rebuildsThisWeek: number;
    /** Rebuild outcomes, so a rising failure rate is visible before a user reports it. */
    runsByStatus: Record<string, number>;
    editorBuilds: number;
    coverLetters: number;
    exports: number;
  };
  quality: {
    /** Median first score across every resume that has one. */
    medianScore: number | null;
    /** Median points gained by a kept rebuild over the resume it came from. */
    medianGain: number | null;
    /** Rebuilds that cleared the shippable floor, as a share of those kept. */
    atOrAboveFloor: number;
    keptVariants: number;
  };
  funnel: {
    signedUp: number;
    uploaded: number;
    rebuilt: number;
    tookADocument: number;
  };
  money: {
    /** Paise. */
    revenue: number;
    revenueThisMonth: number;
    paidOrders: number;
    payingUsers: number;
  };
  applications: { logged: number; replied: number };
  health: {
    unresolvedErrors: number;
    errorsThisWeek: number;
    providerFailures: number;
    openProblemReports: number;
  };
};

/**
 * Distinct accounts with an audit entry since `since`.
 *
 * COUNT(DISTINCT ...) in Postgres, not `findMany({ distinct })` in Prisma.
 * Prisma's version issues SELECT DISTINCT ON and then ships one row per
 * matching account across the wire so that `.length` can be taken in Node — so
 * this panel, which asks the question four times over different windows,
 * transferred four copies of the user table to render four integers. The audit
 * log is the largest table in the schema and grows fastest.
 */
async function distinctUsers(sql: Promise<{ n: bigint | number }[]>): Promise<number> {
  const rows = await sql.catch(() => [] as { n: bigint | number }[]);
  return Number(rows[0]?.n ?? 0);
}

function activeSince(since: Date): Promise<number> {
  return distinctUsers(prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(DISTINCT user_id) AS n
    FROM audit_logs
    WHERE created_at >= ${since} AND user_id IS NOT NULL`);
}

/** One median, computed in Postgres rather than by pulling every row into Node. */
async function median(sql: Promise<{ median: number | null }[]>): Promise<number | null> {
  const rows = await sql.catch(() => [] as { median: number | null }[]);
  return rows[0]?.median ?? null;
}

export async function adminStats(now = new Date()): Promise<AdminStats> {
  const day = new Date(now.getTime() - DAY);
  const week = new Date(now.getTime() - 7 * DAY);
  const month = new Date(now.getTime() - 30 * DAY);

  const [
    total, pending, approved, blocked, newWeek, newMonth,
    activeDay, activeWeek, activeMonth,
    resumes, resumesWeek, rebuilds, rebuildsWeek, runStatusRows,
    editorBuilds, coverLetters, exportCount,
    medianScore, medianGain, keptVariants, atFloor,
    uploadedUsers, rebuiltUsers, tookDocUsers,
    revenueAgg, revenueMonthAgg, paidOrders, payingUsers,
    applications, replied,
    unresolvedErrors, errorsWeek, providerFailures, openProblems,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { accessStatus: "pending", role: { not: "admin" } } }),
    prisma.user.count({ where: { accessStatus: "approved" } }),
    prisma.user.count({ where: { accessStatus: "blocked" } }),
    prisma.user.count({ where: { createdAt: { gte: week } } }),
    prisma.user.count({ where: { createdAt: { gte: month } } }),

    activeSince(day),
    activeSince(week),
    activeSince(month),

    prisma.resume.count(),
    prisma.resume.count({ where: { createdAt: { gte: week } } }),
    prisma.variantRun.count(),
    prisma.variantRun.count({ where: { startedAt: { gte: week } } }),
    prisma.variantRun.groupBy({ by: ["status"], _count: { _all: true } }),

    prisma.auditLog.count({ where: { action: "resume_built" } }),
    prisma.auditLog.count({ where: { action: "cover_letter" } }),
    prisma.auditLog.count({ where: { action: "resume_export" } }),

    median(prisma.$queryRaw<{ median: number | null }[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY score)::int AS median
      FROM resumes WHERE score IS NOT NULL`),
    median(prisma.$queryRaw<{ median: number | null }[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY score - baseline_score)::int AS median
      FROM variants WHERE beats_baseline = true`),
    prisma.variant.count(),
    prisma.variant.count({ where: { score: { gte: 80 } } }),

    // The funnel, measured as DISTINCT ACCOUNTS that reached each step — not as
    // event counts, which one enthusiastic user can inflate on their own.
    // Counted in Postgres for the reason given on `distinctUsers`.
    distinctUsers(prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(DISTINCT user_id) AS n FROM resumes`),
    distinctUsers(prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(DISTINCT user_id) AS n FROM variant_runs`),
    distinctUsers(prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(DISTINCT user_id) AS n FROM audit_logs
      WHERE user_id IS NOT NULL AND action IN ('resume_export', 'resume_built')`),

    prisma.order.aggregate({ where: { status: "paid" }, _sum: { amount: true } }),
    prisma.order.aggregate({
      where: { status: "paid", paidAt: { gte: month } },
      _sum: { amount: true },
    }),
    prisma.order.count({ where: { status: "paid" } }),
    distinctUsers(prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(DISTINCT user_id) AS n FROM orders WHERE status = 'paid'`),

    prisma.application.count(),
    prisma.application.count({
      where: { status: { in: ["screening", "interview", "offer"] } },
    }),

    prisma.errorEvent.count({ where: { resolvedAt: null } }),
    prisma.errorEvent.count({ where: { lastSeenAt: { gte: week } } }),
    prisma.errorEvent.count({ where: { kind: "llm-provider", resolvedAt: null } }),
    prisma.problemReport.count({ where: { resolvedAt: null } }),
  ]);

  const runsByStatus: Record<string, number> = {};
  for (const row of runStatusRows) runsByStatus[row.status] = row._count._all;

  return {
    users: {
      total, pending, approved, blocked,
      newThisWeek: newWeek,
      newThisMonth: newMonth,
    },
    active: { day: activeDay, week: activeWeek, month: activeMonth },
    work: {
      resumes,
      resumesThisWeek: resumesWeek,
      rebuilds,
      rebuildsThisWeek: rebuildsWeek,
      runsByStatus,
      editorBuilds,
      coverLetters,
      exports: exportCount,
    },
    quality: {
      medianScore,
      medianGain,
      atOrAboveFloor: atFloor,
      keptVariants,
    },
    funnel: {
      signedUp: total,
      uploaded: uploadedUsers,
      rebuilt: rebuiltUsers,
      tookADocument: tookDocUsers,
    },
    money: {
      revenue: revenueAgg._sum.amount ?? 0,
      revenueThisMonth: revenueMonthAgg._sum.amount ?? 0,
      paidOrders,
      payingUsers,
    },
    applications: { logged: applications, replied },
    health: {
      unresolvedErrors,
      errorsThisWeek: errorsWeek,
      providerFailures,
      openProblemReports: openProblems,
    },
  };
}

/**
 * Signups per day for the last `days`, oldest first.
 *
 * Returned with the empty days filled in. A chart that silently omits the days
 * nobody signed up compresses a quiet fortnight into one tick and makes a flat
 * line look like growth.
 */
export async function signupsByDay(days = 30, now = new Date()): Promise<{ date: string; count: number }[]> {
  const since = new Date(now.getTime() - days * DAY);
  const rows = await prisma.user.findMany({
    where: { createdAt: { gte: since } },
    select: { createdAt: true },
  });

  const counts = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * DAY).toISOString().slice(0, 10);
    counts.set(d, 0);
  }
  for (const row of rows) {
    const key = row.createdAt.toISOString().slice(0, 10);
    if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([date, count]) => ({ date, count }));
}

/**
 * Accounts created in the last `days`, newest first.
 *
 * Lives here rather than inline in the page for one specific reason: a
 * component may not read the clock. `Date.now()` in a render is impure — two
 * renders can disagree about what "this week" means — and the lint rule that
 * enforces it is right even for a server component. Every window on that page
 * is therefore measured inside this module, where taking the time is just
 * taking the time.
 */
export async function recentSignups(days = 7, now = new Date()) {
  return prisma.user.findMany({
    where: { createdAt: { gte: new Date(now.getTime() - days * DAY) } },
    orderBy: { createdAt: "desc" },
    take: 15,
    select: {
      id: true,
      email: true,
      plan: true,
      createdAt: true,
      accessStatus: true,
      _count: { select: { resumes: true } },
    },
  });
}
