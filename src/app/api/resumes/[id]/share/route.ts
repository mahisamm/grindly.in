import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { requireApprovedUser, notFound, serverError } from "@/lib/auth";
import { appUrl } from "@/lib/config";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Turn the readiness report into something readable without an account.
 *
 * WHAT THE LINK EXPOSES, precisely: the score, the five bands, and the
 * findings. Not the resume text, not the contact details, not the rebuilt PDFs,
 * not the name on the document. It is the measurement, which is what is worth
 * showing a senior who offered to look over your CV or a friend who asked what
 * the tool actually said — and it is the part that identifies nobody.
 *
 * 32 random bytes, base64url. Unguessable is the entire access control, which
 * is only acceptable because of what is on the other side of it.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const resume = await prisma.resume.findFirst({
    where: { id, userId: auth.user.id },
    select: { id: true, shareToken: true },
  });
  if (!resume) return notFound();

  // Re-issuing returns the same link rather than minting a second one, so a
  // user who presses the button twice does not quietly invalidate the address
  // they already sent someone.
  if (resume.shareToken) {
    return NextResponse.json({
      ok: true,
      token: resume.shareToken,
      url: `${appUrl()}/r/${resume.shareToken}`,
      existing: true,
    });
  }

  const token = randomBytes(24).toString("base64url");
  try {
    await prisma.resume.update({ where: { id: resume.id }, data: { shareToken: token } });
  } catch (e) {
    return serverError("Could not create a link.", `share:${id}: ${String(e)}`);
  }

  await audit(auth.user.id, "share_created", resume.id);
  return NextResponse.json({
    ok: true,
    token,
    url: `${appUrl()}/r/${token}`,
    existing: false,
  });
}

/**
 * Revoke the link.
 *
 * Sets the token back to null rather than rotating it, so a link that went to
 * the wrong person stops working — the point of a revoke is that the old
 * address is dead, not that it is now harder to guess.
 */
export async function DELETE(_req: Request, { params }: Ctx) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const updated = await prisma.resume.updateMany({
    where: { id, userId: auth.user.id },
    data: { shareToken: null },
  });
  if (updated.count === 0) return notFound();

  await audit(auth.user.id, "share_revoked", id);
  return NextResponse.json({ ok: true });
}
