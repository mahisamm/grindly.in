import { NextResponse } from "next/server";
import { getUid, clearUid, revokeSessions } from "@/lib/session";

export async function POST() {
  // Bump the user's token version so the cookie we're about to clear (and any
  // copy of it elsewhere) is rejected server-side from now on — logout that
  // actually revokes, not just a client-side cookie delete.
  const uid = await getUid();
  if (uid) await revokeSessions(uid);
  await clearUid();
  return NextResponse.json({ ok: true });
}
