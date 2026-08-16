import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, notFound, serverError } from "@/lib/auth";
import { runAgent, type Report } from "@/lib/agent";
import { reserve, refund } from "@/lib/quota";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

type Ctx = { params: Promise<{ id: string }> };

/**
 * Ask a model for prose advice on this resume.
 *
 * Kept as its own endpoint, separate from the score, for a reason worth being
 * explicit about: the score must never wait on a model and must never change
 * because of one. `readiness.score` runs at upload in under a millisecond;
 * this costs an LLM call and several seconds, so it is opt-in and rate-limited,
 * and its result is stored in a different column. There is exactly one number in
 * this product and a model does not produce it.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;
  const { id } = await params;

  const resume = await prisma.resume.findFirst({
    where: { id, userId: user.id },
    select: { id: true, text: true, adviceJson: true },
  });
  if (!resume) return notFound();
  if (!resume.text?.trim()) {
    return NextResponse.json(
      { error: "We could not read any text from this resume, so there is nothing to review." },
      { status: 400 },
    );
  }

  const quota = await reserve(user.id, "adviceRuns");
  if (!quota.allowed) {
    return NextResponse.json({ error: quota.message, code: "quota" }, { status: 429 });
  }

  const result = await runAgent<{ report: Report }>("report", {
    text: resume.text,
    with_advice: true,
  });

  if (!result.ok) {
    await refund(user.id, "adviceRuns");
    return serverError(result.error);
  }

  const advice = result.report?.advice ?? null;
  if (!advice) {
    await refund(user.id, "adviceRuns");
    return serverError("No review could be produced — the model was unreachable.");
  }

  await prisma.resume
    .update({ where: { id: resume.id }, data: { adviceJson: JSON.stringify(advice) } })
    .catch((e) => console.error("[advice] save failed:", e));

  await audit(user.id, "advice", resume.id);
  return NextResponse.json({ ok: true, advice, remaining: quota.remaining });
}
