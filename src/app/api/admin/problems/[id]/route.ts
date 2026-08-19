import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, notFound, serverError } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Close a problem report, or reopen one.
 *
 * Reversible on purpose. A report closed by mistake is otherwise invisible, and
 * a fault that comes back should be reopened on the original rather than
 * re-reported by the next person who trips over it.
 */
export async function POST(req: Request, { params }: Ctx) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  let body: { resolved?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    // An empty body means resolve — that is the button on the page.
  }
  const resolved = body.resolved !== false;

  try {
    const updated = await prisma.problemReport.updateMany({
      where: { id },
      data: { resolvedAt: resolved ? new Date() : null },
    });
    if (updated.count === 0) return notFound();
  } catch (e) {
    return serverError("Could not update that report.", `admin/problems/${id}: ${String(e)}`);
  }

  await audit(auth.user.id, resolved ? "problem_resolved" : "problem_reopened", id);
  return NextResponse.json({ ok: true, resolved });
}
