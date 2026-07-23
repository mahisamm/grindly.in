import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { hasAppAccess } from "@/lib/access";

/** Toggle the agent between active and paused. Paused users are skipped by the
 *  scheduler sweep (worker.py only runs status='active' users). */
export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { action } = (await req.json().catch(() => ({}))) as { action?: string };

  // Only two actions exist, and neither may be reached by omitting the field.
  // The old `action === "pause" ? "paused" : "active"` treated a missing or
  // malformed body as "activate me", which is the wrong default for the one
  // field that decides whether the agent runs at all.
  if (action !== "pause" && action !== "resume") {
    return NextResponse.json(
      { error: "action must be 'pause' or 'resume'" },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({ where: { id: uid } });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Gated beta: pausing is always allowed (a user may stop their own agent), but
  // RESUMING is the act that makes the agent do work, so it gates exactly like
  // /api/agent/run. Without this an unapproved account could set itself active
  // and be picked up by the daily sweep — the access gate bypassed by one POST.
  if (action === "resume" && !hasAppAccess(user)) {
    return NextResponse.json(
      { error: "Your access is pending approval.", code: "access_pending" },
      { status: 403 },
    );
  }

  const next = action === "pause" ? "paused" : "active";
  await prisma.user.update({ where: { id: uid }, data: { status: next } });
  return NextResponse.json({ ok: true, status: next });
}
