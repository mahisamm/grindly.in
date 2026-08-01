import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { internshalaLoginEnabled } from "@/lib/featureFlags";
import { gmailScanEnabled, gmailScanBeta } from "@/lib/googleOAuth";
import { visibleToUser } from "@/lib/pipeline";
import { getQuota } from "@/lib/quota";
import { hasAppAccess } from "@/lib/access";
import { autoApplyMode, agentWillSend } from "@/lib/applyPolicy";
import { notifyChannels } from "@/lib/notifyChannels";
import { PROFF_FIELDS, unfilledFacts } from "@/lib/proffQuestions";

const PLATFORMS = ["internshala"] as const;

// No-hang watchdog: a login that's been "connecting" longer than this with no
// progress is treated as timed out (worker down/slow) so the UI never spins
// forever. OTP gets a longer grace window since the user must fetch a code.
const CONNECTING_TIMEOUT_MS = 120_000;
const OTP_TIMEOUT_MS = 360_000;

// A live run older than this is treated as no-longer-active when deriving the
// "Agent working…" state. If a worker dies mid-run and leaves status="running"
// in the DB, without this guard activeRun would stay non-null forever and freeze
// the run button. Generous enough to never cut a genuinely-running job short.
const ACTIVE_RUN_MAX_AGE_MS = 20 * 60_000;

// The web flips resumeVariantStatus to "generating" and enqueues the optimize run
// a moment later. Inside that gap "generating with no run" is normal, not wedged.
const VARIANT_ENQUEUE_GRACE_MS = 30_000;

export async function GET() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: uid },
    include: {
      profile: true,
      // Only applications the user is allowed to see. Future-dated matches — the
      // rest of the month's pipeline — are deliberately withheld and surfaced as
      // a bare count below. See lib/pipeline.ts.
      applications: {
        where: visibleToUser(uid),
        orderBy: { createdAt: "desc" },
        take: 100,
      },
      reports: { orderBy: { date: "desc" }, take: 14 },
    },
  });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Everything still embargoed. A number, never a list.
  const queued = await prisma.application.count({
    where: { userId: uid, status: "matched", scheduledFor: { gt: new Date() } },
  });

  // Is a "Run agent" job in flight right now? The dashboard uses this so the
  // button reads "Agent working…" and stays disabled across reloads/tab-switches
  // until the run actually finishes — instead of resetting to "Run agent" the
  // moment the local timer lapses, which looked like nothing was happening.
  // Analyze/latex/connect jobs aren't user-facing agent runs, so exclude them.
  const activeRunRow = await prisma.agentRun
    .findFirst({
      where: {
        userId: uid,
        status: { in: ["queued", "running"] },
        mode: { in: ["live", "approved"] },
        createdAt: { gte: new Date(Date.now() - ACTIVE_RUN_MAX_AGE_MS) },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, createdAt: true },
    })
    .catch(() => null);
  const activeRun = activeRunRow
    ? { id: activeRunRow.id, status: activeRunRow.status, startedAt: activeRunRow.createdAt }
    : null;

  // "Building…" is written by the web the instant Generate is pressed, and only
  // ever cleared by the worker. So any way the worker fails to reach its own
  // status write — container restart, a run reclaimed as stale, an exception
  // before the first set_variant_status — leaves the card reading "Building…"
  // with the Generate button hidden. Forever: nothing but re-uploading the master
  // resume resets it, and there is no reason a user would guess that.
  //
  // Derive it from the job instead of trusting the flag. No optimize run queued
  // or running means nothing is being built, whatever the column says. Same
  // shape as ACTIVE_RUN_MAX_AGE_MS above, with the grace window covering the
  // gap between the status write and the enqueue that follows it.
  let profile = user.profile;
  if (
    profile?.resumeVariantStatus === "generating" &&
    Date.now() - new Date(profile.updatedAt).getTime() > VARIANT_ENQUEUE_GRACE_MS
  ) {
    const building = await prisma.agentRun
      .findFirst({
        where: { userId: uid, mode: "optimize", status: { in: ["queued", "running"] } },
        select: { id: true },
      })
      // A DB blip must not wipe out a build that is genuinely running.
      .catch(() => ({ id: "assume-building" }));
    if (!building) {
      profile = {
        ...profile,
        resumeVariantStatus: "error",
        resumeVariantDetail:
          "That build stopped before it finished — press Generate to try again.",
      };
    }
  }

  // What the agent is stuck on that only this user can answer.
  //
  // It refuses to invent a fact, which is right — but for three real
  // applications in a row that refusal was invisible: the boxes it needed
  // (date of birth, expected stipend, graduation month) were folded away in
  // setup, so they were blank on every account, and the user's dashboard just
  // showed applications that never sent. The agent records the setup keys it
  // stopped for; this turns them into one prompt naming the boxes.
  //
  // Deliberately NOT read off `applications` above: that list is capped and
  // visibility-filtered, and a stalled application the user has not been shown
  // yet is exactly the one worth asking about.
  let setupGaps: { key: string; label: string; help: string; waiting: number }[] = [];
  // No profile row means setup was never started, so every fact reads as blank
  // and this would name all of them at someone who has not seen an application
  // yet. Onboarding is the right place to meet that person.
  if (profile) try {
    const stalled = await prisma.application.findMany({
      where: { userId: uid, blockingFacts: { not: null }, status: { in: ["needs_review", "matched", "approved"] } },
      select: { blockingFacts: true },
      take: 200,
    });
    const waiting = new Map<string, number>();
    for (const row of stalled) {
      let keys: unknown;
      try {
        keys = JSON.parse(row.blockingFacts || "[]");
      } catch {
        continue; // a malformed row must never break the dashboard
      }
      if (!Array.isArray(keys)) continue;
      // Re-ask the LIVE profile, because the row is a snapshot of the moment the
      // agent refused. Without this the prompt would keep asking for a date of
      // birth that has been on file for a week, and only clear when the agent
      // next happened to run.
      const answers = profile as unknown as Record<string, unknown>;
      for (const f of unfilledFacts(keys.filter((k): k is string => typeof k === "string"), answers)) {
        waiting.set(f.key, (waiting.get(f.key) ?? 0) + 1);
      }
    }
    setupGaps = [...waiting.entries()]
      .map(([key, n]) => {
        const f = PROFF_FIELDS.find((x) => x.key === key)!;
        return { key, label: f.label, help: f.help, waiting: n };
      })
      .sort((a, b) => b.waiting - a.waiting || a.label.localeCompare(b.label));
  } catch {
    // Ignore — prisma db push not yet run for blocking_facts.
  }

  // In-app notifications feed — folded into /api/me (already polled) so the
  // dashboard bell costs no extra request. Two cheap indexed queries.
  const [notifItems, notifUnread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: uid, channel: "inapp" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, tier: true, title: true, body: true, readAt: true, createdAt: true },
    }).catch(() => []),
    prisma.notification.count({ where: { userId: uid, channel: "inapp", readAt: null } }).catch(() => 0),
  ]);

  // Load integrations (graceful if table not yet migrated)
  let integrationRows: {
    platform: string; status: string; connectedAt: Date | null;
    otpRequired?: boolean; lastError?: string | null; updatedAt?: Date | null;
  }[] = [];
  try {
    integrationRows = await prisma.userIntegration.findMany({ where: { userId: uid } });
  } catch {
    // Ignore — prisma db push not yet run
  }

  // Watchdog: downgrade a stuck "connecting"/"otp_required" row so the dashboard
  // shows a retry instead of an endless spinner if the worker never resolves it.
  for (const r of integrationRows) {
    const age = r.updatedAt ? Date.now() - new Date(r.updatedAt).getTime() : 0;
    const stuckConnecting = r.status === "connecting" && age > CONNECTING_TIMEOUT_MS;
    const stuckOtp = r.status === "otp_required" && age > OTP_TIMEOUT_MS;
    if (stuckConnecting || stuckOtp) {
      r.status = "needs_login";
      r.otpRequired = false;
      r.lastError = stuckOtp
        ? "Login timed out waiting for the code — please try again."
        : "Login is taking too long — please try again.";
      try {
        await prisma.userIntegration.update({
          where: { userId_platform: { userId: uid, platform: r.platform } },
          data: { status: "needs_login", otpRequired: false, otpCode: null, lastError: r.lastError },
        });
      } catch {
        // best-effort — the UI already reflects the downgrade
      }
    }
  }

  // ATS-optimized resume variants ("3 better versions"), best score first. Rows
  // exist after the user clicks Generate; ones that beat the master rank first,
  // and ones that didn't are still returned so the dashboard can show them as
  // preview-only rather than showing nothing at all (see agent/resume_optimize.py
  // — discarding them read to beta users as a broken feature). Compare score vs
  // baselineScore to tell them apart. `changes` is a JSON string on disk; parse
  // it here so the client renders a plain array.
  const variantRows = await prisma.resumeVariant
    .findMany({
      where: { userId: uid },
      orderBy: { rank: "asc" },
      select: {
        id: true, rank: true, label: true, score: true, grade: true,
        baselineScore: true, changes: true,
      },
    })
    .catch(() => []);
  const resumeVariants = variantRows.map((v) => {
    let changes: string[] = [];
    try {
      const parsed = JSON.parse(v.changes) as unknown;
      if (Array.isArray(parsed)) changes = parsed.map((x) => String(x));
    } catch {
      /* malformed — show the variant without its change list rather than 500 */
    }
    return {
      id: v.id, rank: v.rank, label: v.label, score: v.score,
      grade: v.grade, baselineScore: v.baselineScore, changes,
    };
  });

  const byPlatform = Object.fromEntries(integrationRows.map((r) => [r.platform, r]));
  const integrations = PLATFORMS.map((p) => ({
    platform: p,
    status: byPlatform[p]?.status ?? (p === "internshala" && user.internshalaConnected ? "connected" : "disconnected"),
    connectedAt: byPlatform[p]?.connectedAt ?? null,
    otpRequired: byPlatform[p]?.otpRequired ?? false,
    lastError: byPlatform[p]?.lastError ?? null,
  }));
  const gmailConnected = byPlatform["gmail"]?.status === "connected";

  const apps = user.applications;

  // Counted in the DB, NOT over `apps`.
  //
  // `apps` is the 100 newest rows — a page, for rendering the list. Deriving the
  // headline totals from it meant that the moment a user passed 100 rows (which
  // matched + skipped reach quickly), their lifetime "Applied" number and their
  // interview rate began to SHRINK as older applications fell off the page. The
  // one number that tells someone whether the product is working was quietly
  // decaying, and it looked like the agent was undoing their work.
  const scope = visibleToUser(uid);
  const [byStatus, interviews, offers, outcomeReported] = await Promise.all([
    prisma.application.groupBy({
      by: ["status"],
      where: scope,
      _count: { _all: true },
    }),
    prisma.application.count({
      where: { ...scope, status: "applied", outcome: { in: ["interview", "offer"] } },
    }),
    prisma.application.count({ where: { ...scope, status: "applied", outcome: "offer" } }),
    prisma.application.count({
      where: { ...scope, status: "applied", outcome: { not: null } },
    }),
  ]);
  const countOf = (s: string) =>
    byStatus.find((g) => g.status === s)?._count._all ?? 0;

  const stats = {
    // Every "matched" row this user may see has come due — the rest of the
    // month's pipeline never leaves the server (src/lib/pipeline.ts). So this IS
    // the ready-to-send count, not the pipeline size.
    ready: countOf("matched"),
    // The rest of the month, as a number only. The user is told the work exists;
    // they are not handed the list.
    queued,
    approved: countOf("approved"),
    // everything the agent has looked at and scored, whatever the verdict
    reviewed: byStatus.reduce((s, g) => s + g._count._all, 0),
    applied: countOf("applied"),
    skipped: countOf("skipped"),
    failed: countOf("failed"),
    needsReview: countOf("needs_review"),
    // Still page-scoped, and that is fine: an average over the most recent 100
    // scored listings is a more useful "how well am I matching lately" number
    // than a lifetime mean, and nothing downstream reads it as a total.
    avgScore: apps.length
      ? Math.round(apps.reduce((s, a) => s + a.matchScore, 0) / apps.length)
      : 0,
    interviews,
    offers,
    outcomeReported,
    // % of applications (with a reported outcome) that led to an interview/offer
    interviewRate: outcomeReported ? Math.round((interviews / outcomeReported) * 100) : null,
  };
  const quota = await getQuota(uid, user.plan);

  // Trim the heavy Apply-Kit fields off rows the dashboard never renders a kit
  // for. /api/me is polled every ~12s; shipping up to 100 cover letters + answer
  // blobs on every poll is pure waste. The kit UI shows on "matched" (today's
  // due batch, ≤ a day's cap) AND "approved" ("To submit" — the user clicked
  // Open & submit and is exactly when the kit is most useful); anything else
  // (applied/failed/skipped history) never renders a kit and gets trimmed.
  const slimApps = apps.map((a) =>
    a.status === "matched" || a.status === "approved" ? a : { ...a, coverLetterText: null, answersJson: null },
  );

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      paid: user.paid,
      plan: user.plan,
      status: user.status,
      accessStatus: user.accessStatus,
      // Owner-aware access verdict computed server-side (honors OWNER_EMAIL, which
      // the client can't see) so the waitlist/onboarding/dashboard gates stop
      // re-deriving access from role/accessStatus alone and wrongly bouncing an
      // owner whose row is still role=user/pending.
      hasAccess: hasAppAccess(user),
      role: user.role,
      slackConnected: user.slackConnected,
      slackUserId: user.slackUserId,
      internshalaConnected: user.internshalaConnected,
      gmailConnected,
      gmailScanEnabled: gmailScanEnabled(),
      // Per-user: only allowlisted testers see the live Connect flow; everyone
      // else gets the waitlist link. See gmailScanBeta() in lib/googleOAuth.
      gmailScanBeta: gmailScanBeta(user.email),
      internshalaLoginEnabled: internshalaLoginEnabled(user),
      paymentsEnabled: process.env.PAYMENTS_ENABLED === "true",
    },
    profile,
    setupGaps,
    applications: slimApps,
    reports: user.reports,
    stats,
    // What the agent is actually allowed to send on this deploy, so the UI can
    // stop stating "you always submit it yourself" as an absolute. That sentence
    // is true today (shadow mode) and becomes a lie the moment routing goes live
    // — and a dashboard that tells someone to go finish an application the agent
    // already sent is worse than one that promised nothing.
    //
    // sendsAny is computed from THIS user's real rows, not from the mode alone:
    // a user whose matches are all board-only sees no agent-sent applications
    // even in live mode, and should not be told otherwise.
    autoApply: {
      mode: autoApplyMode(),
      sendsAny: slimApps.some((a) => agentWillSend(a)),
    },
    quota,
    integrations,
    resumeVariants,
    activeRun,
    notifications: {
      unread: notifUnread,
      items: notifItems.map((n) => ({ ...n, read: n.readAt !== null })),
    },
    // Which report channels this deploy can actually deliver on, so setup stops
    // offering an inbox nothing sends to. See lib/notifyChannels.ts.
    notifyChannels: notifyChannels(),
  });
}
