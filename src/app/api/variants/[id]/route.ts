import { NextResponse } from "next/server";
import fsp from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { requireApprovedUser, notFound, serverError } from "@/lib/auth";
import { VARIANT_DIR } from "@/lib/agent";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Delete one rebuild the user no longer wants.
 *
 * A resume accumulates rebuilds — the AI strategies, the "Yours" editor build,
 * older runs — and until now there was no way to clear one. Deleting removes
 * the row AND its PDF from disk: a variant the user asked to be gone must not
 * leave a downloadable file behind.
 *
 * Ownership is checked through the resume, the only row here carrying a userId
 * — the variant id is client-supplied, so this is the line between deleting
 * your own rebuild and deleting somebody else's. Promoted copies are their own
 * resumes and are untouched by this: deleting the rebuild it came from does not
 * delete the document the user chose to keep.
 */
export async function DELETE(_req: Request, { params }: Ctx) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const variant = await prisma.variant.findFirst({
    where: { id, resume: { userId: auth.user.id } },
    select: { id: true, file: true, resumeId: true, label: true },
  });
  if (!variant) return notFound();

  try {
    await prisma.variant.delete({ where: { id: variant.id } });
  } catch (e) {
    return serverError("Could not delete that rebuild.", `variant delete ${id}: ${String(e)}`);
  }

  // Remove the run's directory from disk. The file column is `${runDir}/name.pdf`,
  // and each run writes into its own directory — so the directory is the unit to
  // remove. Path is confined under VARIANT_DIR/<resumeId> and any traversal in
  // the stored value is stripped, the same guard the file route uses.
  const dir = path.dirname(variant.file);
  if (dir && dir !== "." && !dir.includes("..")) {
    await fsp
      .rm(path.join(VARIANT_DIR, variant.resumeId, dir), { recursive: true, force: true })
      .catch(() => {});
  }

  await audit(auth.user.id, "variant_deleted", variant.resumeId, variant.label);
  return NextResponse.json({ ok: true });
}
