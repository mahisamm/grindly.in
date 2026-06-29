import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const integration = await prisma.userIntegration.findUnique({
    where: { userId_platform: { userId: uid, platform: "gmail" } },
    select: { status: true, connectedAt: true },
  });

  return NextResponse.json({
    connected: integration?.status === "connected",
    connectedAt: integration?.connectedAt ?? null,
  });
}

// DELETE = disconnect Gmail
export async function DELETE() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  await prisma.platformCredential.deleteMany({ where: { userId: uid, platform: "gmail" } });
  await prisma.userIntegration.updateMany({
    where: { userId: uid, platform: "gmail" },
    data: { status: "disconnected", connectedAt: null },
  });

  await audit("gmail_disconnect", { userId: uid });
  return NextResponse.json({ ok: true });
}
