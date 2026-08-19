import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApprovedUser, notFound, badRequest } from "@/lib/auth";
import { runAgent } from "@/lib/agent";
import { readTargetSpec } from "@/lib/reportTypes";
import { reserve, refund } from "@/lib/quota";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

type Ctx = { params: Promise<{ id: string }> };

/**
 * Write a cover letter for this resume, optionally aimed at a target.
 *
 * Nothing is stored. A letter is written for one application and is edited
 * before it is sent — keeping every draft would make a list of near-identical
 * paragraphs nobody wants to scroll, and the value here is the writing, not the
 * archive.
 *
 * The interesting behaviour is the refusal. When every draft makes a claim the
 * resume does not support, this returns 422 with the specific problems rather
 * than the best of a bad set. See cover_letter.py — a cover letter is three
 * paragraphs of prose and a repaired one is a different letter nobody has read,
 * so the honest move is to hand back the reason and let the user add the
 * missing fact to their resume if it is true.
 */
export async function POST(req: Request, { params }: Ctx) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;
  const { id } = await params;

  const resume = await prisma.resume.findFirst({
    where: { id, userId: user.id },
    select: { id: true, text: true },
  });
  if (!resume) return notFound();

  if (!resume.text || resume.text.trim().length < 400) {
    return badRequest(
      "There is not enough readable text in this resume to write a letter from.",
    );
  }

  let body: { targetId?: string; company?: string; role?: string } = {};
  try {
    body = await req.json();
  } catch {
    // No body is valid — an untargeted letter about the candidate's own work.
  }

  let company = String(body.company ?? "").slice(0, 120);
  const role = String(body.role ?? "").slice(0, 120);
  let requirements: string[] = [];

  if (body.targetId) {
    // Read off the target rather than trusted from the request: what a letter
    // is aimed at decides what it emphasises, and the client should not be able
    // to hand us requirements nobody was shown.
    const target = await prisma.target.findFirst({
      where: { id: body.targetId, userId: user.id, resumeId: resume.id },
      select: { name: true, specJson: true },
    });
    if (!target) return notFound();
    company = target.name;
    const spec = readTargetSpec(target.specJson);
    requirements = spec?.skills ?? [];
  }

  // Metered against the advice allowance: several model calls on demand, the
  // same shape of cost as a written review.
  const quota = await reserve(user.id, "adviceRuns");
  if (!quota.allowed) {
    return NextResponse.json({ error: quota.message, code: "quota" }, { status: 429 });
  }

  const result = await runAgent<{
    refused: string | null;
    problems?: string[];
    letter: string;
    used: string[];
  }>("cover", { text: resume.text, company, role, requirements });

  if (!result.ok) {
    await refund(user.id, "adviceRuns");
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }

  if (result.refused) {
    // Not a failure on either side: every draft made a claim the resume does
    // not support, and the honest answer is the reason rather than the best of
    // a bad set. The allowance goes back, because no document was produced.
    await refund(user.id, "adviceRuns");
    return NextResponse.json(
      { ok: false, error: result.refused, problems: result.problems ?? [] },
      { status: 422 },
    );
  }

  await audit(user.id, "cover_letter", resume.id, company || "untargeted");
  return NextResponse.json({
    ok: true,
    letter: result.letter,
    used: result.used ?? [],
    company,
    remaining: quota.remaining,
  });
}
