// Global admin-controlled switches — read by the routes they actually gate,
// not just displayed in the admin UI. File-backed (single-instance-friendly;
// same seam as rateLimit.ts if this ever needs to move to the DB).

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import path from "path";

const SETTINGS_PATH = path.join(process.cwd(), "data", "admin-settings.json");

export type AdminSettings = {
  maintenanceMode: boolean;
  /** Pause NEW accounts only. Deliberately separate from `maintenanceMode`,
   *  which stops the worker claiming any job at all (see run_queue.claim_next)
   *  and would silently halt the whole product. This one turns the sign-up half
   *  of the Google flow into a "we're doing maintenance" page while everyone
   *  who already has an account keeps signing in normally. */
  signupMaintenance: boolean;
  globalDailyCap: number;
  openSignups: boolean;
  featureFlags: { googleAuth: boolean; autoApply: boolean };
  bannedDomains: string[];
};

const DEFAULTS: AdminSettings = {
  maintenanceMode: false,
  signupMaintenance: false,
  globalDailyCap: 0,
  // Approval-gated beta (the intended default): a new Google sign-in lands in
  // "pending" and sees the waitlist until an admin approves it — or its email is
  // on the allowlist. See src/lib/access.ts resolveInitialAccess. Flip to true
  // from /admin/settings to auto-approve every signup, no redeploy needed.
  openSignups: false,
  featureFlags: { googleAuth: true, autoApply: true },
  bannedDomains: [],
};

export function readAdminSettings(): AdminSettings {
  if (!existsSync(SETTINGS_PATH)) return DEFAULTS;
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    return {
      maintenanceMode: typeof parsed.maintenanceMode === "boolean" ? parsed.maintenanceMode : DEFAULTS.maintenanceMode,
      signupMaintenance: typeof parsed.signupMaintenance === "boolean" ? parsed.signupMaintenance : DEFAULTS.signupMaintenance,
      globalDailyCap: typeof parsed.globalDailyCap === "number" ? parsed.globalDailyCap : DEFAULTS.globalDailyCap,
      openSignups: typeof parsed.openSignups === "boolean" ? parsed.openSignups : DEFAULTS.openSignups,
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
  // Write to a temp file and rename. writeFileSync straight onto the live path
  // is not atomic: a crash or a full disk mid-write leaves truncated JSON, and
  // readAdminSettings() falls back to DEFAULTS on a parse error — which would
  // silently lift maintenance mode, re-open the signup gate and clear every
  // banned domain, with nothing to indicate it had happened. rename(2) is
  // atomic on the same filesystem, so a reader sees either the old file or the
  // complete new one.
  const tmp = `${SETTINGS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), "utf-8");
  renameSync(tmp, SETTINGS_PATH);
}

/** Normalize a domain the way both sides of the ban check must agree on. */
function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^@/, "").replace(/^www\./, "");
}

export function isEmailDomainBanned(email: string, settings?: AdminSettings): boolean {
  const domain = normalizeDomain(email.split("@")[1] ?? "");
  if (!domain) return false;
  // Normalize BOTH sides. The stored list is only type-filtered when written, so
  // an admin who typed "Gmail.com", " gmail.com" or "@gmail.com" got an entry
  // that rendered as active in the UI, echoed back on save, and blocked nobody —
  // a ban that silently did nothing.
  const list = (settings ?? readAdminSettings()).bannedDomains.map(normalizeDomain);
  return list.includes(domain);
}
