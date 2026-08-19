import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApprovedUser, notFound, badRequest, serverError } from "@/lib/auth";
import { runAgent } from "@/lib/agent";
import { readStruct } from "@/lib/resumeStruct";
import { safeEntryName } from "@/lib/zip";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The resume as .docx or as plain text.
 *
 * A PDF is the right thing to send a person and the wrong thing to paste into
 * a form. Two situations the PDF cannot help with, and both are ordinary:
 *
 *   * A large share of Indian portals, campus placement systems above all,
 *     accept DOC/DOCX and nothing else. The best-scoring PDF in the world does
 *     not get past "Upload your resume (DOC/DOCX only)".
 *   * Every application form has a box that wants the text, and pasting out of
 *     a PDF reader produces exactly the extraction artefacts this product
 *     exists to measure. We printed the document; we can hand over what we
 *     meant to say rather than what a reader recovered from a printed page.
 *
 * Built from the same structure the PDF is printed from, so there is one
 * document model and a change in the editor reaches every format at once.
 *
 * Not metered. It is a local render with no model call and no Chromium — a few
 * milliseconds of CPU — and charging for the format someone's college portal
 * happens to demand would be charging for their circumstances.
 */
export async function GET(req: Request, { params }: Ctx) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const format = (new URL(req.url).searchParams.get("format") ?? "docx").toLowerCase();
  if (format !== "docx" && format !== "txt") {
    return badRequest("Ask for format=docx or format=txt.");
  }

  const resume = await prisma.resume.findFirst({
    where: { id, userId: auth.user.id },
    select: { id: true, label: true, structJson: true, linkStyle: true },
  });
  if (!resume) return notFound();

  const struct = readStruct(resume.structJson);
  if (!struct) {
    // The structure is what every format is built from, and it only exists once
    // someone has opened the editor. Say which door to go through rather than
    // failing with "not found".
    return NextResponse.json(
      {
        error:
          "Open the editor once first — that is where we read your resume into the " +
          "fields these formats are built from.",
        code: "no_struct",
      },
      { status: 409 },
    );
  }

  const result = await runAgent<{
    format: string;
    text?: string;
    base64?: string;
    bytes?: number;
  }>("export", { struct: { ...struct, link_style: resume.linkStyle }, format });

  if (!result.ok) return serverError(result.error, `export:${resume.id}`);

  const stem = safeEntryName(resume.label, "resume");
  await audit(auth.user.id, "resume_export", resume.id, format);

  if (format === "txt") {
    return new NextResponse(result.text ?? "", {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${stem}.txt"`,
        "Cache-Control": "no-store, private",
      },
    });
  }

  const bytes = Buffer.from(result.base64 ?? "", "base64");
  if (!bytes.length) {
    return serverError("The document came back empty.", `export:${resume.id}`);
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${stem}.docx"`,
      "Content-Length": String(bytes.length),
      // Never cached: a resume is a document full of someone's personal details
      // and a shared machine is the normal case for this audience.
      "Cache-Control": "no-store, private",
    },
  });
}
