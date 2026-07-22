import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * Waitlist opt-in for Gmail interview detection.
 *
 * The feature ships dark to the public while gmail.readonly clears Google
 * verification (see lib/googleOAuth.ts). Rather than dead-ending the "Let
 * Grindly watch" choice on a warning Google blocks, the card offers "Notify me
 * when it's ready" — this route records that intent so we can email the list the
 * day the scope is approved. Setting a boolean is idempotent: repeat taps are a
 * no-op, not a growing pile of rows.
 */
export async function POST() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  await prisma.user.update({ where: { id: uid }, data: { gmailScanInterest: true } });
  await audit("gmail_scan_interest", { userId: uid });

  return NextResponse.json({ ok: true });
}
