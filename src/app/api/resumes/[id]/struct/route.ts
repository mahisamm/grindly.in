import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApprovedUser, notFound, badRequest, serverError } from "@/lib/auth";
import { toJsonColumn } from "@/lib/jsonColumn";
import { readStruct, sanitizeStruct } from "@/lib/resumeStruct";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Cap on a save body, checked against Content-Length before `req.json()`
 * buffers it. `sanitizeStruct` truncates every field (see LIMITS in
 * resumeStruct.ts), but it can only truncate what has already been read into
 * memory — and a real resume's structure is a few kilobytes, tens at the very
 * most. A megabyte is two orders of magnitude above the largest document
 * anyone has edited here; the only request it refuses is one that is not a
 * resume.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The saved fields, if there are any.
 *
 * READ ONLY. Extraction — which reserves quota, spawns an interpreter and
 * writes to the database — used to live here, on the GET, and that was wrong in
 * a way that costs users money: HTTP says a GET is safe and idempotent, and
 * browsers, mail-client link scanners and proxies all act on that. It is a POST
 * to ./extract now.
 *
 * 404 when nothing has been extracted yet, so the caller knows which door to
 * go through rather than being handed an empty structure that looks like an
 * empty resume.
 */
export async function GET(_req: Request, { params }: Ctx) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const resume = await prisma.resume.findFirst({
    where: { id, userId: auth.user.id },
    select: { structJson: true },
  });
  if (!resume) return notFound();

  const struct = readStruct(resume.structJson);
  if (!struct) {
    return NextResponse.json(
      {
        error: "This resume has not been read into fields yet.",
        code: "no_struct",
      },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, struct });
}

/**
 * Save an edited structure.
 *
 * Stores only. Rendering and re-scoring is a separate, deliberate step — see
 * the build route — because autosave firing a Chromium render on every
 * keystroke would be absurd, and because a user should be able to leave a
 * half-finished edit without it being measured and reported back at them.
 */
export async function PUT(req: Request, { params }: Ctx) {
  return savePut(req, await params);
}

/**
 * The same save, over POST, for `navigator.sendBeacon`.
 *
 * A beacon is the only request that reliably survives a tab closing, and it can
 * only ever be a POST — so the last thing someone typed before they navigated
 * away needs this door. Identical handler, and deliberately not a separate
 * "beacon" endpoint: two paths that write the same column drift, and the one
 * that gets exercised less is the one that drifts.
 */
export async function POST(req: Request, { params }: Ctx) {
  return savePut(req, await params);
}

async function savePut(req: Request, { id }: { id: string }) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;

  const resume = await prisma.resume.findFirst({
    where: { id, userId: auth.user.id },
    select: { id: true },
  });
  if (!resume) return notFound();

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "That is too much to save at once." },
      { status: 413 },
    );
  }

  let body: { struct?: unknown };
  try {
    body = await req.json();
  } catch {
    return badRequest("Send a JSON body.");
  }

  const struct = sanitizeStruct(body.struct);
  if (!struct) {
    return badRequest(
      "That resume has no content in it. Add at least one entry before saving.",
    );
  }

  try {
    await prisma.resume.update({
      where: { id: resume.id },
      data: { structJson: toJsonColumn(struct) },
    });
  } catch (e) {
    return serverError("Could not save your changes.", `struct:${id}: ${String(e)}`);
  }

  await audit(auth.user.id, "resume_edited", resume.id);
  return NextResponse.json({ ok: true, struct });
}
