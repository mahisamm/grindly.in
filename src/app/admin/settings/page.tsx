"use client";

import { useEffect, useState } from "react";
import { PageTitle, Panel } from "../ui";

type Settings = {
  maintenanceMode: boolean;
  globalDailyCap: number;
  openSignups: boolean;
  featureFlags: { googleAuth: boolean; autoApply: boolean };
  bannedDomains: string[];
};

export default function AdminSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [emailOk, setEmailOk] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");
  const [newDomain, setNewDomain] = useState("");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.ok ? r.json() : Promise.reject(r))
      .then((j) => setEmailOk(j.services?.email ?? false))
      .catch(() => {});
    fetch("/api/admin/settings")
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then(setS)
      .catch(() => setErr("Failed to load settings."));
  }, []);

  async function save(patch: Partial<Settings>) {
    if (!s) return;
    setSaving(true);
    const updated = { ...s, ...patch };
    const res = await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });
    setSaving(false);
    if (res.ok) {
      const j = await res.json();
      setS(j.settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      setErr("Save failed.");
    }
  }

  function toggle(key: keyof Settings) {
    if (!s) return;
    const val = s[key];
    if (typeof val === "boolean") save({ [key]: !val });
  }

  function toggleFlag(flag: keyof Settings["featureFlags"]) {
    if (!s) return;
    save({ featureFlags: { ...s.featureFlags, [flag]: !s.featureFlags[flag] } });
  }

  function addDomain() {
    if (!s || !newDomain.trim()) return;
    const d = newDomain.trim().toLowerCase().replace(/^@/, "");
    if (!s.bannedDomains.includes(d)) {
      save({ bannedDomains: [...s.bannedDomains, d] });
    }
    setNewDomain("");
  }

  function removeDomain(d: string) {
    if (!s) return;
    save({ bannedDomains: s.bannedDomains.filter((x) => x !== d) });
  }

  if (err) return <p className="font-sans text-sm text-brand">{err}</p>;
  if (!s) return <p className="font-sans text-sm text-muted">Loading…</p>;

  return (
    <>
      <div className="mb-6 flex items-center gap-4">
        <PageTitle title="Admin settings" sub="Global controls — changes take effect immediately" />
        {emailOk === false && (
          <div className="mt-4 flex items-start gap-3 rounded-lg border border-warn/40 bg-warn/10 p-4 text-sm">
            <span className="text-warn text-lg leading-none">!</span>
            <div>
              <div className="font-semibold text-warn">Email not configured</div>
              <div className="mt-1 text-muted">
                Password reset emails won&apos;t be delivered. Set{" "}
                <code className="text-foreground">EMAIL_SMTP_HOST</code>,{" "}
                <code className="text-foreground">EMAIL_SMTP_USER</code>, and{" "}
                <code className="text-foreground">EMAIL_SMTP_PASS</code> in your environment to enable this.
              </div>
            </div>
          </div>
        )}
        {saving && <span className="font-sans text-xs text-warn">Saving…</span>}
        {saved && <span className="font-sans text-xs text-accent">✓ Saved</span>}
      </div>

      <div className="flex flex-col gap-6 max-w-2xl">

        {/* Maintenance mode */}
        <Panel className="p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-sans text-sm font-bold text-foreground">Maintenance mode</div>
              <div className="mt-1 font-sans text-xs text-muted">
                Blocks all new agent runs globally. Use before deploys or DB migrations.
              </div>
            </div>
            <Toggle value={s.maintenanceMode} onChange={() => toggle("maintenanceMode")} danger />
          </div>
          {s.maintenanceMode && (
            <div className="mt-3 rounded border border-brand/30 bg-brand/10 px-3 py-2 font-sans text-xs text-brand">
              ⚠ Maintenance mode ON — agent runs are blocked for all users.
            </div>
          )}
        </Panel>

        {/* Open signups */}
        <Panel className="p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-sans text-sm font-bold text-foreground">Open signups</div>
              <div className="mt-1 font-sans text-xs text-muted">
                Every Google sign-in is auto-approved. Turn off to go back to the request queue at /admin/access.
              </div>
            </div>
            <Toggle value={s.openSignups} onChange={() => toggle("openSignups")} />
          </div>
          {!s.openSignups && (
            <div className="mt-3 rounded border border-warn/30 bg-warn/10 px-3 py-2 font-sans text-xs text-warn">
              Signups are queued — new accounts wait for approval at /admin/access.
            </div>
          )}
        </Panel>

        {/* Global daily cap */}
        <Panel className="p-5">
          <div className="font-sans text-sm font-bold text-foreground">Global daily cap override</div>
          <div className="mt-1 font-sans text-xs text-muted">
            Hard ceiling on total applications per day across all users. 0 = no global limit (use per-user plan caps).
          </div>
          <div className="mt-4 flex items-center gap-3">
            <input
              type="number"
              min={0}
              max={10000}
              value={s.globalDailyCap}
              onChange={(e) => setS({ ...s, globalDailyCap: Number(e.target.value) })}
              onBlur={() => save({ globalDailyCap: s.globalDailyCap })}
              className="w-28 rounded border border-border bg-background px-3 py-2 font-sans text-sm text-foreground outline-none focus:border-brand"
            />
            <span className="font-sans text-xs text-muted">
              {s.globalDailyCap === 0 ? "no global cap" : `max ${s.globalDailyCap} apps / day total`}
            </span>
          </div>
        </Panel>

        {/* Feature flags */}
        <Panel className="p-5">
          <div className="font-sans text-sm font-bold text-foreground mb-4">Feature flags</div>
          <div className="space-y-4">
            <FlagRow
              label="Google OAuth"
              desc="Allow sign-in / sign-up via Google. Disable if OAuth credentials are revoked."
              value={s.featureFlags.googleAuth}
              onChange={() => toggleFlag("googleAuth")}
            />
            <FlagRow
              label="Auto-apply"
              desc="Allow the agent to prepare applications. Final submission always remains user-controlled."
              value={s.featureFlags.autoApply}
              onChange={() => toggleFlag("autoApply")}
            />
          </div>
        </Panel>

        {/* Banned domains */}
        <Panel className="p-5">
          <div className="font-sans text-sm font-bold text-foreground">Banned email domains</div>
          <div className="mt-1 font-sans text-xs text-muted">
            Registrations from these domains are blocked at sign-up.
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {s.bannedDomains.map((d) => (
              <span key={d} className="flex items-center gap-1.5 rounded border border-border bg-surface-2 px-2 py-1 font-sans text-xs">
                @{d}
                <button onClick={() => removeDomain(d)} className="text-brand hover:opacity-80">×</button>
              </span>
            ))}
            {s.bannedDomains.length === 0 && <span className="font-sans text-xs text-muted">None.</span>}
          </div>
          <div className="mt-3 flex gap-2">
            <input
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addDomain()}
              placeholder="example.com"
              className="rounded border border-border bg-background px-3 py-1.5 font-sans text-sm text-foreground outline-none placeholder:text-muted focus:border-brand"
            />
            <button
              onClick={addDomain}
              className="rounded border border-border px-3 py-1.5 font-sans text-sm text-foreground hover:bg-surface-2 transition"
            >
              Add
            </button>
          </div>
        </Panel>
      </div>
    </>
  );
}

function Toggle({ value, onChange, danger }: { value: boolean; onChange: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onChange}
      className={`relative h-7 w-12 rounded-full transition-colors ${
        value ? (danger ? "bg-brand" : "bg-accent") : "bg-border"
      }`}
    >
      <span className={`absolute top-1 size-5 rounded-full bg-white transition-all ${value ? "left-6" : "left-1"}`} />
    </button>
  );
}

function FlagRow({ label, desc, value, onChange }: { label: string; desc: string; value: boolean; onChange: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="font-sans text-sm text-foreground">{label}</div>
        <div className="mt-0.5 font-sans text-xs text-muted">{desc}</div>
      </div>
      <Toggle value={value} onChange={onChange} />
    </div>
  );
}
