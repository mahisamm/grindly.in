import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, badRequest, serverError } from "@/lib/auth";
import { isRateLimited } from "@/lib/rateLimit";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Someone telling us something went wrong.
 *
 * Gated on being signed in but NOT on being approved. A beta user stuck behind
 * the access queue, or blocked by mistake, is exactly the person with something
 * worth saying — and a report button that refuses the people it most needs to
 * hear from is decoration.
 *
 * Per account rather than per IP, because `isRateLimitedByIp` does nothing
 * without a trusted proxy and this endpoint writes rows. Ten an hour is far more
 * than anyone reports in good faith and far less than a script needs.
 */
export async function POST(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;

  if (await isRateLimited(`problem:acct:${user.id}`, 10, 60 * 60 * 1000)) {
    return NextResponse.json(
      { error: "That is a lot of reports in an hour. Try again shortly." },
      { status: 429 },
    );
  }

  let body: { message?: unknown; path?: unknown; resumeId?: unknown };
  try {
    body = await req.json();
  } catch {
    return badRequest("Send a JSON body.");
  }

  const message = String(body.message ?? "").trim().slice(0, 4000);
  // Ten characters, not one. "bug" is a report nobody can act on, and the form
  // says so before it is submitted rather than accepting it and wasting the
  // reporter's goodwill.
  if (message.length < 10) {
    return badRequest("Tell us a little more — a sentence is enough.");
  }

  // The resume is verified to be THEIRS before it is stored. It is a client-
  // supplied id, and a report that links an admin to someone else's document
  // would be a quiet way to hand out a resume.
  let resumeId: string | null = null;
  const claimed = String(body.resumeId ?? "").trim();
  if (claimed) {
    const owned = await prisma.resume.findFirst({
      where: { id: claimed, userId: user.id },
      select: { id: true },
    });
    resumeId = owned?.id ?? null;
  }

  try {
    await prisma.problemReport.create({
      data: {
        userId: user.id,
        message,
        path: String(body.path ?? "").trim().slice(0, 300) || null,
        // Read from the header rather than the body: it is the one field the
        // reporter has no reason to set and every reason to have set correctly.
        userAgent: (req.headers.get("user-agent") ?? "").slice(0, 300) || null,
        resumeId,
      },
    });
  } catch (e) {
    return serverError("Could not save that report.", `problems: ${String(e)}`);
  }

  await audit(user.id, "problem_reported", resumeId);
  return NextResponse.json({
    ok: true,
    message: "Thank you — that went straight to the person who can fix it.",
  });
}
