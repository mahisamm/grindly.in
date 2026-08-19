import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApprovedUser, notFound, serverError } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Make this resume the one the account is sending out.
 *
 * The counterpart to promoting a rebuild, and the reason promoting one is safe:
 * primary is a pointer, and it moves in both directions. Nothing is copied,
 * nothing is deleted, and an account that promoted a rewrite it turns out not to
 * like is one press away from where it started.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const owned = await prisma.resume.findFirst({
    where: { id, userId: auth.user.id },
    select: { id: true },
  });
  if (!owned) return notFound();

  try {
    await prisma.user.update({
      where: { id: auth.user.id },
      data: { primaryResumeId: owned.id },
    });
  } catch (e) {
    return serverError("Could not save that.", `primary:${id}: ${String(e)}`);
  }

  await audit(auth.user.id, "primary_resume", owned.id);
  return NextResponse.json({ ok: true, id: owned.id });
}
