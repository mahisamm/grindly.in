import { NextResponse } from "next/server";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";

const RESUME_DIR = path.join(process.cwd(), "data", "resumes");
const ALLOWED_EXT = new Set([".pdf", ".docx", ".txt"]);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

/** Accepts a resume file (pdf/docx/txt). Saves to disk for the Python agent to
 *  parse, and stores plain text immediately when the upload is .txt. */
export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    console.error("[resume] formData parse failed:", e);
    return NextResponse.json({ error: "Could not read the uploaded file. Try again." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file" }, { status: 400 });
  }

  const ext = (path.extname(file.name) || ".pdf").toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return NextResponse.json({ error: "Unsupported file type. Upload a PDF, DOCX, or TXT." }, { status: 400 });
  }
  // Reject oversized uploads before buffering the whole file into memory.
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File too large (max 5 MB)." }, { status: 413 });
  }
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) {
    return NextResponse.json({ error: "File too large (max 5 MB)." }, { status: 413 });
  }
  try {
    await fsp.mkdir(RESUME_DIR, { recursive: true });
  } catch (e) {
    console.error("[resume] mkdir failed:", e);
    return NextResponse.json({ error: "Server storage error — please try again later." }, { status: 500 });
  }
  const dest = path.join(RESUME_DIR, `${uid}${ext}`);
  try {
    await fsp.writeFile(dest, buf);
  } catch (e) {
    console.error("[resume] writeFile failed:", e);
    return NextResponse.json({ error: "Server storage error — please try again later." }, { status: 500 });
  }

  let resumeText: string | undefined;
  if (ext === ".txt") resumeText = buf.toString("utf8").slice(0, 20000);

  // The file is on disk; persist metadata + queue analysis. If the DB is briefly
  // unavailable, return a clean error instead of an unhandled 500 stack — the
  // user retries and the on-disk file is simply overwritten.
  try {
    await prisma.profile.upsert({
      where: { userId: uid },
      update: { resumeName: file.name, ...(resumeText ? { resumeText } : {}) },
      create: { userId: uid, resumeName: file.name, ...(resumeText ? { resumeText } : {}) },
    });

    // Queue a resume-analysis job; the worker fleet drains it, so the web app
    // needs no Python. The spawn below is a best-effort local "kick" so a dev box
    // without a running worker analyzes immediately (no-ops in the slim prod image).
    await prisma.agentRun.create({ data: { userId: uid, mode: "analyze" } });
  } catch (e) {
    console.error("[resume] db write failed:", e);
    return NextResponse.json({ error: "Could not save your resume — please try again." }, { status: 500 });
  }

  const worker = path.join(process.cwd(), "agent", "worker.py");
  try {
    await fsp.access(worker);
    const logDir = path.join(process.cwd(), "data", "logs");
    await fsp.mkdir(logDir, { recursive: true });
    const out = fs.openSync(path.join(logDir, `${uid}.log`), "a");
    const py = process.env.PYTHON_BIN || "python";
    const child = spawn(py, [worker, "--drain"], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", out, out],
    });
    fs.closeSync(out);
    child.on("error", () => {});
    child.unref();
  } catch {
    // No Python here — the worker drains the queued analyze job.
  }

  return NextResponse.json({ ok: true, resumeName: file.name, parsed: Boolean(resumeText) });
}
