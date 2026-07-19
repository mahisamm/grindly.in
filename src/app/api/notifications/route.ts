import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * GET /api/notifications — the user's in-app feed: recent items + unread count.
 * Only the "inapp" channel is surfaced (slack/email rows are delivery logs, not
 * feed items). Cheap: single indexed query on [userId, createdAt], capped at 30.
 */
export async function GET() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const [items, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: uid, channel: "inapp" },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, tier: true, title: true, body: true, readAt: true, createdAt: true },
    }).catch(() => []),
    prisma.notification.count({ where: { userId: uid, channel: "inapp", readAt: null } }).catch(() => 0),
  ]);

  return NextResponse.json({
    unread,
    items: items.map((n) => ({ ...n, read: n.readAt !== null })),
  });
}

/**
 * POST /api/notifications — mark read. Body { all: true } clears everything;
 * { ids: [...] } marks a specific set. Scoped to the caller's own rows.
 */
export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { all?: boolean; ids?: string[] };
  const where =
    body.all === true
      ? { userId: uid, channel: "inapp", readAt: null }
      : Array.isArray(body.ids) && body.ids.length > 0
        ? { userId: uid, channel: "inapp", id: { in: body.ids.slice(0, 100) }, readAt: null }
        : null;

  if (!where) return NextResponse.json({ error: "nothing to mark" }, { status: 400 });

  const res = await prisma.notification.updateMany({ where, data: { readAt: new Date() } }).catch(() => ({ count: 0 }));
  return NextResponse.json({ ok: true, marked: res.count });
}
