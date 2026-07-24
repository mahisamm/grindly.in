import { NextResponse } from "next/server";
import { requireAdmin, adminAudit } from "@/lib/admin";
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
    signupMaintenance: typeof body.signupMaintenance === "boolean" ? body.signupMaintenance : current.signupMaintenance,
    globalDailyCap: typeof body.globalDailyCap === "number" && body.globalDailyCap >= 0 ? body.globalDailyCap : current.globalDailyCap,
    openSignups: typeof body.openSignups === "boolean" ? body.openSignups : current.openSignups,
    featureFlags: {
      googleAuth: typeof body.featureFlags?.googleAuth === "boolean" ? body.featureFlags.googleAuth : current.featureFlags.googleAuth,
      autoApply: typeof body.featureFlags?.autoApply === "boolean" ? body.featureFlags.autoApply : current.featureFlags.autoApply,
    },
    bannedDomains: Array.isArray(body.bannedDomains)
      ? body.bannedDomains.filter((d: unknown) => typeof d === "string")
      : current.bannedDomains,
  };

  writeAdminSettings(updated);

  // Audit it. This is the highest-blast-radius mutation an admin can make —
  // re-opening signups, lifting maintenance mode, disabling auto-apply for the
  // whole fleet — and it was the one admin route with no adminAudit call, so
  // those changes left no trace in /admin/audit at all. Records only what
  // actually changed, so the log reads as a history rather than a snapshot.
  const changes: string[] = [];
  const note = (k: string, before: unknown, after: unknown) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push(`${k}: ${before} -> ${after}`);
  };
  note("maintenanceMode", current.maintenanceMode, updated.maintenanceMode);
  note("signupMaintenance", current.signupMaintenance, updated.signupMaintenance);
  note("openSignups", current.openSignups, updated.openSignups);
  note("globalDailyCap", current.globalDailyCap, updated.globalDailyCap);
  note("featureFlags.googleAuth", current.featureFlags.googleAuth, updated.featureFlags.googleAuth);
  note("featureFlags.autoApply", current.featureFlags.autoApply, updated.featureFlags.autoApply);
  note("bannedDomains", current.bannedDomains, updated.bannedDomains);
  if (changes.length) {
    await adminAudit(g.admin, "settings_update", changes.join("; ").slice(0, 500));
  }

  return NextResponse.json({ ok: true, settings: updated });
}
