import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { hasAppAccess } from "@/lib/access";
import { audit } from "@/lib/audit";

/**
 * POST /api/access/request — a signed-in but not-yet-approved user taps
 * "Request access". Stamps accessRequestedAt so the admin queue can surface real
 * intent ahead of accounts that signed up and bounced. Idempotent: pressing it
 * again just refreshes nothing (we keep the first request time).
 */
export async function POST() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: { accessStatus: true, role: true, email: true, accessRequestedAt: true },
  });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Already in — nothing to request.
  if (hasAppAccess(user)) {
    return NextResponse.json({ ok: true, accessStatus: "approved" });
  }

  if (!user.accessRequestedAt) {
    await prisma.user.update({
      where: { id: uid },
      data: { accessRequestedAt: new Date() },
    });
    await audit("access_requested", { userId: uid, target: user.email });
  }

  return NextResponse.json({ ok: true, accessStatus: user.accessStatus });
}
