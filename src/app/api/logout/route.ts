import { NextResponse } from "next/server";
import { clearUid } from "@/lib/session";

export async function POST() {
  await clearUid();
  return NextResponse.json({ ok: true });
}
