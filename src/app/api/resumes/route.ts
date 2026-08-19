import { NextResponse } from "next/server";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { requireApprovedUser, badRequest, serverError } from "@/lib/auth";
import { runAgent, RESUME_DIR, type Report } from "@/lib/agent";
import { formatLimit, limitsFor } from "@/lib/plans";
import { reserve, refund } from "@/lib/quota";
import { toJsonColumn, toJsonValue } from "@/lib/jsonColumn";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
// Uploading spawns Python, reads a PDF and scores it. Nothing here is cacheable
// and a stale resume list is worse than a slow one.
export const dynamic = "force-dynamic";

const ALLOWED_EXT = new Set([".pdf", ".docx", ".txt"]);
const MAX_BYTES = 5 * 1024 * 1024;

/** Everything the user has uploaded, newest first. */
export async function GET() {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;

  const resumes = await prisma.resume.findMany({
    where: { userId: auth.user.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, label: true, originalName: true, chars: true,
      score: true, grade: true, createdAt: true, updatedAt: true,
      _count: { select: { variants: true, targets: true } },
    },
  });
  return NextResponse.json({ ok: true, resumes });
}

/**
 * Upload a resume: store it, read it, score it. Synchronously.
 *
 * The old build wrote the file, enqueued an `analyze` job and returned — so the
 * user landed on a dashboard that said "analyzing…" and polled. Extraction and
 * scoring take under a second combined (the score is a pure function; only the
 * optional advice needs a model), so the whole round trip fits inside the
 * request and the user gets their report on the page they uploaded from.
 */
export async function POST(req: Request) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;

  const quota = await reserve(user.id, "uploads");
  if (!quota.allowed) {
    return NextResponse.json({ error: quota.message }, { status: 429 });
  }

  const giveBack = async () => refund(user.id, "uploads");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    await giveBack();
    return badRequest("Upload a file — this endpoint does not take JSON.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    await giveBack();
    return badRequest("Choose a file to upload.");
  }

  const ext = (path.extname(file.name) || "").toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    await giveBack();
    return badRequest("Upload a PDF, DOCX or TXT file.");
  }
  if (file.size > MAX_BYTES) {
    await giveBack();
    return NextResponse.json({ error: "That file is larger than 5 MB." }, { status: 413 });
  }

  const count = await prisma.resume.count({ where: { userId: user.id } });
  if (count >= limitsFor(user).resumes) {
    await giveBack();
    return NextResponse.json(
      {
        error: `Your plan holds ${formatLimit(limitsFor(user).resumes)} resumes. Delete one, or get a Season Pass.`,
        code: "plan_limit",
      },
      { status: 402 },
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.byteLength === 0) {
    await giveBack();
    return badRequest("That file is empty.");
  }

  // The row is created first so the file can be named after its id. Naming by
  // user id (what the old build did) meant one resume per account and a second
  // upload silently overwrote the first.
  let resume;
  try {
    resume = await prisma.resume.create({
      data: {
        userId: user.id,
        label: file.name.replace(/\.[^.]+$/, "").slice(0, 80) || "My resume",
        originalName: file.name.slice(0, 200),
        ext,
      },
      select: { id: true },
    });
  } catch (e) {
    console.error("[resumes] create failed:", e);
    await giveBack();
    return serverError("Could not save your resume. Try again.");
  }

  const dest = path.join(RESUME_DIR, `${resume.id}${ext}`);
  try {
    await fsp.mkdir(RESUME_DIR, { recursive: true });
    await fsp.writeFile(dest, buf);
  } catch (e) {
    console.error("[resumes] write failed:", e);
    await prisma.resume.delete({ where: { id: resume.id } }).catch(() => null);
    await giveBack();
    return serverError("Could not store the file. Try again.");
  }

  const ingested = await runAgent<{
    text: string; chars: number; truncated: boolean;
    links: string[]; contact: Record<string, unknown>;
  }>("ingest", { path: dest });

  if (!ingested.ok) {
    // Keep the row and the file: the user can see that the upload arrived and
    // retry the read. Deleting here would make a transient Python failure look
    // like a rejected file.
    await prisma.resume.update({
      where: { id: resume.id },
      data: { text: "", chars: 0 },
    }).catch(() => null);
    return NextResponse.json(
      { ok: true, id: resume.id, warning: `We stored the file but could not read it: ${ingested.error}` },
      { status: 202 },
    );
  }

  const text = ingested.text ?? "";
  const scored = await runAgent<{ report: Report }>("report", { text });
  const report = scored.ok ? scored.report : null;

  const skills = await runAgent<{ skills: string[] }>("skills", { text });

  try {
    await prisma.resume.update({
      where: { id: resume.id },
      data: {
        text: text.slice(0, 60000),
        chars: ingested.chars ?? text.trim().length,
        truncated: Boolean(ingested.truncated),
        contactJson: toJsonColumn(ingested.contact ?? {}),
        linksJson: toJsonColumn(ingested.links ?? []),
        skillsJson: toJsonValue(skills.ok ? skills.skills : []),
        score: report?.score ?? null,
        grade: report?.grade ?? null,
        reportJson: toJsonColumn(report),
        textHash: crypto.createHash("sha256").update(text).digest("hex"),
      },
    });
  } catch (e) {
    console.error("[resumes] update failed:", e);
    return serverError("We read your resume but could not save the result.");
  }

  // The first point on this resume's history. Written after the row is saved,
  // so a score that exists in the history is always one the resume actually
  // carried.
  if (report) {
    await prisma.scoreEvent
      .create({
        data: {
          resumeId: resume.id,
          score: report.score,
          grade: report.grade,
          source: "upload",
        },
      })
      .catch((e) => console.error("[resumes] score history write failed:", e));
  }

  await audit(user.id, "resume_upload", resume.id, file.name);
  return NextResponse.json({ ok: true, id: resume.id, report, truncated: Boolean(ingested.truncated) });
}
