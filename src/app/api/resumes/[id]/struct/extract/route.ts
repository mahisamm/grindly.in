import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApprovedUser, notFound, badRequest, serverError } from "@/lib/auth";
import { runAgent } from "@/lib/agent";
import { toJsonColumn } from "@/lib/jsonColumn";
import { readContact, readStrings } from "@/lib/reportTypes";
import { extractionCoverage, readStruct, sanitizeStruct } from "@/lib/resumeStruct";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Extraction is model calls, and a cold interpreter in front of them.
export const maxDuration = 180;

type Ctx = { params: Promise<{ id: string }> };

/**
 * Read a resume into editable fields.
 *
 * A POST, and that is a correction rather than a preference. This lived on the
 * struct route's GET, where it reserved quota, spawned an interpreter and wrote
 * to the database — all of which a GET is not allowed to do. HTTP says a GET is
 * safe and idempotent, and the things that believe it are not hypothetical:
 * browsers speculatively fetch, link scanners in mail clients follow URLs,
 * proxies retry, and every one of those would have spent a user's daily
 * allowance on a model call nobody asked for.
 *
 * The result is cached on the resume row, so this runs once per resume unless
 * `{"refresh": true}` asks for it again — which is for the case where someone
 * has replaced the underlying file and wants the fields to catch up.
 */
export async function POST(req: Request, { params }: Ctx) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const resume = await prisma.resume.findFirst({
    where: { id, userId: auth.user.id },
    select: {
      id: true, text: true, structJson: true, contactJson: true, linksJson: true,
    },
  });
  if (!resume) return notFound();

  let body: { refresh?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    // No body means "extract if you have not already", which is the button.
  }

  // Already done, and not being asked to do it again. Returned rather than
  // re-run: this is the path a double click takes, and the second press should
  // not cost a second call.
  if (!body.refresh) {
    const cached = readStruct(resume.structJson);
    if (cached) return NextResponse.json({ ok: true, struct: cached, cached: true });
  }

  if (!resume.text || resume.text.trim().length < 200) {
    return badRequest(
      "There is not enough readable text in this resume to turn into fields. " +
        "Upload the original PDF rather than a scan.",
    );
  }

  const contact = readContact(resume.contactJson);
  const extracted = await runAgent<{ struct: unknown }>("struct", {
    text: resume.text,
    contact_fallback: contact.contact_line ?? "",
    // The PDF's link annotations. A LinkedIn address hidden behind the word
    // "LinkedIn" is invisible to every text extractor, so the header the editor
    // opens with would silently lose it — the same reason the rewrite path
    // passes these through.
    links: readStrings(resume.linksJson),
  });

  if (!extracted.ok) {
    return serverError(extracted.error, `struct:${resume.id}`);
  }

  const struct = sanitizeStruct(extracted.struct);
  if (!struct) {
    return serverError(
      "We could not read a clear structure out of this resume.",
      `struct:${resume.id}`,
    );
  }

  const coverage = extractionCoverage(resume.text, struct);
  // A normal extraction reorganises punctuation and labels, but keeps most
  // meaningful terms.  A missing Experience/Education section is dramatically
  // below this floor.  Fail closed: the uploaded file remains the source of
  // truth and the user can retry instead of unknowingly building a partial CV.
  if (coverage.sourceTerms >= 20 && coverage.ratio < 0.6) {
    return NextResponse.json(
      {
        error:
          "We stopped here because the fields missed too much of your uploaded resume. " +
          "Nothing was saved or built; please retry in a minute or upload the original file again.",
        code: "extraction_incomplete",
      },
      { status: 422 },
    );
  }

  try {
    await prisma.resume.update({
      where: { id: resume.id },
      data: { structJson: toJsonColumn(struct) },
    });
  } catch (e) {
    // The extraction succeeded; only the cache write failed. The user gets
    // their fields and pays once more next time rather than losing the work.
    console.error("[struct] cache write failed:", e);
  }

  await audit(auth.user.id, "resume_struct_extracted", resume.id);
  return NextResponse.json({ ok: true, struct, cached: false });
}
