import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

// Single-user drill-down: account, profile snapshot, integrations, recent apps,
// recent reports, recent audit entries.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("error" in g) return g.error;
  const { id } = await ctx.params;

  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      profile: true,
      integrations: true,
      applications: { orderBy: { createdAt: "desc" }, take: 50 },
      reports: { orderBy: { date: "desc" }, take: 14 },
    },
  });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const auditLogs = await prisma.auditLog.findMany({
    where: { userId: id },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { id: true, action: true, target: true, detail: true, createdAt: true },
  });

  const apps = user.applications;
  const stats = {
    total: apps.length,
    applied: apps.filter((a) => a.status === "applied").length,
    failed: apps.filter((a) => a.status === "failed").length,
    skipped: apps.filter((a) => a.status === "skipped").length,
    interviews: apps.filter((a) => a.outcome === "interview" || a.outcome === "offer").length,
    offers: apps.filter((a) => a.outcome === "offer").length,
  };

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      plan: user.plan,
      paid: user.paid,
      status: user.status,
      phone: user.phone ? `***${user.phone.slice(-4)}` : null,
      slackConnected: user.slackConnected,
      createdAt: user.createdAt,
    },
    profile: user.profile && {
      experienceLevel: user.profile.experienceLevel,
      skills: user.profile.skills,
      preferredDomains: user.profile.preferredDomains,
      preferredLocations: user.profile.preferredLocations,
      workMode: user.profile.workMode,
      minMatchScore: user.profile.minMatchScore,
      stipendMin: user.profile.stipendMin,
      autoApply: user.profile.autoApply,
      resumeScore: user.profile.resumeScore,
      updatedAt: user.profile.updatedAt,
    },
    integrations: user.integrations.map((i) => ({
      platform: i.platform,
      status: i.status,
      connectedAt: i.connectedAt,
      updatedAt: i.updatedAt,
    })),
    stats,
    applications: apps.map((a) => ({
      id: a.id,
      jobTitle: a.jobTitle,
      company: a.company,
      matchScore: a.matchScore,
      status: a.status,
      outcome: a.outcome,
      failureReason: a.failureReason,
      createdAt: a.createdAt,
    })),
    reports: user.reports,
    auditLogs,
  });
}
