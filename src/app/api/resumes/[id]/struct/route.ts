import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, notFound, badRequest, serverError } from "@/lib/auth";
import { runAgent } from "@/lib/agent";
import { toJsonColumn } from "@/lib/jsonColumn";
import { readContact } from "@/lib/reportTypes";
import { readStruct, sanitizeStruct } from "@/lib/resumeStruct";
import { reserve, refund } from "@/lib/quota";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Extraction is model calls, and a cold interpreter in front of them.
export const maxDuration = 180;

type Ctx = { params: Promise<{ id: string }> };

/**
 * The resume as editable fields.
 *
 * Cached on the row after the first read, because extraction costs model calls
 * and the editor would otherwise pay for it on every page load. `?refresh=1`
 * re-extracts — for the case where someone has replaced the underlying file and
 * wants the fields to catch up, which is rare enough to be explicit and
 * expensive enough not to be automatic.
 */
export async function GET(req: Request, { params }: Ctx) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const resume = await prisma.resume.findFirst({
    where: { id, userId: auth.user.id },
    select: { id: true, text: true, structJson: true, contactJson: true },
  });
  if (!resume) return notFound();

  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  const cached = refresh ? null : readStruct(resume.structJson);
  if (cached) return NextResponse.json({ ok: true, struct: cached, cached: true });

  if (!resume.text || resume.text.trim().length < 200) {
    return badRequest(
      "There is not enough readable text in this resume to turn into fields. " +
        "Upload the original PDF rather than a scan.",
    );
  }

  // Extraction is metered against the advice allowance rather than being free.
  // It is the same shape of cost — several model calls on demand — and an
  // unmetered endpoint that spawns them is how one script exhausts the free
  // tier everyone on the instance shares.
  const quota = await reserve(auth.user.id, "adviceRuns");
  if (!quota.allowed) {
    return NextResponse.json({ error: quota.message, code: "quota" }, { status: 429 });
  }

  const contact = readContact(resume.contactJson);
  const extracted = await runAgent<{ struct: unknown }>("struct", {
    text: resume.text,
    contact_fallback: contact.contact_line ?? "",
  });

  if (!extracted.ok) {
    await refund(auth.user.id, "adviceRuns");
    return serverError(extracted.error, `struct:${resume.id}`);
  }

  const struct = sanitizeStruct(extracted.struct);
  if (!struct) {
    await refund(auth.user.id, "adviceRuns");
    return serverError(
      "We could not read a clear structure out of this resume.",
      `struct:${resume.id}`,
    );
  }

  await prisma.resume
    .update({ where: { id: resume.id }, data: { structJson: toJsonColumn(struct) } })
    .catch((e) => console.error("[struct] cache write failed:", e));

  return NextResponse.json({ ok: true, struct, cached: false });
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
  const auth = await requireUser();
  if ("error" in auth) return auth.error;

  const resume = await prisma.resume.findFirst({
    where: { id, userId: auth.user.id },
    select: { id: true },
  });
  if (!resume) return notFound();

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
