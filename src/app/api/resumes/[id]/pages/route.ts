import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, badRequest, notFound } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The user's answer to "want a one-page version?"
 *
 *   { targetPages: 1 }  — yes: every rebuild of this resume carries a
 *                         one-page budget from now on.
 *   { targetPages: 0 }  — keep my length: never ask again for this resume.
 *   { targetPages: null } — clear the choice (the card may come back).
 *
 * A preference, never a gate: nothing else about rebuilding changes.
 */
export async function POST(req: Request, { params }: Ctx) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  let body: { targetPages?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest("Send a JSON body.");
  }
  const v = body.targetPages;
  const targetPages = v === null ? null : v === 1 || v === 0 ? v : undefined;
  if (targetPages === undefined) return badRequest("targetPages must be 1, 0 or null.");

  const r = await prisma.resume.updateMany({
    where: { id, userId: auth.user.id },
    data: { targetPages },
  });
  if (r.count === 0) return notFound();
  await audit(auth.user.id, "page_budget", id, String(targetPages));
  return NextResponse.json({ ok: true, targetPages });
}
