import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApprovedUser, notFound, badRequest, serverError } from "@/lib/auth";
import { readStrings } from "@/lib/reportTypes";
import { toJsonValue } from "@/lib/jsonColumn";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** A skills list stays a claim a person can defend, not an SEO dump. */
const MAX_SKILLS = 40;
const MAX_SKILL_LEN = 60;

/**
 * Add skills the CANDIDATE says they have.
 *
 * The tailoring flow surfaces the skills a role asks for that the resume does
 * not yet show. Some of those the person genuinely has and simply never listed
 * — and a skill is a claim they are entitled to make about themselves. This
 * endpoint records exactly those, chosen one by one from the gap, into the
 * resume's own skill list.
 *
 * Why that is honest, and why it lifts the ATS score without fabrication: the
 * rewrite pipeline's truthfulness gate (`_fabricated_skills`) allows only
 * skills already on the candidate's list, so a skill added here becomes one the
 * next rebuild is ALLOWED to print — into the Technical Skills section a
 * recruiter's keyword search actually reads. The model still cannot invent a
 * skill; the person can claim one. That distinction is the whole product.
 */
export async function POST(req: Request, { params }: Ctx) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const resume = await prisma.resume.findFirst({
    where: { id, userId: auth.user.id },
    select: { id: true, skillsJson: true },
  });
  if (!resume) return notFound();

  let body: { add?: unknown };
  try {
    body = await req.json();
  } catch {
    return badRequest("Send a JSON body.");
  }

  const requested = Array.isArray(body.add) ? body.add : [];
  const cleaned = requested
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s) => s.length > 0 && s.length <= MAX_SKILL_LEN);
  if (cleaned.length === 0) {
    return badRequest("Pick at least one skill to add.");
  }

  const existing = readStrings(resume.skillsJson);
  // Case-insensitive dedupe: "React" and "react" are one claim, and the parser
  // reads them the same. Keep the casing the candidate approved.
  const seen = new Set(existing.map((s) => s.toLowerCase()));
  const added: string[] = [];
  for (const skill of cleaned) {
    const key = skill.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(skill);
  }

  if (added.length === 0) {
    // Everything requested was already on the list — a no-op, reported plainly
    // rather than as an error, so the UI can just re-run the rebuild.
    return NextResponse.json({ ok: true, added: [], skills: existing });
  }

  const merged = [...existing, ...added].slice(0, MAX_SKILLS);

  try {
    await prisma.resume.update({
      where: { id: resume.id },
      data: { skillsJson: toJsonValue(merged) },
    });
  } catch (e) {
    return serverError("Could not save those skills.", `skills:${id}: ${String(e)}`);
  }

  await audit(auth.user.id, "skills_claimed", resume.id, added.join(", ").slice(0, 200));
  return NextResponse.json({ ok: true, added, skills: merged });
}
