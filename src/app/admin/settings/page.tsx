"use client";

import { useEffect, useState } from "react";
import { PageTitle, Panel } from "../ui";

type Settings = {
  maintenanceMode: boolean;
  globalDailyCap: number;
  featureFlags: { googleAuth: boolean; smsOtp: boolean; autoApply: boolean };
  bannedDomains: string[];
};

export default function AdminSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");
  const [newDomain, setNewDomain] = useState("");

  useEffect(() => {
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

  if (err) return <p className="font-mono text-sm text-[#ff4d4d]">{err}</p>;
  if (!s) return <p className="font-mono text-sm text-[#8b919c]">Loading…</p>;

  return (
    <>
      <div className="mb-6 flex items-center gap-4">
        <PageTitle title="Admin settings" sub="Global controls — changes take effect immediately" />
        {saving && <span className="font-mono text-xs text-[#fbbd23]">Saving…</span>}
        {saved && <span className="font-mono text-xs text-[#36d399]">✓ Saved</span>}
      </div>

      <div className="flex flex-col gap-6 max-w-2xl">

        {/* Maintenance mode */}
        <Panel className="p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-mono text-sm font-bold text-[#e6e8eb]">Maintenance mode</div>
              <div className="mt-1 font-mono text-xs text-[#8b919c]">
                Blocks all new agent runs globally. Use before deploys or DB migrations.
              </div>
            </div>
            <Toggle value={s.maintenanceMode} onChange={() => toggle("maintenanceMode")} danger />
          </div>
          {s.maintenanceMode && (
            <div className="mt-3 rounded border border-[#ff4d4d]/30 bg-[#ff4d4d]/10 px-3 py-2 font-mono text-xs text-[#ff4d4d]">
              ⚠ Maintenance mode ON — agent runs are blocked for all users.
            </div>
          )}
        </Panel>

        {/* Global daily cap */}
        <Panel className="p-5">
          <div className="font-mono text-sm font-bold text-[#e6e8eb]">Global daily cap override</div>
          <div className="mt-1 font-mono text-xs text-[#8b919c]">
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
              className="w-28 rounded border border-[#262a33] bg-[#0b0c0f] px-3 py-2 font-mono text-sm text-[#e6e8eb] outline-none focus:border-[#ff4d4d]"
            />
            <span className="font-mono text-xs text-[#8b919c]">
              {s.globalDailyCap === 0 ? "no global cap" : `max ${s.globalDailyCap} apps / day total`}
            </span>
          </div>
        </Panel>

        {/* Feature flags */}
        <Panel className="p-5">
          <div className="font-mono text-sm font-bold text-[#e6e8eb] mb-4">Feature flags</div>
          <div className="space-y-4">
            <FlagRow
              label="Google OAuth"
              desc="Allow sign-in / sign-up via Google. Disable if OAuth credentials are revoked."
              value={s.featureFlags.googleAuth}
              onChange={() => toggleFlag("googleAuth")}
            />
            <FlagRow
              label="SMS OTP"
              desc="Require SMS OTP on login. Disable if Twilio is down or in dev mode."
              value={s.featureFlags.smsOtp}
              onChange={() => toggleFlag("smsOtp")}
            />
            <FlagRow
              label="Auto-apply"
              desc="Allow the agent to actually submit applications. Off = analyze-only mode."
              value={s.featureFlags.autoApply}
              onChange={() => toggleFlag("autoApply")}
            />
          </div>
        </Panel>

        {/* Banned domains */}
        <Panel className="p-5">
          <div className="font-mono text-sm font-bold text-[#e6e8eb]">Banned email domains</div>
          <div className="mt-1 font-mono text-xs text-[#8b919c]">
            Registrations from these domains are blocked at sign-up.
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {s.bannedDomains.map((d) => (
              <span key={d} className="flex items-center gap-1.5 rounded border border-[#262a33] bg-[#1d2027] px-2 py-1 font-mono text-xs">
                @{d}
                <button onClick={() => removeDomain(d)} className="text-[#ff4d4d] hover:opacity-80">×</button>
              </span>
            ))}
            {s.bannedDomains.length === 0 && <span className="font-mono text-xs text-[#5a606b]">None.</span>}
          </div>
          <div className="mt-3 flex gap-2">
            <input
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addDomain()}
              placeholder="example.com"
              className="rounded border border-[#262a33] bg-[#0b0c0f] px-3 py-1.5 font-mono text-sm text-[#e6e8eb] outline-none placeholder:text-[#5a606b] focus:border-[#ff4d4d]"
            />
            <button
              onClick={addDomain}
              className="rounded border border-[#262a33] px-3 py-1.5 font-mono text-sm text-[#e6e8eb] hover:bg-[#1d2027] transition"
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
        value ? (danger ? "bg-[#ff4d4d]" : "bg-[#36d399]") : "bg-[#262a33]"
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
        <div className="font-mono text-sm text-[#e6e8eb]">{label}</div>
        <div className="mt-0.5 font-mono text-xs text-[#8b919c]">{desc}</div>
      </div>
      <Toggle value={value} onChange={onChange} />
    </div>
  );
}
