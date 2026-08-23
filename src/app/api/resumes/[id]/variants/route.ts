import { NextResponse, after } from "next/server";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { requireApprovedUser, notFound, serverError, badRequest } from "@/lib/auth";
import { runAgent, VARIANT_DIR, type Report, type Fidelity } from "@/lib/agent";
import { readContact, readStrings, readTargetSpec } from "@/lib/reportTypes";
import { toJsonColumn } from "@/lib/jsonColumn";
import { reserve, refund } from "@/lib/quota";
import { TARGET_REGEN_LIMIT, effectivePlan, formatLimit, limitsFor } from "@/lib/plans";
import { audit } from "@/lib/audit";
import { report } from "@/lib/errors";
import { activeRun, holdRun, releaseRun } from "@/lib/variantRuns";
import { readAdminSettings } from "@/lib/adminSettings";

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
  /** The fields this rebuild was printed from — what the editor and a
      promotion both need. `unknown` because it crosses a subprocess boundary
      and is written to a Json column unvalidated either way. */
  struct: unknown;
  /** The text read back off the finished PDF — what `score` was computed from. */
  text: string;
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
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;
  const { id } = await params;

  // No exemption for admin here, deliberately — see adminSettings.ts. This is
  // for a deploy or a migration, and "except the operator testing the box
  // during one" is exactly the run that would collide with it.
  if (readAdminSettings().rebuildsPaused) {
    return NextResponse.json(
      { error: "Rebuilds are paused for maintenance. Try again shortly.", code: "rebuilds_paused" },
      { status: 503 },
    );
  }

  const resume = await prisma.resume.findFirst({
    where: { id, userId: user.id },
    select: {
      id: true, text: true, chars: true,
      skillsJson: true, contactJson: true, linksJson: true, linkStyle: true,
    },
  });
  if (!resume) return notFound();

  if (!resume.text || resume.text.trim().length < 200) {
    return badRequest(
      "There is not enough readable text in this resume to rebuild it. " +
        "Fix the machine-readability problems first, then try again.",
    );
  }

  let body: {
    targetId?: string; company?: string; companyName?: string;
    jd?: string; notes?: string;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // No body is valid — that is the untargeted run.
  }

  // One batch at a time per resume.
  //
  // Two concurrent runs against the same resume both spend quota, both render
  // to Chromium on a one-vCPU box, and then race to supersede each other's
  // rows — so the user is charged twice and shown whichever finished last. It
  // is also what a double-click produces, which is the common case rather than
  // the adversarial one.
  const running = await activeRun(resume.id);
  if (running) {
    return NextResponse.json(
      {
        error: "This resume is already being rebuilt. Wait for that to finish.",
        code: "already_running",
        runId: running.id,
      },
      { status: 409 },
    );
  }

  // Who is running, and against what, decides which wall applies:
  //
  //   pass / admin / legacy pack — the daily meter, as always.
  //   free, untargeted           — the LIFETIME meter (3, ever). The taste.
  //   free, targeted             — no meter at all. The TARGET is the wall:
  //     locked → 402 with the unlock offer; unlocked → capped at
  //     TARGET_REGEN_LIMIT runs for that target, counted below.
  //
  // The target is therefore resolved BEFORE any quota is spent — under this
  // model creating the row (and its free gap report) costs nothing, so the
  // old "quota first, or a refused run burns the target slot" ordering is no
  // longer load-bearing.
  const plan = effectivePlan(user);
  const target = await resolveTarget(user.id, resume.id, body);
  if ("error" in target) return target.error;

  let metered = false;
  if (plan === "free" && target.id) {
    const targetRow = await prisma.target.findUnique({
      where: { id: target.id },
      select: { unlockedAt: true },
    });
    if (!targetRow?.unlockedAt) {
      return NextResponse.json(
        {
          error: `Tailoring for ${target.name || "this company"} is a paid unlock — ₹99, once, for this company forever. A Season Pass covers every company.`,
          code: "target_locked",
          targetId: target.id,
          targetName: target.name,
        },
        { status: 402 },
      );
    }
    // Count only runs that produced (or are producing) something — a failed
    // or cancelled batch was refunded everywhere else in this file, and a
    // regeneration cap that counts our own failures is charging for outages.
    const spent = await prisma.variantRun.count({
      where: { targetId: target.id, status: { in: ["running", "done", "empty"] } },
    });
    if (spent >= TARGET_REGEN_LIMIT) {
      return NextResponse.json(
        {
          error: `This company's unlock includes ${TARGET_REGEN_LIMIT} tailored runs and you have used them. A Season Pass removes the cap for every company.`,
          code: "quota",
        },
        { status: 429 },
      );
    }
  } else {
    const quota = await reserve(user.id, "variantRuns");
    if (!quota.allowed) {
      return NextResponse.json({ error: quota.message, code: "quota" }, { status: 429 });
    }
    metered = true;
  }

  // Each run writes into its OWN directory.
  //
  // Every run used to write `variant-1.pdf` … `variant-3.pdf` into one folder
  // per resume, while the previous run's rows stayed in the database pointing
  // at those same names. Pressing "Run again" therefore left the old card —
  // labelled with the old strategy, old score and old fidelity report — opening
  // the NEW run's document. A user downloading a resume that is not the one
  // they were shown is the worst failure this product can have.
  const runDir = crypto.randomUUID();

  const run = await prisma.variantRun.create({
    data: {
      userId: user.id,
      resumeId: resume.id,
      targetId: target.id,
      targetName: target.name,
      stage: "Starting",
    },
    select: { id: true, startedAt: true },
  });

  // The check above has a window: two requests can both read "nothing running"
  // before either has inserted a row, and then both spend a quota unit, both
  // render on a one-vCPU box, and race to supersede each other's variants — so
  // the user is charged twice and shown whichever finished last. A double click
  // is exactly how that happens.
  //
  // Closed by checking AFTER the insert instead of only before it: whoever
  // started first wins, and anyone who finds an older running row stands down.
  // The comparison is on `startedAt` with the id breaking ties, so both sides
  // of a genuine tie reach the same verdict and exactly one survives.
  const rival = await prisma.variantRun.findFirst({
    where: { resumeId: resume.id, status: "running", id: { not: run.id } },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    select: { id: true, startedAt: true },
  });
  const lost =
    rival &&
    (rival.startedAt < run.startedAt ||
      (rival.startedAt.getTime() === run.startedAt.getTime() && rival.id < run.id));
  if (lost) {
    await prisma.variantRun
      .update({
        where: { id: run.id },
        data: { status: "cancelled", stage: "Superseded", finishedAt: new Date() },
      })
      .catch(() => null);
    if (metered) await refund(user.id, "variantRuns");
    return NextResponse.json(
      {
        error: "This resume is already being rebuilt. Wait for that to finish.",
        code: "already_running",
        runId: rival.id,
      },
      { status: 409 },
    );
  }

  // The work runs AFTER this response.
  //
  // `after` keeps it inside the route's maxDuration budget while letting the
  // browser go, and that is the whole point. A batch is minutes long, and it
  // used to run inside this request: the work existed only as an open HTTP
  // connection, so closing the tab or letting a phone sleep meant the server
  // finished the job, wrote the rows and spent the quota while the person who
  // asked for it saw a spinner vanish and had no way to find out it had worked.
  after(async () => {
    await executeRun({
      runId: run.id,
      runDir,
      userId: user.id,
      resume,
      target,
      metered,
    });
  });

  return NextResponse.json(
    {
      ok: true,
      runId: run.id,
      targetId: target.id,
      message: "Rebuilding. This takes a minute or two — you can leave this page.",
    },
    { status: 202 },
  );
}

// ---------------------------------------------------------------------------

/**
 * The batch itself: build, measure, persist, and record how it went.
 *
 * Nothing here throws to a caller, because there is no caller left — the
 * response went out before this started. Every exit updates the run row
 * instead, since a row stuck on `running` is a spinner that never stops for
 * whoever is watching it. The one case this cannot cover is the process dying
 * mid-run, which is what reapStaleRuns exists for.
 */
async function executeRun({
  runId,
  runDir,
  userId,
  resume,
  target,
  metered,
}: {
  runId: string;
  runDir: string;
  userId: string;
  /** Whether a daily/lifetime quota unit was reserved for this run — false
      for a free user's runs against an unlocked target, whose only wall is
      the per-target count (which failed runs never enter, see the status
      filter where it is counted). */
  metered: boolean;
  resume: {
    id: string;
    text: string;
    skillsJson: unknown;
    contactJson: unknown;
    linksJson: unknown;
    linkStyle: string;
  };
  target: ResolvedTarget;
}): Promise<void> {
  const outDir = path.join(VARIANT_DIR, resume.id, runDir);
  const skills = readStrings(resume.skillsJson);
  const contact = readContact(resume.contactJson);

  // Not awaited by the pipeline: a progress label is worth nothing if writing
  // it can slow down or fail the work it describes.
  const setStage = (stage: string) => {
    void prisma.variantRun.update({ where: { id: runId }, data: { stage } }).catch(() => null);
  };

  const finish = async (data: {
    status: "done" | "empty" | "failed" | "cancelled";
    stage: string;
    error?: string | null;
    variantsMade?: number;
  }) => {
    releaseRun(runId);
    await prisma.variantRun
      .update({
        where: { id: runId },
        data: {
          status: data.status,
          stage: data.stage,
          error: data.error ?? null,
          variantsMade: data.variantsMade ?? 0,
          finishedAt: new Date(),
        },
      })
      .catch((e) => console.error("[variants] could not close run:", (e as Error).message));
  };

  let result;
  try {
    result = await runAgent<{
      variants: AgentVariant[];
      baseline: number;
      reasons: string[];
      floor: number;
      meets_floor: boolean;
      floor_gap: string;
      aborted: string | null;
    }>(
      "variants",
      {
        text: resume.text,
        skills,
        out_dir: outDir,
        contact_fallback: contact.contact_line ?? "",
        target_keywords: target.keywords,
        emphasis: target.emphasis,
        target_name: target.name,
        // Link annotations off the uploaded PDF. A LinkedIn address hidden
        // behind the word "LinkedIn" is invisible to every text extractor, so
        // the rebuild prints it out — see _merge_profile_links.
        links: readStrings(resume.linksJson),
        link_style: resume.linkStyle,
      },
      {
        onProgress: setStage,
        onStart: (kill) => holdRun(runId, kill),
      },
    );
  } catch (e) {
    // runAgent is documented never to throw, and this is here anyway: an
    // exception escaping an `after` callback is an unhandled rejection with
    // nobody left to catch it, and the row would sit on `running` until the
    // reaper found it ten minutes later.
    if (metered) await refund(userId, "variantRuns");
    await finish({
      status: "failed",
      stage: "Stopped",
      error: "Something went wrong on our side. You have not been charged for this.",
    });
    report({ source: "web", kind: "run-crashed", message: String(e), context: `run:${runId}` });
    return;
  }

  if (!result.ok) {
    if (metered) await refund(userId, "variantRuns");
    await finish({ status: "failed", stage: "Stopped", error: result.error });
    return;
  }

  if (result.aborted) {
    // Our side failed, or the input could not be worked with. Either way the
    // user did not get anything, so they are not charged for it.
    if (metered) await refund(userId, "variantRuns");
    await finish({ status: "failed", stage: "Stopped", error: abortMessage(result.aborted) });
    return;
  }

  if (!result.variants.length) {
    // A real and valid outcome: the rewrites ran and none beat the master. NOT
    // a failure, and not charged for either — a button was pressed and no
    // document came back.
    if (metered) await refund(userId, "variantRuns");
    // On a TARGETED run the agent ships the best company-shaped rebuild even
    // when nothing beats the master (see resume_optimize.run_optimize), so an
    // empty result here can only mean the builds themselves failed — telling
    // that user "nothing beat your resume, good sign" would be wrong twice.
    const targeted = Boolean(target.name || target.keywords.length);
    // The agent says, per rewrite, WHY it was dropped ("tightening lost 6
    // bullets", "render failed", "scored below"...). Until now those reasons
    // reached nobody: the route discarded them, so an empty run was a dead
    // end for the user AND undiagnosable for the admin. Lifted into the
    // error table (admin Health page) and the container log — the one time
    // the audit trail matters is exactly when nothing shipped.
    const why = (result.reasons ?? []).filter(Boolean).join(" | ").slice(0, 400);
    console.warn(`[variants] run ${runId} produced nothing (targeted=${targeted}): ${why}`);
    report({
      source: "agent",
      kind: targeted ? "rewrite-empty-targeted" : "rewrite-empty",
      message: why || "agent returned no variants and no reasons",
      context: `run:${runId} resume:${resume.id}`,
    });
    if (targeted) {
      await finish({
        status: "failed",
        stage: "Stopped",
        error:
          "We could not produce a tailored rebuild this time. You have not been charged — try again in a minute.",
      });
    } else {
      await finish({ status: "empty", stage: "Nothing beat your resume", variantsMade: 0 });
    }
    return;
  }

  setStage("Saving");

  // Replace, don't accumulate. A second run against the same target supersedes
  // the first: the user pressed the button again because they wanted a new
  // answer, and showing six cards from two runs side by side invites them to
  // download the older one. Files go with the rows.
  const superseded = await prisma.variant.findMany({
    where: { resumeId: resume.id, targetId: target.id },
    select: { id: true, file: true },
  });
  if (superseded.length) {
    await prisma.variant
      .deleteMany({ where: { id: { in: superseded.map((v) => v.id) } } })
      .catch((e) => console.error("[variants] supersede failed:", e));
    for (const old of superseded) {
      const dir = path.dirname(old.file);
      if (dir && dir !== ".") {
        await fsp
          .rm(path.join(VARIANT_DIR, resume.id, dir), { recursive: true, force: true })
          .catch(() => {});
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
            changesJson: toJsonColumn(v.changes ?? []),
            reportJson: toJsonColumn(v.report),
            fidelityJson: toJsonColumn(v.fidelity),
            // What "Use as my resume" needs: the fields this was printed from
            // and the text a parser read back off it. Stored now because
            // neither can be recovered later without another extraction pass,
            // and the second reading would be the one that disagrees with the
            // score already printed on the card.
            structJson: toJsonColumn(v.struct),
            text: typeof v.text === "string" ? v.text : "",
            // Run-scoped, so this row can only ever resolve to its own document.
            file: `${runDir}/${v.file}`,
            bytes: v.bytes ?? 0,
          },
        }),
      ),
    );
  } catch (e) {
    // The documents are on disk but nothing points at them. Charging for a
    // batch the user cannot reach would be charging for our own bug.
    if (metered) await refund(userId, "variantRuns");
    await finish({
      status: "failed",
      stage: "Stopped",
      error: "We built the rewrites but could not save them. You have not been charged.",
    });
    report({
      source: "web",
      kind: "variants-persist-failed",
      message: String(e),
      context: `run:${runId}`,
    });
    return;
  }

  // One history point per rebuild that was kept. `variantLabel` rather than a
  // relation on purpose: a variant is superseded and deleted on the next run,
  // and the record of what was measured has to outlive the document.
  await prisma.scoreEvent
    .createMany({
      data: created.map((v) => ({
        resumeId: resume.id,
        score: v.score,
        grade: v.grade,
        source: "variant" as const,
        variantLabel: v.label,
      })),
    })
    .catch((e) => console.error("[variants] score history write failed:", e));

  await audit(userId, "variants", resume.id, target.name || "untargeted");
  await finish({
    status: "done",
    stage: `${created.length} rebuild${created.length === 1 ? "" : "s"} ready`,
    variantsMade: created.length,
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
  body: {
    targetId?: string; company?: string; companyName?: string;
    jd?: string; notes?: string;
  },
): Promise<ResolvedTarget | { error: NextResponse }> {
  const none: ResolvedTarget = { id: null, name: "", keywords: [], emphasis: [] };

  if (body.targetId) {
    const t = await prisma.target.findFirst({
      where: { id: body.targetId, userId, resumeId },
    });
    if (!t) return { error: notFound() };
    return targetToResolved(t);
  }

  if (!body.company && !body.companyName && !body.jd && !body.notes) return none;

  // Validate the INPUT before checking the plan limit. The other order tells a
  // user with a two-word job description to buy a Season Pass — the request was
  // never going to work at any price, and "upgrade" as the response to a typo
  // is both confusing and faintly dishonest.
  const jdText = String(body.jd ?? "").slice(0, 20000);
  if (body.jd && jdText.trim().length < 60) {
    return { error: badRequest("Paste the full job description — that is too short to read anything from.") };
  }
  const notesText = String(body.notes ?? "").slice(0, 20000);
  if (body.notes && notesText.trim().length < 40) {
    return { error: badRequest("Write a little more — that is too short to read anything from.") };
  }

  // A cap on ROWS, not on value. Creating a target — and the free gap report
  // that comes with it — costs nothing under the unlock model; running against
  // it is what the target's lock gates. This exists only so a script cannot
  // grow the table unboundedly through one resume.
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
          error: `This resume already has ${formatLimit(limit)} targets. Remove one, or use another resume slot.`,
          code: "plan_limit",
        },
        { status: 402 },
      ),
    };
  }

  if (body.company) {
    // Reuse before create. Under the unlock model a repeated "Tailor for
    // Google" MUST resolve to the same row: the ₹99 purchase hangs off the
    // target's id, and a duplicate would let someone pay for one copy and
    // keep being refused on the other.
    const existing = await prisma.target.findFirst({
      where: { resumeId, slug: body.company },
      orderBy: { createdAt: "asc" },
    });
    if (existing) return targetToResolved(existing);
    const pack = await runAgent<{ pack: { name: string; keywords: string[]; emphasis: string[] } }>(
      "companies",
      { slug: body.company },
    );
    if (!pack.ok) return { error: badRequest("We do not have a pack for that company yet.") };
    const created = await prisma.target.create({
      data: {
        userId, resumeId, kind: "company",
        slug: body.company, name: pack.pack.name,
        specJson: toJsonColumn({ skills: pack.pack.keywords }),
      },
    });
    return {
      id: created.id,
      name: pack.pack.name,
      keywords: pack.pack.keywords ?? [],
      emphasis: pack.pack.emphasis ?? [],
    };
  }

  // What the USER knows about an employer — a conversation, a review they read,
  // what a friend was asked at interview.
  //
  // Parsed by exactly the same reader as a job description, because the useful
  // content is the same shape: skills the role wants. Stored under its own
  // `kind` so the UI can label it as theirs. That label is the point. We will
  // not read forum threads ourselves and present the result as knowledge —
  // every company pack on this page promises a link to the employer's own words,
  // and an anecdote laundered through us would make that promise false. Their
  // own anecdote is theirs to weigh.
  //
  // It buys exactly what a JD buys: coverage scoring and keyword surfacing. It
  // grants NO emphasis, so it cannot instruct a rewrite to do anything.
  if (body.notes) {
    const parsed = await runAgent<{ spec: { title: string; company: string; skills: string[] } }>(
      "jd", { text: notesText },
    );
    if (!parsed.ok) return { error: serverError("We could not read that.") };

    const name = String(body.companyName ?? "").trim() || parsed.spec.company || "Your notes";
    const created = await prisma.target.create({
      data: {
        userId, resumeId, kind: "notes", name: name.slice(0, 120),
        jdText: notesText,
        specJson: toJsonColumn({ skills: parsed.spec.skills ?? [], source: "user" }),
      },
    });
    return {
      id: created.id,
      name,
      keywords: parsed.spec.skills ?? [],
      emphasis: [],
    };
  }

  // A company typed by hand, with no curated pack behind it. The lookup runs
  // again here rather than trusting whatever the browser posted: the client
  // already called /api/companies/research to show the user what tailoring
  // would mean, but emphasis lines from that response are instructions we feed
  // to a rewrite, and instructions must not be round-tripped through a page
  // anyone can edit.
  if (body.companyName) {
    // Same reuse-before-create rule as the curated branch, for the same
    // money reason. Matched on the typed name case-insensitively — "google"
    // and "Google" must not become two rows with one unlock between them.
    const existingByName = await prisma.target.findFirst({
      where: {
        resumeId,
        kind: "company",
        name: { equals: body.companyName.trim(), mode: "insensitive" },
      },
      orderBy: { createdAt: "asc" },
    });
    if (existingByName) return targetToResolved(existingByName);
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
        specJson: toJsonColumn({
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
      jdText: jd, specJson: toJsonColumn(parsed.spec),
    },
  });
  return { id: created.id, name, keywords: parsed.spec.skills ?? [], emphasis: [] };
}

async function targetToResolved(t: {
  id: string; name: string; kind: string; slug: string | null; specJson: unknown;
}): Promise<ResolvedTarget> {
  const spec = readTargetSpec(t.specJson);
  // A curated pack is re-read from `companies.py` every time, so editing a pack
  // and deploying updates every target pointing at it. A generated one has no
  // pack to re-read, so its emphasis was stored on the target — and is used
  // verbatim rather than re-generated, because re-running the model on every
  // rebuild would silently change what a saved target means.
  let emphasis: string[] = spec?.emphasis ?? [];
  if (t.kind === "company" && t.slug) {
    const pack = await runAgent<{ pack: { emphasis: string[] } }>("companies", { slug: t.slug });
    if (pack.ok) emphasis = pack.pack.emphasis ?? [];
  }
  return { id: t.id, name: t.name, keywords: spec?.skills ?? [], emphasis };
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
