import { NextResponse } from "next/server";
import fsp from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { requireApprovedUser, notFound } from "@/lib/auth";
import { VARIANT_DIR } from "@/lib/agent";

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
      id: true, file: true, label: true, score: true,
      resumeId: true, resume: { select: { label: true } },
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

  const download = `${slug(variant.resume.label)}-${slug(variant.label)}.pdf`;
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.byteLength),
      // `inline` so the browser's PDF viewer opens it — the user wants to LOOK
      // at the rewrite before deciding, and forcing a download makes comparing
      // three variants a trip through the file manager.
      "Content-Disposition": `${req.headers.get("x-download") ? "attachment" : "inline"}; filename="${download}"`,
      "Cache-Control": "private, no-store",
      // No sniffing games. Framing policy is NOT set here — it is in
      // next.config.ts, which allows this one route to be framed by us and by
      // nobody (frame-ancestors 'self'), because the compare panel previews the
      // document beside the score it earned.
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function slug(value: string): string {
  return (value || "resume")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "resume";
}
