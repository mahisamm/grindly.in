import { NextResponse } from "next/server";
import fsp from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { requireUser, serverError } from "@/lib/auth";
import { clearUid } from "@/lib/session";
import { RESUME_DIR, VARIANT_DIR } from "@/lib/agent";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Delete the account and everything in it.
 *
 * This exists because the privacy policy says it does. Under India's DPDP Act
 * 2023 and the GDPR, erasure is a right, and a policy page that claims "delete
 * your account and the files go with it" while the software has no such
 * endpoint is a false statement about a legal right — worse than not claiming
 * it at all.
 *
 * A hard delete, not a `deletedAt` flag. Everything hangs off User with
 * `onDelete: Cascade`, so one row removal takes the resumes, targets, variants,
 * orders, usage counters and audit rows with it. The files are removed
 * separately because Postgres does not know about them.
 */
export async function DELETE(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;

  // Typing the email is the confirmation. A destructive, irreversible action
  // reached by a single fetch is one mis-click or one CSRF away from a support
  // ticket nobody can resolve, because there is nothing left to restore.
  let body: { confirm?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });
  }
  if ((body.confirm ?? "").trim().toLowerCase() !== user.email.toLowerCase()) {
    return NextResponse.json(
      { error: "Type your email address exactly to confirm." },
      { status: 400 },
    );
  }

  const resumes = await prisma.resume.findMany({
    where: { userId: user.id },
    select: { id: true, ext: true },
  });

  try {
    await prisma.user.delete({ where: { id: user.id } });
  } catch (e) {
    console.error("[account] delete failed:", e);
    return serverError("Could not delete the account. Nothing was removed.");
  }

  // Files after rows. The other order can leave rows pointing at bytes that no
  // longer exist, which renders as a broken download the user cannot get rid of;
  // this order can at worst leave orphaned bytes, which a sweep can find.
  for (const r of resumes) {
    if (r.ext) {
      await fsp.rm(path.join(RESUME_DIR, `${r.id}${r.ext}`), { force: true }).catch(() => {});
    }
    await fsp.rm(path.join(VARIANT_DIR, r.id), { recursive: true, force: true }).catch(() => {});
  }

  await clearUid();
  // Deliberately audited with a null user id: the row the foreign key pointed
  // at is gone, and the record of the deletion should outlive it.
  await audit(null, "account_delete", user.email);
  return NextResponse.json({ ok: true });
}
