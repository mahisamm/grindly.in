import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";

export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { id?: string };
  if (!body.id) return NextResponse.json({ error: "missing id" }, { status: 400 });

  const app = await prisma.application.findFirst({
    where: { id: body.id, userId: uid, status: "matched" },
  });
  if (!app) return NextResponse.json({ error: "not found or not in matched state" }, { status: 404 });

  await prisma.application.update({
    where: { id: body.id },
    data: {
      status: "approved",
      reason: (app.reason ?? "") + " — approved by you",
    },
  });

  return NextResponse.json({ ok: true });
}
