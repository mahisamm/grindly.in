import { NextResponse } from "next/server";
import fsp from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { requireApprovedUser, notFound } from "@/lib/auth";
import { VARIANT_DIR } from "@/lib/agent";
import { readContact } from "@/lib/reportTypes";
import { readStruct } from "@/lib/resumeStruct";
import { contentDisposition, resumeFileStem } from "@/lib/downloadName";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Download a rendered variant PDF.
 *
 * The file is served through this route rather than from a public directory,
 * because a resume is a document full of someone's personal details and a
 * predictable public URL is a directory of them. Every read is ownership-checked
 * against the session.
 */
export async function GET(req: Request, { params }: Ctx) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const variant = await prisma.variant.findFirst({
    where: { id, resume: { userId: auth.user.id } },
    select: {
      id: true, file: true, label: true, score: true, structJson: true,
      resumeId: true,
      // The target is what makes this document company-specific, and its name
      // is the first word of the filename.
      target: { select: { name: true } },
      // `targetName` on the resume: a document promoted from a company-tailored
      // rebuild carries its company forward, and a PDF built from its editor
      // has no target of its own — without this the company fell off the
      // filename exactly when the user was saving "the Amazon one".
      resume: { select: { label: true, contactJson: true, targetName: true } },
    },
  });
  if (!variant) return notFound();

  // `file` is written by us as "<runId>/variant-N.pdf", but it round-trips
  // through the database, so it is untrusted on the way back out. basename()
  // alone is no longer enough now that the value legitimately contains a
  // separator, so each segment is sanitised and the resolved path is then
  // checked to be inside the root — belt and braces, because a traversal here
  // reads arbitrary server files.
  const segments = variant.file.split(/[\\/]+/).map((s) => path.basename(s)).filter(Boolean);
  if (!segments.length) return notFound();

  const root = path.resolve(VARIANT_DIR);
  const full = path.resolve(path.join(VARIANT_DIR, variant.resumeId, ...segments));
  if (full !== root && !full.startsWith(root + path.sep)) return notFound();

  let bytes: Buffer;
  try {
    bytes = await fsp.readFile(full);
  } catch {
    return NextResponse.json(
      { error: "That file is no longer on the server. Re-run the rewrite to rebuild it." },
      { status: 410 },
    );
  }

  // The name printed ON the document, preferred over anything stored beside it:
  // this file is about to be opened by somebody who will read that header, and
  // a filename that disagrees with it looks like the wrong attachment. Falls
  // back to the contact block read off the original upload, then to the account
  // name, then to nothing — `resumeFileStem` handles the empty case.
  const printed = readStruct(variant.structJson)?.name;
  const person = printed || readContact(variant.resume.contactJson).name || auth.user.name;
  // Company first, from the target this rebuild was aimed at — or, for a
  // rebuild of a resume that was itself promoted from a company-tailored
  // version, from the company that resume still remembers.
  const company = variant.target?.name || variant.resume.targetName || null;
  const download = `${resumeFileStem(person, company)}.pdf`;
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.byteLength),
      // `inline` by default so the browser's PDF viewer opens it — the user
      // wants to LOOK at a rewrite before deciding, and forcing a download
      // makes comparing three of them a trip through the file manager.
      // `?download=1` is the explicit save.
      //
      // A query parameter and not a request header, which is what this used to
      // read. A header cannot be set on a plain link or on a <a download>, so
      // the attachment branch was unreachable from any page in this
      // application: every "download" in the product was in fact an inline
      // open, and the filename this route works to get right only ever appeared
      // if someone saved from inside the PDF viewer.
      "Content-Disposition": contentDisposition(
        new URL(req.url).searchParams.get("download") === "1" ? "attachment" : "inline",
        download,
      ),
      "Cache-Control": "private, no-store",
      // No sniffing games. Framing policy is NOT set here — it is in
      // next.config.ts, which allows this one route to be framed by us and by
      // nobody (frame-ancestors 'self'), because the compare panel previews the
      // document beside the score it earned.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
