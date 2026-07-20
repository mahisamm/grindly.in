import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { readAdminSettings, writeAdminSettings, type AdminSettings } from "@/lib/adminSettings";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await requireAdmin();
  if ("error" in g) return g.error;
  return NextResponse.json(readAdminSettings());
}

export async function POST(req: Request) {
  const g = await requireAdmin();
  if ("error" in g) return g.error;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const current = readAdminSettings();
  const updated: AdminSettings = {
    maintenanceMode: typeof body.maintenanceMode === "boolean" ? body.maintenanceMode : current.maintenanceMode,
    globalDailyCap: typeof body.globalDailyCap === "number" && body.globalDailyCap >= 0 ? body.globalDailyCap : current.globalDailyCap,
    featureFlags: {
      googleAuth: typeof body.featureFlags?.googleAuth === "boolean" ? body.featureFlags.googleAuth : current.featureFlags.googleAuth,
      autoApply: typeof body.featureFlags?.autoApply === "boolean" ? body.featureFlags.autoApply : current.featureFlags.autoApply,
    },
    bannedDomains: Array.isArray(body.bannedDomains)
      ? body.bannedDomains.filter((d: unknown) => typeof d === "string")
      : current.bannedDomains,
  };

  writeAdminSettings(updated);
  return NextResponse.json({ ok: true, settings: updated });
}
