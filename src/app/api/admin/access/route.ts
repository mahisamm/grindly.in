import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin, adminAudit } from "@/lib/admin";
import { notifyUser } from "@/lib/notify";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/access — the two things the owner acts on:
 *   pending[]   — accounts awaiting approval (real "Request access" taps first,
 *                 then passive signups), so the queue leads with intent.
 *   allowlist[] — emails pre-approved before they've signed up.
 */
export async function GET() {
  const g = await requireAdmin();
  if ("error" in g) return g.error;

  const [pending, allowlist, recentlyGranted] = await Promise.all([
    prisma.user.findMany({
      where: { accessStatus: "pending" },
      select: { id: true, email: true, name: true, createdAt: true, accessRequestedAt: true },
      // Explicit requesters first (most-recent request), then newest signups.
      orderBy: [{ accessRequestedAt: "desc" }, { createdAt: "desc" }],
      take: 200,
    }),
    prisma.accessAllowlist.findMany({ orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.user.findMany({
      where: { accessStatus: "approved", accessGrantedAt: { not: null } },
      select: { id: true, email: true, name: true, accessGrantedAt: true },
      orderBy: { accessGrantedAt: "desc" },
      take: 25,
    }),
  ]);

  return NextResponse.json({
    pending: pending.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      createdAt: u.createdAt,
      requestedAt: u.accessRequestedAt,
      requested: !!u.accessRequestedAt,
    })),
    allowlist: allowlist.map((a) => ({ email: a.email, note: a.note, createdAt: a.createdAt })),
    recentlyGranted,
  });
}

const bodySchema = z.union([
  z.object({ action: z.enum(["approve", "deny", "revoke"]), userId: z.string().min(1) }),
  z.object({ action: z.literal("allow"), email: z.string().email(), note: z.string().max(200).optional() }),
  z.object({ action: z.literal("unallow"), email: z.string().email() }),
]);

export async function POST(req: Request) {
  const g = await requireAdmin();
  if ("error" in g) return g.error;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const data = parsed.data;

  if (data.action === "approve") {
    const user = await prisma.user.findUnique({ where: { id: data.userId }, select: { email: true } });
    if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });
    await prisma.user.update({
      where: { id: data.userId },
      data: { accessStatus: "approved", accessGrantedAt: new Date() },
    });
    await adminAudit(g.admin, "access_approve", user.email);
    // Tell them they're in — email/slack if configured, else recorded in-app.
    void notifyUser(data.userId, {
      tier: "urgent",
      title: "You're in — Grindly access approved",
      body:
        "Your Grindly access is live. Sign in and finish setup (upload your resume, " +
        "connect a job platform) and your agent starts finding matches.",
    });
    return NextResponse.json({ ok: true });
  }

  if (data.action === "deny" || data.action === "revoke") {
    const status = data.action === "deny" ? "denied" : "pending";
    const user = await prisma.user.findUnique({ where: { id: data.userId }, select: { email: true } });
    if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });
    await prisma.user.update({
      where: { id: data.userId },
      data: { accessStatus: status, accessGrantedAt: null },
    });
    await adminAudit(g.admin, `access_${data.action}`, user.email);
    return NextResponse.json({ ok: true });
  }

  if (data.action === "allow") {
    const email = data.email.trim().toLowerCase();
    await prisma.accessAllowlist.upsert({
      where: { email },
      create: { email, note: data.note ?? null },
      update: { note: data.note ?? null },
    });
    // If the person already signed up, flip them approved right now too.
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, accessStatus: true } });
    if (existing && existing.accessStatus !== "approved") {
      await prisma.user.update({
        where: { id: existing.id },
        data: { accessStatus: "approved", accessGrantedAt: new Date() },
      });
      void notifyUser(existing.id, {
        tier: "urgent",
        title: "You're in — Grindly access approved",
        body: "Your Grindly access is live. Sign in to finish setup and start your agent.",
      });
    }
    await adminAudit(g.admin, "access_allow", email);
    return NextResponse.json({ ok: true, grantedExisting: !!existing });
  }

  if (data.action === "unallow") {
    const email = data.email.trim().toLowerCase();
    await prisma.accessAllowlist.deleteMany({ where: { email } });
    await adminAudit(g.admin, "access_unallow", email);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "invalid" }, { status: 400 });
}
