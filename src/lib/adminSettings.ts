// Global admin-controlled switches — read by the routes they actually gate,
// not just displayed in the admin UI. File-backed (single-instance-friendly;
// same seam as rateLimit.ts if this ever needs to move to the DB).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";

const SETTINGS_PATH = path.join(process.cwd(), "data", "admin-settings.json");

export type AdminSettings = {
  maintenanceMode: boolean;
  globalDailyCap: number;
  featureFlags: { googleAuth: boolean; autoApply: boolean };
  bannedDomains: string[];
};

const DEFAULTS: AdminSettings = {
  maintenanceMode: false,
  globalDailyCap: 0,
  featureFlags: { googleAuth: true, autoApply: true },
  bannedDomains: [],
};

export function readAdminSettings(): AdminSettings {
  if (!existsSync(SETTINGS_PATH)) return DEFAULTS;
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    return {
      maintenanceMode: typeof parsed.maintenanceMode === "boolean" ? parsed.maintenanceMode : DEFAULTS.maintenanceMode,
      globalDailyCap: typeof parsed.globalDailyCap === "number" ? parsed.globalDailyCap : DEFAULTS.globalDailyCap,
      featureFlags: {
        googleAuth: typeof parsed.featureFlags?.googleAuth === "boolean" ? parsed.featureFlags.googleAuth : DEFAULTS.featureFlags.googleAuth,
        autoApply: typeof parsed.featureFlags?.autoApply === "boolean" ? parsed.featureFlags.autoApply : DEFAULTS.featureFlags.autoApply,
      },
      bannedDomains: Array.isArray(parsed.bannedDomains) ? parsed.bannedDomains.filter((d: unknown) => typeof d === "string") : DEFAULTS.bannedDomains,
    };
  } catch {
    return DEFAULTS;
  }
}

export function writeAdminSettings(s: AdminSettings): void {
  const dir = path.dirname(SETTINGS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), "utf-8");
}

export function isEmailDomainBanned(email: string, settings?: AdminSettings): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  const list = (settings ?? readAdminSettings()).bannedDomains;
  return list.includes(domain);
}
