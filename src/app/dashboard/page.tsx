"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/Brand";

type App = {
  id: string;
  jobTitle: string;
  company: string;
  url: string | null;
  matchScore: number;
  status: string;
  reason: string | null;
  appliedAt: string | null;
  createdAt: string;
};
type Report = {
  id: string;
  date: string;
  matchedCount: number;
  appliedCount: number;
  failedCount: number;
  summary: string;
};
type Integration = {
  platform: string;
  status: string; // connected | disconnected | connecting | needs_login
  connectedAt: string | null;
};
type Me = {
  user: {
    id: string;
    name: string | null;
    email: string;
    paid: boolean;
    plan: string;
    status: string;
    slackConnected: boolean;
    internshalaConnected: boolean;
  };
  profile: { skills: string; maxPerDay: number; minMatchScore: number; autoApply: boolean } | null;
  applications: App[];
  reports: Report[];
  stats: { matched: number; applied: number; skipped: number; failed: number; avgScore: number };
  integrations: Integration[];
};

const PLATFORM_META: Record<string, { label: string; color: string; icon: string }> = {
  linkedin: { label: "LinkedIn", color: "text-[#0077B5]", icon: "in" },
  internshala: { label: "Internshala", color: "text-[#00aaff]", icon: "IS" },
  naukri: { label: "Naukri", color: "text-[#f47c2d]", icon: "NK" },
  unstop: { label: "Unstop", color: "text-[#6C63FF]", icon: "UN" },
  indeed: { label: "Indeed", color: "text-[#2557A7]", icon: "ID" },
};

const STATUS_STYLE: Record<string, string> = {
  applied: "bg-accent/15 text-accent",
  matched: "bg-brand/15 text-brand-2",
  skipped: "bg-surface-2 text-muted",
  failed: "bg-danger/15 text-danger",
};

function scoreColor(s: number) {
  if (s >= 75) return "text-accent";
  if (s >= 55) return "text-brand-2";
  return "text-muted";
}

const PLAN_CAP: Record<string, number> = { starter: 10, pro: 30 };

export default function Dashboard() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<"applications" | "integrations" | "reports">("applications");
  const [filter, setFilter] = useState<string>("all");
  const [connectingPlatform, setConnectingPlatform] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/me");
    if (res.ok) setMe(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  async function togglePause() {
    if (!me) return;
    const action = me.user.status === "paused" ? "resume" : "pause";
    await fetch("/api/agent/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    load();
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login";
  }

  async function runAgent(mode: "mock" | "live") {
    setRunning(true);
    await fetch("/api/agent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    setTimeout(() => setRunning(false), 6000);
  }

  async function connectPlatform(platform: string) {
    setConnectingPlatform(platform);
    await fetch("/api/integrations/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform }),
    });
    // Browser opens for user to log in; poll will update status
    setTimeout(() => setConnectingPlatform(null), 10000);
  }

  async function disconnectPlatform(platform: string) {
    await fetch("/api/integrations/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform }),
    });
    load();
  }

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center text-muted">
        Loading dashboard…
      </main>
    );
  }

  if (!me) {
    return (
      <main className="grid-bg min-h-screen flex items-center justify-center px-5">
        <div className="glass rounded-2xl p-8 text-center max-w-sm glow">
          <Logo size={30} />
          <p className="mt-4 text-muted">Not logged in.</p>
          <div className="mt-5 flex justify-center gap-2">
            <Link
              href="/login"
              className="inline-block rounded-lg brand-gradient px-5 py-2.5 font-medium text-white"
            >
              Log in
            </Link>
            <Link
              href="/signup"
              className="inline-block rounded-lg border border-border px-5 py-2.5 font-medium hover:border-brand/60 transition"
            >
              Sign up
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const skills: string[] = me.profile ? JSON.parse(me.profile.skills || "[]") : [];
  const apps =
    filter === "all" ? me.applications : me.applications.filter((a) => a.status === filter);
  const integrations = me.integrations ?? [];
  const connectedCount = integrations.filter((i) => i.status === "connected").length;
  const cap = PLAN_CAP[me.user.plan] ?? 10;

  return (
    <main className="min-h-screen">
      {/* top bar */}
      <header className="sticky top-0 z-30 glass">
        <div className="mx-auto max-w-6xl px-5 h-16 flex items-center justify-between">
          <Link href="/">
            <Logo />
          </Link>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-sm">
              <span
                className={`size-2 rounded-full ${
                  me.user.status === "active"
                    ? "bg-accent pulse-dot"
                    : me.user.status === "paused"
                      ? "bg-warn"
                      : "bg-muted"
                }`}
              />
              {me.user.status === "active"
                ? "Agent active"
                : me.user.status === "paused"
                  ? "Paused"
                  : "Setup incomplete"}
            </span>
            {me.user.paid && (
              <button
                onClick={togglePause}
                className="text-sm text-muted hover:text-foreground transition"
              >
                {me.user.status === "paused" ? "Resume" : "Pause"}
              </button>
            )}
            <Link href="/onboarding" className="text-sm text-muted hover:text-foreground">
              Settings
            </Link>
            <button onClick={logout} className="text-sm text-muted hover:text-foreground transition">
              Log out
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 py-8">
        {/* header row */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Hi {me.user.name || me.user.email.split("@")[0]}
            </h1>
            <p className="text-muted text-sm mt-1">
              Plan:{" "}
              <span className="capitalize text-foreground font-medium">{me.user.plan}</span>
              {" "}· {cap}/day cap · firewall ≥{" "}
              {me.profile?.minMatchScore ?? 55} ·{" "}
              <span
                className={
                  connectedCount > 0 ? "text-accent" : "text-muted"
                }
              >
                {connectedCount} platform{connectedCount !== 1 ? "s" : ""} connected
              </span>
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => runAgent("mock")}
              disabled={running || !me.user.paid}
              title={!me.user.paid ? "Complete payment to run" : ""}
              className="rounded-lg brand-gradient px-4 py-2.5 text-sm font-medium text-white hover:opacity-90 transition disabled:opacity-50"
            >
              {running ? "Agent running…" : "Run demo"}
            </button>
            <button
              onClick={() => runAgent("live")}
              disabled={running || !me.user.paid || connectedCount === 0}
              title={connectedCount === 0 ? "Connect at least one platform first" : ""}
              className="rounded-lg border border-border px-4 py-2.5 text-sm hover:border-brand/60 transition disabled:opacity-50"
            >
              Run live
            </button>
          </div>
        </div>

        {/* banners */}
        {!me.user.paid && (
          <div className="mt-5 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
            Payment not complete — finish{" "}
            <Link href="/onboarding" className="underline">
              onboarding
            </Link>{" "}
            to activate the agent.
          </div>
        )}

        {me.user.paid && connectedCount === 0 && (
          <div className="mt-5 rounded-xl border border-brand/40 bg-brand/10 px-4 py-3 text-sm">
            <span className="font-medium">Connect at least one platform</span>{" "}
            <span className="text-muted">
              so the agent can apply for real. Demo mode works without connections.
            </span>{" "}
            <button
              onClick={() => setTab("integrations")}
              className="underline text-brand-2 ml-1"
            >
              Set up integrations →
            </button>
          </div>
        )}

        {/* reconnect warnings */}
        {me.user.paid &&
          integrations
            .filter((i) => i.status === "needs_login")
            .map((i) => (
              <div
                key={i.platform}
                className="mt-3 flex items-center justify-between rounded-xl border border-warn/40 bg-warn/10 px-4 py-2.5 text-sm text-warn"
              >
                <span>
                  {PLATFORM_META[i.platform]?.label ?? i.platform} session expired — reconnect to
                  resume live applications.
                </span>
                <button
                  onClick={() => connectPlatform(i.platform)}
                  className="ml-4 shrink-0 rounded-lg border border-warn/60 px-3 py-1 text-xs hover:bg-warn/20 transition"
                >
                  Reconnect
                </button>
              </div>
            ))}

        {/* stats */}
        <div className="mt-6 grid grid-cols-2 lg:grid-cols-5 gap-3">
          {[
            ["Matched", me.stats.matched, "text-foreground"],
            ["Applied", me.stats.applied, "text-accent"],
            ["Skipped", me.stats.skipped, "text-muted"],
            ["Failed", me.stats.failed, "text-danger"],
            ["Avg match", me.stats.avgScore, "text-brand-2"],
          ].map(([label, val, c]) => (
            <div key={label as string} className="rounded-xl border border-border bg-surface p-4">
              <div className={`text-3xl font-semibold ${c}`}>{val as number}</div>
              <div className="text-xs text-muted mt-1">{label as string}</div>
            </div>
          ))}
        </div>

        {/* skills */}
        {skills.length > 0 && (
          <div className="mt-6 rounded-xl border border-border bg-surface p-4">
            <div className="text-xs uppercase tracking-wide text-muted mb-2">
              Skills extracted from your resume
            </div>
            <div className="flex flex-wrap gap-2">
              {skills.map((s) => (
                <span key={s} className="rounded-md bg-brand/15 px-2 py-1 text-sm text-brand-2">
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* tabs */}
        <div className="mt-8 flex items-center gap-2 border-b border-border">
          {(["applications", "integrations", "reports"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm capitalize border-b-2 -mb-px transition ${
                tab === t
                  ? "border-brand text-foreground"
                  : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              {t}
              {t === "integrations" && connectedCount > 0 && (
                <span className="ml-1.5 rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] text-accent">
                  {connectedCount}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ── APPLICATIONS ── */}
        {tab === "applications" && (
          <div className="mt-4">
            <div className="flex gap-2 mb-3 text-sm">
              {["all", "applied", "matched", "skipped", "failed"].map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`rounded-md px-2.5 py-1 capitalize transition ${
                    filter === f ? "bg-surface-2 text-foreground" : "text-muted hover:text-foreground"
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>

            {apps.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-10 text-center text-muted">
                No applications yet. Hit{" "}
                <span className="text-foreground">Run demo</span> to watch it work.
              </div>
            ) : (
              <div className="space-y-2">
                {apps.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3 hover:border-brand/40 transition"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{a.jobTitle}</span>
                        {a.url && (
                          <a
                            href={a.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-brand-2 hover:underline shrink-0"
                          >
                            view ↗
                          </a>
                        )}
                      </div>
                      <div className="text-sm text-muted truncate">
                        {a.company}
                        {a.reason ? ` · ${a.reason}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-4 shrink-0">
                      <div className="text-right">
                        <div className={`font-mono text-lg ${scoreColor(a.matchScore)}`}>
                          {a.matchScore}
                        </div>
                        <div className="text-[10px] text-muted">match</div>
                      </div>
                      <span
                        className={`rounded-md px-2 py-1 text-xs ${
                          STATUS_STYLE[a.status] || "bg-surface-2 text-muted"
                        }`}
                      >
                        {a.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── INTEGRATIONS ── */}
        {tab === "integrations" && (
          <div className="mt-4">
            <p className="text-sm text-muted mb-4">
              Connect your accounts once. The agent reuses the session to apply on your behalf.
              Your credentials never leave your machine — we save a browser session cookie, not your password.
            </p>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {integrations.map((intg) => {
                const meta = PLATFORM_META[intg.platform] ?? {
                  label: intg.platform,
                  color: "text-foreground",
                  icon: intg.platform.slice(0, 2).toUpperCase(),
                };
                const isConnected = intg.status === "connected";
                const isConnecting =
                  connectingPlatform === intg.platform || intg.status === "connecting";
                const needsLogin = intg.status === "needs_login";

                return (
                  <div
                    key={intg.platform}
                    className={`rounded-xl border p-4 transition ${
                      isConnected
                        ? "border-accent/40 bg-accent/5"
                        : needsLogin
                          ? "border-warn/40 bg-warn/5"
                          : "border-border bg-surface"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-xs font-bold rounded-md px-1.5 py-0.5 border ${meta.color} border-current`}
                        >
                          {meta.icon}
                        </span>
                        <span className="font-medium">{meta.label}</span>
                      </div>
                      <span
                        className={`text-xs rounded-full px-2 py-0.5 ${
                          isConnected
                            ? "bg-accent/20 text-accent"
                            : needsLogin
                              ? "bg-warn/20 text-warn"
                              : isConnecting
                                ? "bg-brand/20 text-brand-2"
                                : "bg-surface-2 text-muted"
                        }`}
                      >
                        {isConnected
                          ? "Connected"
                          : needsLogin
                            ? "Needs login"
                            : isConnecting
                              ? "Connecting…"
                              : "Not connected"}
                      </span>
                    </div>

                    {isConnected ? (
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted">
                          Agent applies via this account
                        </span>
                        <button
                          onClick={() => disconnectPlatform(intg.platform)}
                          className="text-xs text-muted hover:text-danger transition"
                        >
                          Disconnect
                        </button>
                      </div>
                    ) : (
                      <div>
                        <p className="text-xs text-muted mb-3">
                          {needsLogin
                            ? "Session expired — log in again to resume."
                            : "A browser window will open. Log in once and close it."}
                        </p>
                        <button
                          onClick={() => connectPlatform(intg.platform)}
                          disabled={!me.user.paid || isConnecting}
                          className="w-full rounded-lg brand-gradient px-3 py-2 text-sm font-medium text-white hover:opacity-90 transition disabled:opacity-50"
                        >
                          {isConnecting
                            ? "Browser opening…"
                            : needsLogin
                              ? `Reconnect ${meta.label}`
                              : `Connect ${meta.label}`}
                        </button>
                        {!me.user.paid && (
                          <p className="mt-1.5 text-xs text-muted text-center">
                            Activate a plan first
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-5 rounded-xl border border-border bg-surface p-4 text-sm text-muted">
              <p className="font-medium text-foreground mb-1">How live applications work</p>
              <ol className="list-decimal pl-5 space-y-1 text-sm">
                <li>Click <strong>Connect</strong> — a real browser opens on your machine.</li>
                <li>Log into that platform normally (2FA is fine).</li>
                <li>Close the window when prompted — session cookie is saved locally.</li>
                <li>Click <strong>Run live</strong> on this dashboard to start applying.</li>
                <li>The agent applies up to <strong>{cap}</strong> internships/day across all connected platforms.</li>
              </ol>
            </div>
          </div>
        )}

        {/* ── REPORTS ── */}
        {tab === "reports" && (
          <div className="mt-4 space-y-3">
            {me.reports.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-10 text-center text-muted">
                No daily reports yet. They appear after each agent run.
              </div>
            ) : (
              me.reports.map((r) => (
                <div key={r.id} className="rounded-xl border border-border bg-surface p-4">
                  <div className="flex items-center justify-between">
                    <div className="font-medium">{r.date}</div>
                    <div className="text-sm text-muted">
                      <span className="text-accent">{r.appliedCount} applied</span> ·{" "}
                      {r.matchedCount} matched · {r.failedCount} failed
                    </div>
                  </div>
                  <p className="mt-2 text-sm text-muted whitespace-pre-line">{r.summary}</p>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </main>
  );
}
