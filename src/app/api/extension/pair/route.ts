import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { issueToken } from "@/lib/extensionAuth";

// Extension pairing. Called from the grindly.in "Connect extension" page, which
// is authenticated the normal way (ip_uid cookie) — so this issues a bearer
// token bound to the logged-in user and hands the RAW value back exactly once.
// The connect page relays it to the extension; we never store or show it again.

export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { label } = (await req.json().catch(() => ({}))) as { label?: string };
  const token = await issueToken(uid, (label || "Browser extension").slice(0, 60));
  return NextResponse.json({ ok: true, token });
}

// List paired tokens (metadata only — never the raw token or its hash) so the
// dashboard can show "2 browsers paired" and offer per-row revoke.
export async function GET() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const tokens = await prisma.extensionToken
    .findMany({
      where: { userId: uid, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, label: true, createdAt: true, lastUsedAt: true },
    })
    .catch(() => []);
  return NextResponse.json({ tokens });
}

// Revoke one paired browser (or all, with { all: true }). Idempotent.
export async function DELETE(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { id, all } = (await req.json().catch(() => ({}))) as { id?: string; all?: boolean };
  if (all) {
    await prisma.extensionToken
      .updateMany({ where: { userId: uid, revokedAt: null }, data: { revokedAt: new Date() } })
      .catch(() => {});
    return NextResponse.json({ ok: true });
  }
  if (!id) return NextResponse.json({ error: "id or all required" }, { status: 400 });
  // Scope the update to this user so one user can't revoke another's token.
  await prisma.extensionToken
    .updateMany({ where: { id, userId: uid }, data: { revokedAt: new Date() } })
    .catch(() => {});
  return NextResponse.json({ ok: true });
}
