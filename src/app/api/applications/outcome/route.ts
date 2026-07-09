import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { audit } from "@/lib/audit";
import type { Outcome } from "@prisma/client";

// The single most important beta signal: did an application lead anywhere?
// User taps an outcome on each applied row → we compute interview rate from it.
const OUTCOMES = new Set<string>(["interview", "offer", "rejected", "no_response"]);

export async function PATCH(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { id?: string; outcome?: string | null };
  if (!body.id) return NextResponse.json({ error: "missing id" }, { status: 400 });

  // null clears the outcome; otherwise it must be a known value
  const outcome = body.outcome ?? null;
  if (outcome !== null && !OUTCOMES.has(outcome)) {
    return NextResponse.json({ error: "invalid outcome" }, { status: 400 });
  }

  const app = await prisma.application.findFirst({ where: { id: body.id, userId: uid } });
  if (!app) return NextResponse.json({ error: "not found" }, { status: 404 });

  await prisma.application.update({
    where: { id: body.id },
    data: { outcome: outcome as Outcome | null, outcomeAt: outcome ? new Date() : null },
  });
  await audit("outcome_set", { userId: uid, target: app.url ?? app.jobTitle, detail: outcome ?? "cleared" });

  return NextResponse.json({ ok: true });
}
