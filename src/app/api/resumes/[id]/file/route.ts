import { NextResponse } from "next/server";
import fsp from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { requireApprovedUser, notFound } from "@/lib/auth";
import { RESUME_DIR } from "@/lib/agent";
import { contentDisposition } from "@/lib/downloadName";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain; charset=utf-8",
};

/** Download or view the exact file the user originally uploaded. */
export async function GET(req: Request, { params }: Ctx) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const resume = await prisma.resume.findFirst({
    where: { id, userId: auth.user.id },
    select: { id: true, ext: true, originalName: true, label: true },
  });
  if (!resume || !resume.ext || !CONTENT_TYPES[resume.ext]) return notFound();

  let bytes: Buffer;
  try {
    // Both parts come from our database, but keeping the path construction
    // explicit makes this ownership-checked route safe if storage changes.
    bytes = await fsp.readFile(path.join(RESUME_DIR, `${resume.id}${resume.ext}`));
  } catch {
    return NextResponse.json(
      { error: "This uploaded file is no longer available. Your saved rebuilds are still in the library." },
      { status: 410 },
    );
  }

  const fallback = `${resume.label.trim() || "My-resume"}${resume.ext}`;
  const filename = path.basename(resume.originalName || fallback);
  const wantsDownload = new URL(req.url).searchParams.get("download") === "1";
  // PDFs can be viewed before saving. DOCX and text are downloads by nature.
  const disposition = wantsDownload || resume.ext !== ".pdf" ? "attachment" : "inline";

  await audit(auth.user.id, "resume_source_download", resume.id, resume.ext);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": CONTENT_TYPES[resume.ext],
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": contentDisposition(disposition, filename),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
