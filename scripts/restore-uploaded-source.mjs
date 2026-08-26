#!/usr/bin/env node

/**
 * Restore an uploaded resume's derived fields from its original file.
 *
 * This is intentionally an operator-only maintenance command, not an API.
 * It exists for the narrow recovery path where an older application build
 * overwrote source metadata with text extracted from an edited PDF. The source
 * file is the authority. We collect every replacement value before making one
 * database update, so a broken parser can never leave a half-restored resume.
 *
 * Usage inside the web container:
 *   node scripts/restore-uploaded-source.mjs --resume-id <cuid>
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const resumeId = valueAfter("--resume-id");
if (!resumeId || !/^[a-z0-9]+$/i.test(resumeId)) {
  console.error("Usage: node scripts/restore-uploaded-source.mjs --resume-id <resume id>");
  process.exit(2);
}

const prisma = new PrismaClient();
const root = process.cwd();
const python = process.env.PYTHON_BIN || "python";
const cli = path.join(root, "agent", "cli.py");

function runAgent(command, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [cli], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`agent ${command} exited ${code}: ${stderr.slice(-500)}`));
      try {
        const result = JSON.parse(stdout);
        if (!result.ok) return reject(new Error(`agent ${command} failed: ${result.error || "unknown error"}`));
        resolve(result);
      } catch {
        reject(new Error(`agent ${command} returned invalid JSON: ${stdout.slice(0, 500)}`));
      }
    });
    child.stdin.end(`${JSON.stringify({ cmd: command, ...payload })}\n`);
  });
}

try {
  const resume = await prisma.resume.findUnique({
    where: { id: resumeId },
    select: { id: true, ext: true, originalName: true },
  });
  if (!resume?.ext) throw new Error("This resume has no uploaded source file to restore.");

  const source = path.join(root, "data", "resumes", `${resume.id}${resume.ext}`);
  await fs.access(source);

  const ingested = await runAgent("ingest", { path: source });
  const text = String(ingested.text || "");
  if (!text.trim()) throw new Error("The uploaded source extracted no text; nothing was changed.");
  const [scored, skills] = await Promise.all([
    runAgent("report", { text }),
    runAgent("skills", { text }),
  ]);

  await prisma.resume.update({
    where: { id: resume.id },
    data: {
      text: text.slice(0, 60_000),
      chars: Number(ingested.chars) || text.trim().length,
      truncated: Boolean(ingested.truncated),
      contactJson: ingested.contact || {},
      linksJson: ingested.links || [],
      skillsJson: skills.skills || [],
      score: scored.report?.score ?? null,
      grade: scored.report?.grade ?? null,
      reportJson: scored.report || Prisma.DbNull,
      pages: typeof ingested.pages === "number" ? ingested.pages : null,
      careerStage: scored.profile?.stage ?? null,
      careerSignals: scored.profile?.signals || Prisma.DbNull,
      // Any cached editor struct came from the corrupted source text. It must
      // be re-extracted from the restored source instead of silently reused.
      structJson: Prisma.DbNull,
      adviceJson: Prisma.DbNull,
    },
  });

  console.log(JSON.stringify({ ok: true, id: resume.id, chars: Number(ingested.chars) || text.trim().length, score: scored.report?.score ?? null }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
