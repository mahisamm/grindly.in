import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { internshalaLoginEnabled } from "@/lib/featureFlags";
import { gmailScanEnabled } from "@/lib/googleOAuth";
import { visibleToUser } from "@/lib/pipeline";
import { getQuota } from "@/lib/quota";

const PLATFORMS = ["linkedin", "internshala", "naukri", "unstop", "indeed"] as const;

// No-hang watchdog: a login that's been "connecting" longer than this with no
// progress is treated as timed out (worker down/slow) so the UI never spins
// forever. OTP gets a longer grace window since the user must fetch a code.
const CONNECTING_TIMEOUT_MS = 120_000;
const OTP_TIMEOUT_MS = 360_000;

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
  const appliedApps = apps.filter((a) => a.status === "applied");
  // beta funnel: interview rate is the headline product-works signal
  const interviews = appliedApps.filter((a) => a.outcome === "interview" || a.outcome === "offer").length;
  const offers = appliedApps.filter((a) => a.outcome === "offer").length;
  const outcomeReported = appliedApps.filter((a) => a.outcome).length;
  const stats = {
    // `apps` is already filtered to what this user may see, so every "matched" row
    // in it has come due — this IS the ready-to-send count, not the pipeline size.
    ready: apps.filter((a) => a.status === "matched").length,
    // The rest of the month, as a number only. The user is told the work exists;
    // they are not handed the list.
    queued,
    approved: apps.filter((a) => a.status === "approved").length,
    // everything the agent has looked at and scored, whatever the verdict
    reviewed: apps.length,
    applied: appliedApps.length,
    skipped: apps.filter((a) => a.status === "skipped").length,
    failed: apps.filter((a) => a.status === "failed").length,
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

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      paid: user.paid,
      plan: user.plan,
      status: user.status,
      accessStatus: user.accessStatus,
      role: user.role,
      slackConnected: user.slackConnected,
      slackUserId: user.slackUserId,
      internshalaConnected: user.internshalaConnected,
      gmailConnected,
      gmailScanEnabled: gmailScanEnabled(),
      internshalaLoginEnabled: internshalaLoginEnabled(user),
    },
    profile: user.profile,
    applications: apps,
    reports: user.reports,
    stats,
    quota,
    integrations,
    notifications: {
      unread: notifUnread,
      items: notifItems.map((n) => ({ ...n, read: n.readAt !== null })),
    },
  });
}
