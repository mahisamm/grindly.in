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
    /** The SEVEN DAYS BEFORE this week, so a trend chip has a denominator
        that is a real measurement rather than a projection. */
    newWeekBefore: number;
  };
  /** Accounts that DID something in the window — not visitors. */
  active: { day: number; week: number; month: number; weekBefore: number };
  work: {
    resumes: number;
    resumesThisWeek: number;
    rebuilds: number;
    rebuildsThisWeek: number;
    resumesWeekBefore: number;
    rebuildsWeekBefore: number;
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
    /** How every scored resume is distributed across the grade bands. The
        product's own bands, not deciles — a chart that disagreed with the
        letter printed on someone's report would be a second opinion nobody
        asked for. */
    scoreBands: { label: string; range: string; count: number }[];
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
    revenueMonthBefore: number;
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

/** The same count over a closed window, for the previous-period comparison. */
function activeBetween(from: Date, to: Date): Promise<number> {
  return distinctUsers(prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(DISTINCT user_id) AS n
    FROM audit_logs
    WHERE created_at >= ${from} AND created_at < ${to}
      AND user_id IS NOT NULL`);
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
  // The window BEFORE the current one, for every trend chip on the page. A
  // percentage beside a number is a claim about change, and the only honest
  // way to make it is to count the previous period rather than model it.
  const twoWeeks = new Date(now.getTime() - 14 * DAY);
  const twoMonths = new Date(now.getTime() - 60 * DAY);
  const between = (from: Date, to: Date) => ({ gte: from, lt: to });

  const [
    total, pending, approved, blocked, newWeek, newMonth, newWeekBefore,
    activeDay, activeWeek, activeMonth, activeWeekBefore,
    resumes, resumesWeek, resumesWeekBefore,
    rebuilds, rebuildsWeek, rebuildsWeekBefore, runStatusRows, scoreBandRows,
    editorBuilds, coverLetters, exportCount,
    medianScore, medianGain, keptVariants, atFloor,
    uploadedUsers, rebuiltUsers, tookDocUsers,
    revenueAgg, revenueMonthAgg, revenueMonthBeforeAgg, paidOrders, payingUsers,
    applications, replied,
    unresolvedErrors, errorsWeek, providerFailures, openProblems,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { accessStatus: "pending", role: { not: "admin" } } }),
    prisma.user.count({ where: { accessStatus: "approved" } }),
    prisma.user.count({ where: { accessStatus: "blocked" } }),
    prisma.user.count({ where: { createdAt: { gte: week } } }),
    prisma.user.count({ where: { createdAt: { gte: month } } }),
    prisma.user.count({ where: { createdAt: between(twoWeeks, week) } }),

    activeSince(day),
    activeSince(week),
    activeSince(month),
    activeBetween(twoWeeks, week),

    prisma.resume.count(),
    prisma.resume.count({ where: { createdAt: { gte: week } } }),
    prisma.resume.count({ where: { createdAt: between(twoWeeks, week) } }),
    prisma.variantRun.count(),
    prisma.variantRun.count({ where: { startedAt: { gte: week } } }),
    prisma.variantRun.count({ where: { startedAt: between(twoWeeks, week) } }),
    prisma.variantRun.groupBy({ by: ["status"], _count: { _all: true } }),
    // One grouped query rather than five counts, and the cut points are the
    // product's own grade bands — see readiness.grade.
    prisma.$queryRaw<{ band: string; n: bigint }[]>`
      SELECT CASE
               WHEN score >= 90 THEN 'A'
               WHEN score >= 80 THEN 'B'
               WHEN score >= 70 THEN 'C'
               WHEN score >= 55 THEN 'D'
               ELSE 'E'
             END AS band,
             COUNT(*) AS n
      FROM resumes WHERE score IS NOT NULL GROUP BY 1`,

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
    prisma.order.aggregate({
      where: { status: "paid", paidAt: between(twoMonths, month) },
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

  const bandCounts = new Map(scoreBandRows.map((r) => [r.band, Number(r.n)]));
  const scoreBands = [
    { label: "A", range: "90–100" },
    { label: "B", range: "80–89" },
    { label: "C", range: "70–79" },
    { label: "D", range: "55–69" },
    { label: "E", range: "under 55" },
  ].map((b) => ({ ...b, count: bandCounts.get(b.label) ?? 0 }));

  return {
    users: {
      total, pending, approved, blocked,
      newThisWeek: newWeek,
      newThisMonth: newMonth,
      newWeekBefore,
    },
    active: {
      day: activeDay,
      week: activeWeek,
      month: activeMonth,
      weekBefore: activeWeekBefore,
    },
    work: {
      resumes,
      resumesThisWeek: resumesWeek,
      resumesWeekBefore,
      rebuilds,
      rebuildsThisWeek: rebuildsWeek,
      rebuildsWeekBefore,
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
      scoreBands,
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
      revenueMonthBefore: revenueMonthBeforeAgg._sum.amount ?? 0,
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

/* ── conversion ──────────────────────────────────────────────────── */

export type ConversionStats = {
  /** Non-admin, approved accounts — the population a conversion rate is over. */
  approved: number;
  /** Has at least one paid order, ever. */
  everPaid: number;
  /** Plan is pack/pass and has not expired, OR holds a per-company unlock. */
  payingNow: number;
  /** Did something in the last 30 days (audit log). */
  activeMonth: number;
  /** Paid in the last 30 days. */
  paidThisMonth: number;
  /** everPaid / approved, and paidThisMonth / activeMonth — both in percent. */
  rateLifetime: number | null;
  rateActive: number | null;
};

/**
 * Who pays, out of whom. Two rates because they answer different questions:
 * lifetime (of everyone we ever let in, how many ever paid) is the number a
 * business plan wants; the 30-day active rate (of people actually using it
 * this month, how many paid this month) is the one that moves when the
 * product changes. Both are ratios of counted rows, nothing modelled.
 */
export async function conversionStats(now = new Date()): Promise<ConversionStats> {
  const month = new Date(now.getTime() - 30 * DAY);
  const nonAdmin = { role: { not: "admin" as const }, deletedAt: null };
  const [approved, everPaid, payingPlan, unlocked, activeMonth, paidThisMonth] = await Promise.all([
    prisma.user.count({ where: { ...nonAdmin, accessStatus: "approved" } }),
    distinctUsers(prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(DISTINCT o.user_id) AS n FROM orders o
      JOIN users u ON u.id = o.user_id
      WHERE o.status = 'paid' AND u.role <> 'admin'`),
    prisma.user.count({
      where: {
        ...nonAdmin,
        plan: { in: ["pack", "pass"] },
        OR: [{ planExpiresAt: null }, { planExpiresAt: { gt: now } }],
      },
    }),
    distinctUsers(prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(DISTINCT t.user_id) AS n FROM targets t
      JOIN users u ON u.id = t.user_id
      WHERE t.unlocked_at IS NOT NULL AND u.role <> 'admin'
        AND NOT (u.plan IN ('pack','pass') AND (u.plan_expires_at IS NULL OR u.plan_expires_at > NOW()))`),
    activeSince(month),
    distinctUsers(prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(DISTINCT o.user_id) AS n FROM orders o
      JOIN users u ON u.id = o.user_id
      WHERE o.status = 'paid' AND o.paid_at >= ${month} AND u.role <> 'admin'`),
  ]);
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  return {
    approved,
    everPaid,
    payingNow: payingPlan + unlocked,
    activeMonth,
    paidThisMonth,
    rateLifetime: pct(everPaid, approved),
    rateActive: pct(paidThisMonth, activeMonth),
  };
}

/* ── traffic ─────────────────────────────────────────────────────── */

export type TrafficWindow = { views: number; visitors: number; signedIn: number };
export type TrafficStats = {
  /** Distinct visitors with a page view in the last 5 minutes. */
  activeNow: number;
  today: TrafficWindow;
  week: TrafficWindow;
  month: TrafficWindow;
  /** Most-viewed paths in the last 30 days. */
  topPaths: { path: string; views: number }[];
  /** Tagged campaign source or referring hostname, grouped for the operator. */
  topSources: { source: string; views: number }[];
  /** Page views per day for the last 30 days, oldest first, empty days as 0. */
  byDay: { date: string; count: number }[];
  /** When the first view was recorded, so an empty panel can say so. */
  firstSeen: Date | null;
};

/**
 * Page views, from the beacon (components/TrafficBeacon.tsx → api/track).
 * "Today" is the UTC day — said on the panel — because the operator and the
 * box are in different timezones and a dashboard that rolls over at a
 * different hour on each machine is a dashboard nobody can reconcile.
 */
export async function trafficStats(now = new Date()): Promise<TrafficStats> {
  const fiveMin = new Date(now.getTime() - 5 * 60 * 1000);
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const week = new Date(now.getTime() - 7 * DAY);
  const month = new Date(now.getTime() - 30 * DAY);

  const win = async (since: Date): Promise<TrafficWindow> => {
    const rows = await prisma.$queryRaw<{ views: bigint; visitors: bigint; signed_in: bigint }[]>`
      SELECT COUNT(*) AS views,
             COUNT(DISTINCT visitor_id) AS visitors,
             COUNT(DISTINCT user_id) AS signed_in
      FROM page_views WHERE created_at >= ${since}`.catch(() => []);
    const r = rows[0];
    return {
      views: Number(r?.views ?? 0),
      visitors: Number(r?.visitors ?? 0),
      signedIn: Number(r?.signed_in ?? 0),
    };
  };

  const [activeNow, today, wk, mo, top, sources, days, first] = await Promise.all([
    distinctUsers(prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(DISTINCT visitor_id) AS n FROM page_views WHERE created_at >= ${fiveMin}`),
    win(dayStart),
    win(week),
    win(month),
    prisma.$queryRaw<{ path: string; views: bigint }[]>`
      SELECT path, COUNT(*) AS views FROM page_views
      WHERE created_at >= ${month}
      GROUP BY path ORDER BY views DESC LIMIT 8`.catch(() => []),
    prisma.$queryRaw<{ source: string; views: bigint }[]>`
      SELECT COALESCE(utm_source, referrer_host) AS source, COUNT(*) AS views
      FROM page_views
      WHERE created_at >= ${month}
        AND COALESCE(utm_source, referrer_host) IS NOT NULL
      GROUP BY 1 ORDER BY views DESC LIMIT 8`.catch(() => []),
    prisma.$queryRaw<{ day: Date; n: bigint }[]>`
      SELECT date_trunc('day', created_at) AS day, COUNT(*) AS n
      FROM page_views WHERE created_at >= ${month}
      GROUP BY 1 ORDER BY 1`.catch(() => []),
    prisma.pageView.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }).catch(() => null),
  ]);

  const counts = new Map<string, number>();
  for (let i = 0; i < 30; i++) {
    counts.set(new Date(month.getTime() + i * DAY).toISOString().slice(0, 10), 0);
  }
  for (const row of days) {
    const key = new Date(row.day).toISOString().slice(0, 10);
    if (counts.has(key)) counts.set(key, Number(row.n));
  }

  return {
    activeNow,
    today,
    week: wk,
    month: mo,
    topPaths: top.map((r) => ({ path: r.path, views: Number(r.views) })),
    topSources: sources.map((r) => ({ source: r.source, views: Number(r.views) })),
    byDay: [...counts.entries()].map(([date, count]) => ({ date, count })),
    firstSeen: first?.createdAt ?? null,
  };
}

/* ── revenue ─────────────────────────────────────────────────────── */

export type RevenueSeries = {
  currency: string;
  /** Smallest unit per day, last 30 days, oldest first, empty days as 0. */
  byDay: { date: string; count: number }[];
  /** Per calendar month, last 12, oldest first. */
  byMonth: { month: string; amount: number; orders: number }[];
  today: number;
  week: number;
  month: number;
  allTime: number;
  /** Paid orders in a currency other than the main one — listed apart rather
      than silently summed into the wrong unit. */
  otherCurrencies: { currency: string; amount: number; orders: number }[];
};

/**
 * Money in, by when it was PAID (paid_at), never by when the order was created
 * — an order created and abandoned is not revenue. Sums are in the smallest
 * unit (paise); the panel formats. One main currency: the one with the most
 * paid orders (INR today); anything else is listed apart.
 */
export async function revenueSeries(now = new Date()): Promise<RevenueSeries> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const week = new Date(now.getTime() - 7 * DAY);
  const month = new Date(now.getTime() - 30 * DAY);
  const year = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));

  const byCurrency = await prisma.order
    .groupBy({
      by: ["currency"],
      where: { status: "paid" },
      _sum: { amount: true },
      _count: { _all: true },
    })
    .catch(() => []);
  const sorted = [...byCurrency].sort((a, b) => b._count._all - a._count._all);
  const main = sorted[0]?.currency ?? "INR";
  const other = sorted
    .filter((c) => c.currency !== main)
    .map((c) => ({ currency: c.currency, amount: c._sum.amount ?? 0, orders: c._count._all }));

  const sum = async (since: Date | null) => {
    const r = await prisma.order.aggregate({
      where: { status: "paid", currency: main, ...(since ? { paidAt: { gte: since } } : {}) },
      _sum: { amount: true },
    });
    return r._sum.amount ?? 0;
  };

  const [today, wk, mo, all, dayRows, monthRows] = await Promise.all([
    sum(dayStart),
    sum(week),
    sum(month),
    sum(null),
    prisma.$queryRaw<{ day: Date; amount: bigint }[]>`
      SELECT date_trunc('day', paid_at) AS day, COALESCE(SUM(amount),0) AS amount
      FROM orders WHERE status = 'paid' AND currency = ${main} AND paid_at >= ${month}
      GROUP BY 1 ORDER BY 1`.catch(() => []),
    prisma.$queryRaw<{ month: Date; amount: bigint; orders: bigint }[]>`
      SELECT date_trunc('month', paid_at) AS month, COALESCE(SUM(amount),0) AS amount, COUNT(*) AS orders
      FROM orders WHERE status = 'paid' AND currency = ${main} AND paid_at >= ${year}
      GROUP BY 1 ORDER BY 1`.catch(() => []),
  ]);

  const days = new Map<string, number>();
  for (let i = 0; i < 30; i++) days.set(new Date(month.getTime() + i * DAY).toISOString().slice(0, 10), 0);
  for (const r of dayRows) {
    const key = new Date(r.day).toISOString().slice(0, 10);
    if (days.has(key)) days.set(key, Number(r.amount));
  }
  const months = new Map<string, { amount: number; orders: number }>();
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(year.getUTCFullYear(), year.getUTCMonth() + i, 1));
    months.set(d.toISOString().slice(0, 7), { amount: 0, orders: 0 });
  }
  for (const r of monthRows) {
    const key = new Date(r.month).toISOString().slice(0, 7);
    if (months.has(key)) months.set(key, { amount: Number(r.amount), orders: Number(r.orders) });
  }

  return {
    currency: main,
    byDay: [...days.entries()].map(([date, count]) => ({ date, count })),
    byMonth: [...months.entries()].map(([month, v]) => ({ month, ...v })),
    today,
    week: wk,
    month: mo,
    allTime: all,
    otherCurrencies: other,
  };
}

/* ── tickets ─────────────────────────────────────────────────────── */

export type TicketStats = {
  open: number;
  /** Human-handled, not closed, and the ball is with the team (the user or the
      assistant's hand-over note spoke last). Assistant-handled conversations
      are not in it: the assistant is replying. */
  awaitingYou: number;
  /** Still with the assistant and not closed. */
  withAssistant: number;
  answered: number;
  closed: number;
  /** Human-handled conversations with something the operator has not opened yet. */
  unread: number;
};

export async function ticketStats(): Promise<TicketStats> {
  const [open, answered, closed, awaitingYou, withAssistant, unread] = await Promise.all([
    prisma.ticket.count({ where: { status: "open" } }),
    prisma.ticket.count({ where: { status: "answered" } }),
    prisma.ticket.count({ where: { status: "closed" } }),
    prisma.ticket.count({ where: { status: { not: "closed" }, handledBy: "human", lastMessageBy: { not: "admin" } } }),
    prisma.ticket.count({ where: { status: { not: "closed" }, handledBy: "assistant" } }),
    prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM tickets
      WHERE handled_by = 'human' AND last_message_by <> 'admin' AND status <> 'closed'
        AND (admin_seen_at IS NULL OR admin_seen_at < last_message_at)`
      .then((r) => Number(r[0]?.n ?? 0))
      .catch(() => 0),
  ]);
  return { open, answered, closed, awaitingYou, withAssistant, unread };
}

/** The assistant's summaries of every conversation that currently needs a
    person — what the dashboard shows as "what users are struggling with". */
export async function strugglingNow(limit = 6) {
  return prisma.ticket.findMany({
    where: { status: { not: "closed" }, handledBy: "human" },
    orderBy: { lastMessageAt: "desc" },
    take: limit,
    select: {
      id: true, subject: true, summary: true, category: true, lastMessageAt: true, lastMessageBy: true,
      user: { select: { email: true } },
    },
  });
}
