/**
 * The two switches an operator needs at 2am, read from disk rather than the
 * database.
 *
 * File-backed rather than a table for the same reason `rateLimit.ts` isn't:
 * this deployment is single-instance (see the VPS deploy notes), and a flat
 * file means flipping "stop taking new signups" cannot itself fail because
 * the database is the thing having a bad night. Same seam as before — move it
 * to the DB the day this runs on more than one instance.
 *
 * A prior version of this file (before the resume-readiness pivot) also had
 * `maintenanceMode`, `openSignups`, `featureFlags` and `bannedDomains`. Cut
 * because they answered questions this product no longer asks: there is no
 * agent-run queue to halt, access is already a manual approve/block queue
 * (see access.ts... no — see api/admin/access), and nobody has asked for a
 * domain ban since. `rebuildsPaused` and `signupsPaused` are the two that
 * still map onto something real: a variant batch that runs Chromium on a
 * one-vCPU box, and a signup path that creates a database row.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import path from "path";
import { DATA_DIR } from "./agent";

const SETTINGS_PATH = path.join(DATA_DIR, "admin-settings.json");

export type AdminSettings = {
  /** New accounts (password or Google) are refused with a plain message.
   *  Existing accounts sign in exactly as before. The owner email (ADMIN_EMAIL)
   *  is always exempt — with no second way in, pausing signups while the
   *  owner's row happens not to exist would lock them out of the one console
   *  that turns this back off. */
  signupsPaused: boolean;
  /** No new rebuild (POST .../variants) is accepted while this is on. Applies
   *  to every account, including admin — this is for a deploy or a migration,
   *  where "except the operator" would defeat the point. */
  rebuildsPaused: boolean;
  updatedAt: string | null;
};

const DEFAULTS: AdminSettings = {
  signupsPaused: false,
  rebuildsPaused: false,
  updatedAt: null,
};

export function readAdminSettings(): AdminSettings {
  if (!existsSync(SETTINGS_PATH)) return DEFAULTS;
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    return {
      signupsPaused: typeof parsed.signupsPaused === "boolean" ? parsed.signupsPaused : DEFAULTS.signupsPaused,
      rebuildsPaused: typeof parsed.rebuildsPaused === "boolean" ? parsed.rebuildsPaused : DEFAULTS.rebuildsPaused,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    // A corrupt file falls back to everything OFF. The alternative — everything
    // ON — would mean a truncated write silently locks out every new signup.
    return DEFAULTS;
  }
}

/**
 * Write to a temp file and rename. A crash or a full disk mid-write must
 * leave the OLD file readable rather than a half-written one that parses as
 * garbage and silently resets both switches to off.
 */
export function writeAdminSettings(patch: Partial<Omit<AdminSettings, "updatedAt">>): AdminSettings {
  const current = readAdminSettings();
  const updated: AdminSettings = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${SETTINGS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(updated, null, 2), "utf-8");
  renameSync(tmp, SETTINGS_PATH);
  return updated;
}
