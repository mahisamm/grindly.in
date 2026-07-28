import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";

// Stream one ATS-optimized variant PDF for preview/download. Owner-only, and the
// stored path is re-validated to sit under <project>/data/resume_variants so a
// tampered DB row can never read an arbitrary file off the server.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const uid = await getUid();
  if (!uid) return new Response("no session", { status: 401 });

  const variant = await prisma.resumeVariant.findFirst({ where: { id, userId: uid } });
  if (!variant) return new Response("not found", { status: 404 });

  // Trailing separator on purpose: a bare prefix test also accepts a sibling
  // directory that merely starts with the same characters.
  const variantsDir = path.join(process.cwd(), "data", "resume_variants") + path.sep;
  const abs = path.resolve(/*turbopackIgnore: true*/ process.cwd(), variant.pdfPath);
  if (!abs.startsWith(variantsDir) || !fs.existsSync(abs)) {
    return new Response("file missing", { status: 404 });
  }

  const buf = fs.readFileSync(abs);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="grindly-optimized-${variant.rank}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
