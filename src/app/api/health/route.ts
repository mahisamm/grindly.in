import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { serviceStatus, missingProdConfig, encryptionKeyValid } from "@/lib/serverConfig";

/**
 * GET /api/health — readiness probe for deploys + manual checks.
 * `ok` is liveness (DB reachable + encryption key valid). `services` reports
 * which external integrations are wired, and `missing` lists required-for-prod
 * config that's absent — so you can see at a glance whether real users can
 * sign up. Never returns secret values.
 */
export async function GET() {
  const checks: Record<string, boolean> = {};
  checks.encryptionKey = encryptionKeyValid();

  try {
    await prisma.user.count();
    checks.database = true;
  } catch {
    checks.database = false;
  }

  const ok = checks.encryptionKey && checks.database;
  const missing = missingProdConfig();
  return NextResponse.json(
    { ok, checks, services: serviceStatus(), prodReady: ok && missing.length === 0, missing },
    { status: ok ? 200 : 503 }
  );
}
