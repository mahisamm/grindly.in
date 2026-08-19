import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, badRequest, notFound, serverError } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const STATUSES = ["pending", "approved", "blocked"] as const;
type Status = (typeof STATUSES)[number];

function isStatus(value: unknown): value is Status {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

/**
 * Let someone into the beta, or take them back out.
 *
 * One button on the admin page, and three states behind it rather than a
 * boolean. `blocked` is not the same as deleted and not the same as pending: an
 * account that has to stop working right now should stop, without its owner's
 * resumes being destroyed on the operator's say-so and without them being left
 * to refresh a "nearly there" page forever. What they see is written on
 * /pending, and it differs per state for exactly that reason.
 *
 * Who approved an account and when are both recorded. In a closed beta the
 * question "how did this person get in" has to have an answer.
 */
export async function POST(req: Request, { params }: Ctx) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  let body: { status?: unknown };
  try {
    body = await req.json();
  } catch {
    return badRequest("Send a JSON body.");
  }
  if (!isStatus(body.status)) {
    return badRequest("Status must be pending, approved or blocked.");
  }

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, role: true, accessStatus: true },
  });
  if (!target || target.role === "admin") {
    // An admin is never gated — `isApproved` says so — so letting the queue
    // pretend to change one would be a button that reports success and does
    // nothing. 404 rather than 403: the queue only ever lists non-admins, so
    // reaching this means someone constructed the request by hand.
    return notFound();
  }

  try {
    await prisma.user.update({
      where: { id: target.id },
      data: {
        accessStatus: body.status,
        approvedAt: body.status === "approved" ? new Date() : null,
        approvedBy: body.status === "approved" ? auth.user.id : null,
      },
    });
  } catch (e) {
    return serverError("Could not update that account.", `admin/access/${id}: ${String(e)}`);
  }

  await audit(auth.user.id, `access_${body.status}`, target.id, target.email);
  return NextResponse.json({ ok: true, status: body.status });
}
