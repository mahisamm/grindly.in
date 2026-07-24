import { NextResponse } from "next/server";
import fsp from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getUid, clearUid } from "@/lib/session";
import { audit } from "@/lib/audit";

// Where the user's own files live. Kept in step with api/resume/route.ts.
const RESUME_DIR = path.join(process.cwd(), "data", "resumes");
const TEX_DIR = path.join(process.cwd(), "data", "resume_tex");
const RESUME_EXTS = [".pdf", ".docx", ".txt"];

/**
 * Self-serve account deletion. The one auth surface the user genuinely controls:
 * a logged-in person can erase their own account and every row that hangs off it.
 *
 * The session cookie is SameSite=lax, and a DELETE is never a top-level GET
 * navigation, so the browser will not attach the cookie to a cross-site DELETE —
 * that is the CSRF defence. On top of it we require an explicit `{ confirm: true }`
 * body so a stray same-origin fetch can't nuke the account by accident.
 */
export async function DELETE(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  let confirm = false;
  try {
    const body = await req.json();
    confirm = body?.confirm === true;
  } catch {
    // no/invalid body — treated as unconfirmed below
  }
  if (!confirm) {
    return NextResponse.json({ error: "confirmation required" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: { email: true },
  });
  if (!user) {
    // Cookie points at a user that's already gone — clear it and move on.
    await clearUid();
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Record the deletion with userId:null so the audit row SURVIVES the cascade.
  // AuditLog.userId is onDelete:Cascade — an entry tagged with this uid would be
  // deleted along with the user, erasing the very trail we want to keep. Identity
  // is preserved in target/detail instead.
  await audit("account_deleted", { userId: null, target: user.email, detail: uid });

  // The rows cascade, the FILES do not. Collect the per-application resume
  // snapshots before the delete, because after it there is nothing left to ask.
  let snapshotPaths: string[] = [];
  try {
    const versions = await prisma.resumeVersion.findMany({
      where: { userId: uid },
      select: { filePath: true },
    });
    snapshotPaths = versions
      .map((v) => v.filePath)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
  } catch {
    // Best-effort: never block the deletion on being able to enumerate files.
  }

  // Every User relation is onDelete:Cascade EXCEPT PasswordResetToken, which
  // carries a bare user_id column with no FK — so it won't cascade. Clear it
  // explicitly in the same transaction so no orphan reset tokens linger.
  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({ where: { userId: uid } }),
    prisma.user.delete({ where: { id: uid } }),
  ]);

  // Erase the account's files too. "Delete my account" that leaves the CV on
  // disk is not a deletion — a resume carries the person's name, phone number,
  // address, education and work history, and the DB cascade never touched any
  // of it. Runs after the transaction so a filesystem problem can never leave
  // the account half-deleted, and every unlink is independently best-effort.
  const files = [
    ...RESUME_EXTS.map((ext) => path.join(RESUME_DIR, `${uid}${ext}`)),
    path.join(TEX_DIR, `${uid}.tex`),
    // Snapshot PDFs are stored relative to the project root (see agent/db.py).
    ...snapshotPaths.map((p) => (path.isAbsolute(p) ? p : path.join(process.cwd(), p))),
  ];
  await Promise.all(
    files.map((f) =>
      fsp.rm(f, { force: true }).catch((e) => {
        console.error("[account] could not remove %s: %s", f, e);
      }),
    ),
  );

  await clearUid();
  return NextResponse.json({ ok: true });
}
