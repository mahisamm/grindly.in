import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const SETTINGS_PATH = path.join(process.cwd(), "data", "admin-settings.json");

type Settings = {
  maintenanceMode: boolean;
  globalDailyCap: number;
  featureFlags: { googleAuth: boolean; smsOtp: boolean; autoApply: boolean };
  bannedDomains: string[];
};

function readSettings(): Settings {
  if (!existsSync(SETTINGS_PATH)) {
    return { maintenanceMode: false, globalDailyCap: 0, featureFlags: { googleAuth: true, smsOtp: true, autoApply: true }, bannedDomains: [] };
  }
  return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
}

function writeSettings(s: Settings): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), "utf-8");
}

export async function GET() {
  const g = await requireAdmin();
  if ("error" in g) return g.error;
  return NextResponse.json(readSettings());
}

export async function POST(req: Request) {
  const g = await requireAdmin();
  if ("error" in g) return g.error;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const current = readSettings();
  const updated: Settings = {
    maintenanceMode: typeof body.maintenanceMode === "boolean" ? body.maintenanceMode : current.maintenanceMode,
    globalDailyCap: typeof body.globalDailyCap === "number" && body.globalDailyCap >= 0 ? body.globalDailyCap : current.globalDailyCap,
    featureFlags: {
      googleAuth: typeof body.featureFlags?.googleAuth === "boolean" ? body.featureFlags.googleAuth : current.featureFlags.googleAuth,
      smsOtp: typeof body.featureFlags?.smsOtp === "boolean" ? body.featureFlags.smsOtp : current.featureFlags.smsOtp,
      autoApply: typeof body.featureFlags?.autoApply === "boolean" ? body.featureFlags.autoApply : current.featureFlags.autoApply,
    },
    bannedDomains: Array.isArray(body.bannedDomains)
      ? body.bannedDomains.filter((d: unknown) => typeof d === "string")
      : current.bannedDomains,
  };

  writeSettings(updated);
  return NextResponse.json({ ok: true, settings: updated });
}
