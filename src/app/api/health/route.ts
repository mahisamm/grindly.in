import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/health — cheap readiness probe for deploys + manual checks.
 * Verifies the DB is reachable and the encryption key is configured (without
 * ever returning the key). Does not spawn Python (keep it fast).
 */
export async function GET() {
  const checks: Record<string, boolean> = {};

  const key = process.env.APP_ENCRYPTION_KEY || "";
  checks.encryptionKey = /^[0-9a-fA-F]{64}$/.test(key);

  try {
    await prisma.user.count();
    checks.database = true;
  } catch {
    checks.database = false;
  }

  const ok = Object.values(checks).every(Boolean);
  return NextResponse.json({ ok, checks }, { status: ok ? 200 : 503 });
}
