import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApprovedUser, badRequest, notFound, serverError } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Choose how this resume prints its profile addresses.
 *
 * Stored on the resume rather than on the account, because it is a property of
 * a document: someone may reasonably want the address spelled out on the resume
 * they upload to a portal and the tidier form on the one they hand to a person.
 *
 * Takes effect on the next render. Nothing is re-rendered here — rebuilding
 * costs a Chromium pass and a quota unit, and silently spending one because
 * somebody pressed a toggle would be spending their allowance on our idea of
 * helpfulness.
 */
export async function POST(req: Request, { params }: Ctx) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  let body: { linkStyle?: unknown };
  try {
    body = await req.json();
  } catch {
    return badRequest("Send a JSON body.");
  }

  const linkStyle = body.linkStyle;
  if (linkStyle !== "url" && linkStyle !== "label") {
    return badRequest("Choose either the full address or the site name.");
  }

  try {
    const updated = await prisma.resume.updateMany({
      where: { id, userId: auth.user.id },
      data: { linkStyle },
    });
    if (updated.count === 0) return notFound();
  } catch (e) {
    return serverError("Could not save that.", `link-style:${id}: ${String(e)}`);
  }

  await audit(auth.user.id, "link_style", id, linkStyle);
  return NextResponse.json({ ok: true, linkStyle });
}
