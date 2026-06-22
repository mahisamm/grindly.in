import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";

// Download the EXACT resume that was sent for a given application — the
// call-prep answer to "which resume did they get?". Serves the stored PDF if it
// still exists on disk, else the snapshot text. Owner-only.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const uid = await getUid();
  if (!uid) return new Response("no session", { status: 401 });

  const app = await prisma.application.findFirst({
    where: { id, userId: uid },
    include: { resumeVersion: true },
  });
  if (!app || !app.resumeVersion) return new Response("not found", { status: 404 });

  const rv = app.resumeVersion;
  const dataDir = path.join(process.cwd(), "data");

  if (rv.filePath) {
    const abs = path.resolve(process.cwd(), rv.filePath);
    // path-traversal guard: only serve files under <project>/data
    if (abs.startsWith(dataDir) && fs.existsSync(abs)) {
      const buf = fs.readFileSync(abs);
      return new Response(new Uint8Array(buf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="resume-${id}.pdf"`,
        },
      });
    }
  }

  // Fallback: the immutable snapshot text.
  return new Response(rv.text, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
