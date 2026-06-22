import { NextResponse } from "next/server";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";

const RESUME_DIR = path.join(process.cwd(), "data", "resumes");

/** Accepts a resume file (pdf/docx/txt). Saves to disk for the Python agent to
 *  parse, and stores plain text immediately when the upload is .txt. */
export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file" }, { status: 400 });
  }

  const ext = (path.extname(file.name) || ".pdf").toLowerCase();
  await fsp.mkdir(RESUME_DIR, { recursive: true });
  const dest = path.join(RESUME_DIR, `${uid}${ext}`);
  const buf = Buffer.from(await file.arrayBuffer());
  await fsp.writeFile(dest, buf);

  let resumeText: string | undefined;
  if (ext === ".txt") resumeText = buf.toString("utf8").slice(0, 20000);

  await prisma.profile.update({
    where: { userId: uid },
    data: { resumeName: file.name, ...(resumeText ? { resumeText } : {}) },
  });

  // Spawn Python to parse + analyze the resume asynchronously
  const worker = path.join(process.cwd(), "agent", "worker.py");
  try {
    await fsp.access(worker);
    const logDir = path.join(process.cwd(), "data", "logs");
    await fsp.mkdir(logDir, { recursive: true });
    const out = fs.openSync(path.join(logDir, `${uid}.log`), "a");
    const py = process.env.PYTHON_BIN || "python";
    const child = spawn(py, [worker, "--user", uid, "--analyze"], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
  } catch {
    // worker not installed — skip analysis spawn
  }

  return NextResponse.json({ ok: true, resumeName: file.name, parsed: Boolean(resumeText) });
}
