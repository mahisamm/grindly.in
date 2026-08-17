import { NextResponse } from "next/server";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { requireUser, notFound, serverError, badRequest } from "@/lib/auth";
import { runAgent, VARIANT_DIR, type Report, type Fidelity } from "@/lib/agent";
import { reserve, refund } from "@/lib/quota";
import { limitsFor } from "@/lib/plans";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A batch is several model calls plus up to four Chromium renders. Next's
// default serverless budget would cut it off halfway and leave the quota spent.
export const maxDuration = 600;

type Ctx = { params: Promise<{ id: string }> };

type AgentVariant = {
  label: string;
  score: number;
  grade: string;
  baseline_score: number;
  beats_baseline: boolean;
  changes: string[];
  report: Report;
  fidelity: Fidelity;
  pages: number | null;
  meets_floor: boolean;
  floor: number;
  floor_gap: string;
  file: string;
  bytes: number;
};

/**
 * Build up to three measured rewrites of this resume.
 *
 * Optionally aimed at a target: `{targetId}` for an existing one, or
 * `{company}` / `{jd}` to create one first. Untargeted is the default and is
 * the honest "just make this better" run.
 */
export async function POST(req: Request, { params }: Ctx) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;
  const { id } = await params;

  const resume = await prisma.resume.findFirst({
    where: { id, userId: user.id },
    select: {
      id: true, text: true, chars: true,
      skillsJson: true, contactJson: true, linksJson: true,
    },
  });
  if (!resume) return notFound();

  if (!resume.text || resume.text.trim().length < 200) {
    return badRequest(
      "There is not enough readable text in this resume to rebuild it. " +
        "Fix the machine-readability problems first, then try again.",
    );
  }

  let body: { targetId?: string; company?: string; companyName?: string; jd?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // No body is valid — that is the untargeted run.
  }

  // Quota BEFORE the target is created. The other order committed a Target row
  // and then 429'd — so a free user (1 target per resume) who had already used
  // their daily runs permanently burned their only target slot on a request
  // that produced nothing, and every attempt after it hit the 402 plan limit.
  const quota = await reserve(user.id, "variantRuns");
  if (!quota.allowed) {
    return NextResponse.json({ error: quota.message, code: "quota" }, { status: 429 });
  }

  const target = await resolveTarget(user.id, resume.id, body);
  if ("error" in target) {
    await refund(user.id, "variantRuns");
    return target.error;
  }

  // Each run writes into its OWN directory.
  //
  // Every run used to write `variant-1.pdf` … `variant-3.pdf` into one folder
  // per resume, while the previous run's rows stayed in the database pointing
  // at those same names. Pressing "Run again" therefore left the old card —
  // labelled with the old strategy, old score and old fidelity report — opening
  // the NEW run's document. A user downloading a resume that is not the one
  // they were shown is the worst failure this product can have.
  const runId = crypto.randomUUID();
  const outDir = path.join(VARIANT_DIR, resume.id, runId);
  const skills = parseArray(resume.skillsJson);
  const contact = (safeParse(resume.contactJson) ?? {}) as Record<string, unknown>;

  const result = await runAgent<{
    variants: AgentVariant[];
    baseline: number;
    reasons: string[];
    floor: number;
    meets_floor: boolean;
    floor_gap: string;
    aborted: string | null;
  }>("variants", {
    text: resume.text,
    skills,
    out_dir: outDir,
    contact_fallback: typeof contact.contact_line === "string" ? contact.contact_line : "",
    target_keywords: target.keywords,
    emphasis: target.emphasis,
    target_name: target.name,
    // Link annotations off the uploaded PDF. A LinkedIn address hidden behind
    // the word "LinkedIn" is invisible to every text extractor, so the rebuild
    // prints it out — see _merge_profile_links in resume_optimize.py.
    links: parseArray(resume.linksJson),
  });

  if (!result.ok) {
    await refund(user.id, "variantRuns");
    return serverError(result.error);
  }

  if (result.aborted) {
    // Our side failed, or the input could not be worked with. Either way the
    // user did not get anything, so they are not charged for it.
    await refund(user.id, "variantRuns");
    return NextResponse.json(
      { ok: false, aborted: result.aborted, reasons: result.reasons, error: abortMessage(result.aborted) },
      { status: 422 },
    );
  }

  if (!result.variants.length) {
    // This is a real, valid outcome — the rewrites ran and none beat the master.
    // It is NOT a failure, and it is not charged for either: the user pressed a
    // button and received no document.
    await refund(user.id, "variantRuns");
    return NextResponse.json({
      ok: true,
      variants: [],
      baseline: result.baseline,
      reasons: result.reasons,
      message:
        "None of the rewrites scored higher than your current resume, so there is " +
        "nothing here worth swapping to. That is a good sign.",
    });
  }

  // Replace, don't accumulate. A second run against the same target supersedes
  // the first: the user pressed the button again because they wanted a new
  // answer, and showing six cards from two runs side by side invites them to
  // download the older one. Files go with the rows.
  const superseded = await prisma.variant.findMany({
    where: { resumeId: resume.id, targetId: target.id },
    select: { id: true, file: true },
  });
  if (superseded.length) {
    await prisma.variant.deleteMany({
      where: { id: { in: superseded.map((v) => v.id) } },
    }).catch((e) => console.error("[variants] supersede failed:", e));
    for (const old of superseded) {
      const dir = path.dirname(old.file);
      if (dir && dir !== ".") {
        await fsp.rm(path.join(VARIANT_DIR, resume.id, dir), {
          recursive: true, force: true,
        }).catch(() => {});
      }
    }
  }

  let created;
  try {
    created = await prisma.$transaction(
      result.variants.map((v) =>
        prisma.variant.create({
          data: {
            resumeId: resume.id,
            targetId: target.id,
            label: String(v.label).slice(0, 60),
            score: v.score,
            grade: v.grade,
            baselineScore: v.baseline_score,
            beatsBaseline: Boolean(v.beats_baseline),
            pages: v.pages ?? null,
            changesJson: JSON.stringify(v.changes ?? []),
            reportJson: JSON.stringify(v.report ?? null),
            fidelityJson: JSON.stringify(v.fidelity ?? null),
            // Run-scoped, so this row can only ever resolve to its own document.
            file: `${runId}/${v.file}`,
            bytes: v.bytes ?? 0,
          },
        }),
      ),
    );
  } catch (e) {
    console.error("[variants] persist failed:", e);
    return serverError("We built the rewrites but could not save them.");
  }

  await audit(user.id, "variants", resume.id, target.name || "untargeted");
  return NextResponse.json({
    ok: true,
    baseline: result.baseline,
    reasons: result.reasons,
    targetId: target.id,
    floor: result.floor,
    meetsFloor: result.meets_floor,
    floorGap: result.floor_gap,
    variants: created.map((v, i) => ({
      ...v,
      changes: result.variants[i]?.changes ?? [],
      report: result.variants[i]?.report ?? null,
      fidelity: result.variants[i]?.fidelity ?? null,
      meetsFloor: result.variants[i]?.meets_floor ?? true,
      floorGap: result.variants[i]?.floor_gap ?? "",
    })),
  });
}

// ---------------------------------------------------------------------------

type ResolvedTarget = {
  id: string | null;
  name: string;
  keywords: string[];
  emphasis: string[];
};

async function resolveTarget(
  userId: string,
  resumeId: string,
  body: { targetId?: string; company?: string; companyName?: string; jd?: string },
): Promise<ResolvedTarget | { error: NextResponse }> {
  const none: ResolvedTarget = { id: null, name: "", keywords: [], emphasis: [] };

  if (body.targetId) {
    const t = await prisma.target.findFirst({
      where: { id: body.targetId, userId, resumeId },
    });
    if (!t) return { error: notFound() };
    return targetToResolved(t);
  }

  if (!body.company && !body.companyName && !body.jd) return none;

  // Validate the INPUT before checking the plan limit. The other order tells a
  // user with a two-word job description to buy a Season Pass — the request was
  // never going to work at any price, and "upgrade" as the response to a typo
  // is both confusing and faintly dishonest.
  const jdText = String(body.jd ?? "").slice(0, 20000);
  if (body.jd && jdText.trim().length < 60) {
    return { error: badRequest("Paste the full job description — that is too short to read anything from.") };
  }

  const limit = limitsFor(
    (await prisma.user.findUnique({
      where: { id: userId },
      // `role` is part of the plan calculation — omitting it here would cap an
      // admin at the free tier on the one path that actually enforces it,
      // while every page around it showed no limit.
      select: { plan: true, planExpiresAt: true, role: true },
    })) ?? {},
  ).targetsPerResume;
  const existing = await prisma.target.count({ where: { resumeId } });
  if (existing >= limit) {
    return {
      error: NextResponse.json(
        {
          error: `Your plan allows ${limit} target${limit === 1 ? "" : "s"} per resume. Get a Season Pass for more.`,
          code: "plan_limit",
        },
        { status: 402 },
      ),
    };
  }

  if (body.company) {
    const pack = await runAgent<{ pack: { name: string; keywords: string[]; emphasis: string[] } }>(
      "companies",
      { slug: body.company },
    );
    if (!pack.ok) return { error: badRequest("We do not have a pack for that company yet.") };
    const created = await prisma.target.create({
      data: {
        userId, resumeId, kind: "company",
        slug: body.company, name: pack.pack.name,
        specJson: JSON.stringify({ skills: pack.pack.keywords }),
      },
    });
    return {
      id: created.id,
      name: pack.pack.name,
      keywords: pack.pack.keywords ?? [],
      emphasis: pack.pack.emphasis ?? [],
    };
  }

  // A company typed by hand, with no curated pack behind it. The lookup runs
  // again here rather than trusting whatever the browser posted: the client
  // already called /api/companies/research to show the user what tailoring
  // would mean, but emphasis lines from that response are instructions we feed
  // to a rewrite, and instructions must not be round-tripped through a page
  // anyone can edit.
  if (body.companyName) {
    const found = await runAgent<{
      tailoring: "curated" | "generated" | "not_required";
      name: string; slug?: string; keywords: string[]; emphasis: string[];
      note?: string;
    }>("research", { name: body.companyName });
    if (!found.ok) return { error: serverError("We could not look that company up.") };

    if (found.tailoring === "not_required") {
      // Not an error on the user's part, so it does not read as one. They are
      // told what we know and pointed at the two things that do work.
      return {
        error: NextResponse.json(
          { error: found.note, code: "tailoring_not_required", company: found.name },
          { status: 422 },
        ),
      };
    }

    const created = await prisma.target.create({
      data: {
        userId, resumeId, kind: "company",
        // A curated match keeps its slug so the pack stays live; a generated
        // one has none, and its emphasis is stored because there is no pack to
        // re-read it from later.
        slug: found.slug ?? null,
        name: found.name.slice(0, 120),
        specJson: JSON.stringify({
          skills: found.keywords ?? [],
          emphasis: found.slug ? [] : (found.emphasis ?? []),
          tailoring: found.tailoring,
        }),
      },
    });
    return {
      id: created.id,
      name: found.name,
      keywords: found.keywords ?? [],
      emphasis: found.emphasis ?? [],
    };
  }

  const jd = jdText;
  const parsed = await runAgent<{ spec: { title: string; company: string; skills: string[] } }>("jd", { text: jd });
  if (!parsed.ok) return { error: serverError("Could not read that job description.") };

  const name = parsed.spec.company || parsed.spec.title || "Pasted role";
  const created = await prisma.target.create({
    data: {
      userId, resumeId, kind: "jd", name: name.slice(0, 120),
      jdText: jd, specJson: JSON.stringify(parsed.spec),
    },
  });
  return { id: created.id, name, keywords: parsed.spec.skills ?? [], emphasis: [] };
}

async function targetToResolved(t: {
  id: string; name: string; kind: string; slug: string | null; specJson: string | null;
}): Promise<ResolvedTarget> {
  const spec = (safeParse(t.specJson) ?? {}) as { skills?: string[]; emphasis?: string[] };
  // A curated pack is re-read from `companies.py` every time, so editing a pack
  // and deploying updates every target pointing at it. A generated one has no
  // pack to re-read, so its emphasis was stored on the target — and is used
  // verbatim rather than re-generated, because re-running the model on every
  // rebuild would silently change what a saved target means.
  let emphasis: string[] = Array.isArray(spec.emphasis) ? spec.emphasis : [];
  if (t.kind === "company" && t.slug) {
    const pack = await runAgent<{ pack: { emphasis: string[] } }>("companies", { slug: t.slug });
    if (pack.ok) emphasis = pack.pack.emphasis ?? [];
  }
  return { id: t.id, name: t.name, keywords: spec.skills ?? [], emphasis };
}

function abortMessage(code: string): string {
  switch (code) {
    case "source_too_short":
      return "There is too little text in this resume to rebuild it safely.";
    case "no_renderer":
      return "The PDF renderer is not available on this server. Run `python -m playwright install chromium`.";
    case "extraction_failed":
      return "We could not read a clear structure out of this resume. Try uploading the original PDF rather than a scan.";
    default:
      return "The rewrite could not be completed.";
  }
}

function parseArray(value: string | null): string[] {
  const parsed = safeParse(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function safeParse(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
