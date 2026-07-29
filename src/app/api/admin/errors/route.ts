import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/**
 * Crashes from the worker, the web and the browser, grouped by fingerprint.
 *
 * ?resolved=1 includes the ones already acknowledged; by default the page shows
 * only what is still open, because "what is broken right now" is the question
 * this exists to answer.
 */
export async function GET(req: Request) {
  const g = await requireAdmin();
  if ("error" in g) return g.error;

  const url = new URL(req.url);
  const includeResolved = url.searchParams.get("resolved") === "1";
  const source = (url.searchParams.get("source") ?? "").trim();

  const where: Record<string, unknown> = {};
  if (!includeResolved) where.resolvedAt = null;
  if (source) where.source = source;

  const [total, open, rows] = await Promise.all([
    prisma.errorEvent.count({ where }),
    prisma.errorEvent.count({ where: { resolvedAt: null } }),
    prisma.errorEvent.findMany({
      where,
      orderBy: { lastSeenAt: "desc" },
      take: PAGE_SIZE,
    }),
  ]);

  return NextResponse.json({ total, open, errors: rows });
}

/**
 * Acknowledge one. Not a delete: the row stays, and if the same fault happens
 * again the writer clears `resolvedAt`, which is what makes "new since I last
 * looked" mean something.
 */
export async function POST(req: Request) {
  const g = await requireAdmin();
  if ("error" in g) return g.error;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const fingerprint = String(body.fingerprint ?? "").trim();
  if (!fingerprint) {
    return NextResponse.json({ error: "no fingerprint" }, { status: 400 });
  }
  const resolved = body.resolved !== false;

  await prisma.errorEvent.update({
    where: { fingerprint },
    data: { resolvedAt: resolved ? new Date() : null },
  });
  return NextResponse.json({ ok: true });
}
