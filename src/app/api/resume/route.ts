import { NextResponse } from "next/server";
import fsp from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { spawnWorkerKick } from "@/lib/workerKick";
import { enqueueAgentRun } from "@/lib/agentRunQueue";

const RESUME_DIR = path.join(process.cwd(), "data", "resumes");
// The .tex lives in its OWN directory, not beside the PDF. agent/resume_parse.py's
// find_resume_file() scans data/resumes for a file starting "<uid>." and hands the
// first hit to the PDF/DOCX text extractor — drop a .tex in there and it would be
// picked as the resume itself and parsed as garbage.
const TEX_DIR = path.join(process.cwd(), "data", "resume_tex");

const ALLOWED_EXT = new Set([".pdf", ".docx", ".txt"]);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_TEX_BYTES = 512 * 1024;  // a resume .tex is a few KB; 512 KB is already absurd

type Kind = "master" | "tex";

/**
 * Accepts the master resume (pdf/docx/txt) OR its LaTeX source (.tex).
 *
 * Two files, two purposes:
 *   - master: what actually gets sent to a recruiter, and what we parse skills from.
 *   - tex:    the source the agent edits (Skills/Hobbies only) and recompiles when a
 *             role needs a tailored version. Optional — without it the agent sends
 *             the master untouched rather than reconstructing a lookalike.
 *
 * Re-uploading a master is the supported way to change your resume: the new one is
 * used from the next run on.
 */
export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    console.error("[resume] formData parse failed:", e);
    return NextResponse.json(
      { error: "Upload a resume file (PDF, DOCX, TXT, or .tex) — not text or JSON." },
      { status: 400 },
    );
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file" }, { status: 400 });
  }

  const ext = (path.extname(file.name) || ".pdf").toLowerCase();
  const kind: Kind = ext === ".tex" ? "tex" : "master";

  if (kind === "master" && !ALLOWED_EXT.has(ext)) {
    return NextResponse.json(
      { error: "Unsupported file type. Upload a PDF, DOCX, TXT, or .tex." },
      { status: 400 },
    );
  }

  const limit = kind === "tex" ? MAX_TEX_BYTES : MAX_BYTES;
  const human = kind === "tex" ? "512 KB" : "5 MB";
  if (file.size > limit) {
    return NextResponse.json({ error: `File too large (max ${human}).` }, { status: 413 });
  }
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.byteLength > limit) {
    return NextResponse.json({ error: `File too large (max ${human}).` }, { status: 413 });
  }

  const dir = kind === "tex" ? TEX_DIR : RESUME_DIR;
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (e) {
    console.error("[resume] mkdir failed:", e);
    return NextResponse.json({ error: "Server storage error — please try again later." }, { status: 500 });
  }

  const dest =
    kind === "tex"
      ? path.join(TEX_DIR, `${uid}.tex`)
      : path.join(RESUME_DIR, `${uid}${ext}`);
  try {
    await fsp.writeFile(dest, buf);
  } catch (e) {
    console.error("[resume] writeFile failed:", e);
    return NextResponse.json({ error: "Server storage error — please try again later." }, { status: 500 });
  }

  if (kind === "tex") {
    // The .tex is only a tailoring input — it changes nothing about the extracted
    // skills or the resume score, so there's no resume analysis to re-run.
    //
    // But it DOES need proving. A .tex that won't compile, or whose section
    // headings we don't recognise, would otherwise fail silently and forever: the
    // agent would fall back to the master resume on every single application and
    // never say why. So queue a one-off check (worker mode "latex_check") that
    // compiles the untouched source and reports back — the dashboard shows the
    // verdict on the upload slot.
    try {
      await prisma.profile.upsert({
        where: { userId: uid },
        update: {
          resumeTexName: file.name,
          resumeTexStatus: "checking",
          resumeTexDetail: null,
        },
        create: { userId: uid, resumeTexName: file.name, resumeTexStatus: "checking" },
      });
      await enqueueAgentRun(uid, "latex_check");
    } catch (e) {
      console.error("[resume] db write failed:", e);
      return NextResponse.json({ error: "Could not save your LaTeX source — please try again." }, { status: 500 });
    }

    const worker = path.join(process.cwd(), "agent", "worker.py");
    try {
      await fsp.access(worker);
      spawnWorkerKick(process.cwd(), uid);
    } catch {
      // No Python here — the worker fleet drains the queued check.
    }

    return NextResponse.json({ ok: true, kind, resumeTexName: file.name });
  }

  // A NEW master resume invalidates everything derived from the old one.
  //
  // This is the bug that made "upload a new resume" a no-op: the old extracted
  // skills stayed on the profile, and worker.run_for_user only re-extracts when
  // the skill list is EMPTY (`if (not skills) and text`). So a user who added
  // three new skills and re-uploaded got matched on their old resume forever, with
  // no indication anything was wrong. Clearing these forces a fresh parse.
  const resetDerived = {
    skills: "[]",
    resumeText: ext === ".txt" ? buf.toString("utf8").slice(0, 20000) : null,
    resumeScore: null,
    resumeSuggestions: null,
    resumeParseFailed: false,
  };

  // Old resumes on disk for this uid, under a different extension, would otherwise
  // linger and could be picked up by find_resume_file() instead of the new one.
  for (const old of ALLOWED_EXT) {
    if (old === ext) continue;
    await fsp.rm(path.join(RESUME_DIR, `${uid}${old}`), { force: true }).catch(() => {});
  }

  try {
    await prisma.profile.upsert({
      where: { userId: uid },
      update: { resumeName: file.name, ...resetDerived },
      create: { userId: uid, resumeName: file.name, ...resetDerived },
    });

    // Queue a resume-analysis job; the worker fleet drains it, so the web app
    // needs no Python. The spawn below is a best-effort local "kick" so a dev box
    // without a running worker analyzes immediately (no-ops in the slim prod image).
    await enqueueAgentRun(uid, "analyze");
  } catch (e) {
    console.error("[resume] db write failed:", e);
    return NextResponse.json({ error: "Could not save your resume — please try again." }, { status: 500 });
  }

  const worker = path.join(process.cwd(), "agent", "worker.py");
  try {
    await fsp.access(worker);
    spawnWorkerKick(process.cwd(), uid);
  } catch {
    // No Python here — the worker drains the queued analyze job.
  }

  return NextResponse.json({
    ok: true,
    kind,
    resumeName: file.name,
    parsed: ext === ".txt",
  });
}
