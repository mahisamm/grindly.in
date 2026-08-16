import { NextResponse } from "next/server";
import { runAgent, type CompanyPack } from "@/lib/agent";

export const runtime = "nodejs";

/**
 * The curated company packs.
 *
 * Public — no session required. There is nothing user-specific here and the
 * landing page shows the list as evidence that the feature is real and that
 * every claim carries a link. Cached hard because the packs change when someone
 * edits `agent/companies.py`, which is a deploy, not a request.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  const result = await runAgent<{ packs: CompanyPack[]; disclaimer: string }>("companies", { q });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json(
    { ok: true, packs: result.packs, disclaimer: result.disclaimer },
    { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=3600" } },
  );
}
