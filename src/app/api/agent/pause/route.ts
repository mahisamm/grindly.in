import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";

/** Toggle the agent between active and paused. Paused users are skipped by the
 *  scheduler sweep (worker.py only runs paid + status='active'). */
export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  const user = await prisma.user.findUnique({ where: { id: uid } });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!user.paid) return NextResponse.json({ error: "payment required" }, { status: 402 });

  const next = action === "pause" ? "paused" : "active";
  await prisma.user.update({ where: { id: uid }, data: { status: next } });
  return NextResponse.json({ ok: true, status: next });
}
