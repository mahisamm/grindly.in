import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";

const PLATFORMS = ["linkedin", "internshala", "naukri", "unstop", "indeed"] as const;

export async function GET() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: uid },
    include: {
      profile: true,
      applications: { orderBy: { createdAt: "desc" }, take: 100 },
      reports: { orderBy: { date: "desc" }, take: 14 },
    },
  });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Load integrations (graceful if table not yet migrated)
  let integrationRows: { platform: string; status: string; connectedAt: Date | null }[] = [];
  try {
    integrationRows = await prisma.userIntegration.findMany({ where: { userId: uid } });
  } catch {
    // Ignore — prisma db push not yet run
  }
  const byPlatform = Object.fromEntries(integrationRows.map((r) => [r.platform, r]));
  const integrations = PLATFORMS.map((p) => ({
    platform: p,
    status: byPlatform[p]?.status ?? (p === "internshala" && user.internshalaConnected ? "connected" : "disconnected"),
    connectedAt: byPlatform[p]?.connectedAt ?? null,
  }));

  const apps = user.applications;
  const appliedApps = apps.filter((a) => a.status === "applied");
  // beta funnel: interview rate is the headline product-works signal
  const interviews = appliedApps.filter((a) => a.outcome === "interview" || a.outcome === "offer").length;
  const offers = appliedApps.filter((a) => a.outcome === "offer").length;
  const outcomeReported = appliedApps.filter((a) => a.outcome).length;
  const stats = {
    matched: apps.length,
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

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      paid: user.paid,
      plan: user.plan,
      status: user.status,
      slackConnected: user.slackConnected,
      internshalaConnected: user.internshalaConnected,
    },
    profile: user.profile,
    applications: apps,
    reports: user.reports,
    stats,
    integrations,
  });
}
