"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";

// @novnc/novnc reads `window` at module scope, so it can only be loaded in the
// browser — a static import fails this page's prerender outright.
const ConnectViewer = dynamic(() => import("@/components/ConnectViewer"), { ssr: false });

/**
 * Integrations — connected platforms, updates channel, paired browser
 * extensions.
 *
 * Lifted out of the dashboard, where it used to be a tab. It is settings, not
 * work: a user connects Internshala once and then essentially never returns,
 * while the tab sat permanently beside Applications competing with the thing
 * they actually came for. Setup connects Internshala now, and this is where
 * anything gets changed afterwards.
 *
 * Self-contained on purpose — it owns its own fetches, so the page around it is
 * just a heading and a way back.
 */

type Integration = {
  platform: string;
  status: string;
  connectedAt: string | null;
  connectToken: string | null;
  lastError?: string | null;
};

type Me = {
  user: {
    name: string | null;
    email: string;
    slackConnected: boolean;
    slackUserId: string | null;
    gmailConnected?: boolean;
    gmailScanBeta?: boolean;
  };
  quota: { cap: number; remaining: number };
};

const PLATFORM_META: Record<string, { label: string; color: string; icon: string }> = {
  internshala: { label: "Internshala", color: "text-[#00aaff]", icon: "IS" },
};

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export default function IntegrationsPanel() {
  const [me, setMe] = useState<Me | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [notice, setNotice] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);
  const [connectingPlatform, setConnectingPlatform] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ platform: string; token: string } | null>(null);
  const [slackIdDraft, setSlackIdDraft] = useState("");
  const [slackBusy, setSlackBusy] = useState(false);
  const [slackSetupOpen, setSlackSetupOpen] = useState(false);
  const [extTokens, setExtTokens] = useState<{ id: string; label: string; createdAt: string; lastUsedAt: string | null }[]>([]);
  const [extBusy, setExtBusy] = useState<string | null>(null);
  const [extInstalled, setExtInstalled] = useState(false);
  const [loading, setLoading] = useState(true);
  // Read inside the poll loop, so it has to be a ref: state captured in the
  // closure would still be false on every tick after the user hits Cancel.
  const connectAbort = useRef(false);

  const load = useCallback(async () => {
    const [meRes, intRes] = await Promise.all([
      fetch("/api/me").catch(() => null),
      fetch("/api/integrations").catch(() => null),
    ]);
    if (meRes && !meRes.ok) {
      window.location.href = "/login";
      return;
    }
    if (meRes?.ok) setMe(await meRes.json().catch(() => null));
    if (intRes?.ok) {
      const data = await intRes.json().catch(() => ({}));
      setIntegrations(data.integrations ?? []);
    }
    setLoading(false);
  }, []);

  // Fetch on mount. The lint rule is about render-time state writes; this is an
  // async load whose result lands after the request returns.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const loadExtTokens = useCallback(async () => {
    const res = await fetch("/api/extension/pair").catch(() => null);
    if (res?.ok) {
      const data = await res.json().catch(() => ({}));
      setExtTokens(data.tokens || []);
    }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadExtTokens(); }, [loadExtTokens]);

  // The extension's content script stamps this attribute on <html>; it can
  // attach just after mount, so re-check once.
  useEffect(() => {
    const check = () => setExtInstalled(!!document.documentElement.getAttribute("data-grindly-extension"));
    check();
    const t = setTimeout(check, 800);
    return () => clearTimeout(t);
  }, []);

  // Success toasts are confirmations, not standing banners.
  useEffect(() => {
    if (notice?.kind !== "ok") return;
    const t = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  async function connectPlatform(platform: string) {
    connectAbort.current = false;
    setConnectingPlatform(platform);
    setNotice({ kind: "info", text: "Preparing your secure login window…" });
    let res: Response;
    try {
      res = await fetch("/api/integrations/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform }),
      });
    } catch {
      setNotice({ kind: "err", text: "Network error — check your connection and try again." });
      setConnectingPlatform(null);
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setNotice({ kind: "err", text: data.error || "Couldn't open the login browser." });
      setConnectingPlatform(null);
      return;
    }
    // Sit past the connect service's own 420s session window, so this never
    // calls failure while the user is still fetching a verification code.
    // Event-driven polling state, not render output.
    // eslint-disable-next-line react-hooks/purity
    const deadline = Date.now() + 450_000;
    const poll = async () => {
      if (connectAbort.current) return;
      if (Date.now() > deadline) {
        setConnectingPlatform(null);
        setViewer(null);
        setNotice({ kind: "err", text: "Login window didn't open in time — please try Connect again." });
        return;
      }
      const r = await fetch("/api/integrations").catch(() => null);
      if (connectAbort.current) return;
      if (r?.ok) {
        const d = await r.json().catch(() => ({}));
        const row = (d.integrations as Integration[] ?? []).find((i) => i.platform === platform);
        if (row?.status === "connected") {
          setConnectingPlatform(null);
          setViewer(null);
          setNotice({ kind: "ok", text: `${PLATFORM_META[platform]?.label ?? platform} connected.` });
          void load();
          return;
        }
        if (row?.connectToken) {
          setNotice(null);
          const tok = row.connectToken;
          // Identity-stable: a fresh object every 2s re-renders the live canvas
          // underneath the user, which reads as the login window flickering.
          setViewer((prev) => (prev && prev.token === tok && prev.platform === platform ? prev : { platform, token: tok }));
        } else if (row?.status !== "connecting") {
          setConnectingPlatform(null);
          setViewer(null);
          return;
        }
      }
      setTimeout(poll, 2000);
    };
    setTimeout(poll, 2000);
  }

  function cancelConnect(platform: string) {
    connectAbort.current = true;
    setViewer(null);
    setConnectingPlatform(null);
    void fetch("/api/integrations/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform }),
    }).catch(() => {}).finally(() => void load());
  }

  async function disconnectPlatform(platform: string) {
    await fetch("/api/integrations/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform }),
    }).catch(() => {});
    void load();
  }

  async function connectSlack() {
    const id = slackIdDraft.trim();
    if (!id) return;
    setSlackBusy(true);
    setNotice(null);
    const res = await fetch("/api/slack/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slackUserId: id }),
    });
    setSlackBusy(false);
    if (!res.ok) { setNotice({ kind: "err", text: "Couldn't save Slack ID. Use your member ID (U…)." }); return; }
    setSlackIdDraft("");
    setNotice({ kind: "ok", text: "Slack connected. Hit 'Send test' to confirm it lands." });
    void load();
  }

  async function testSlack() {
    setSlackBusy(true);
    setNotice(null);
    const res = await fetch("/api/slack/test", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setSlackBusy(false);
    if (!res.ok) { setNotice({ kind: "err", text: data.error || "Test failed." }); return; }
    setNotice(data.stub
      ? { kind: "info", text: "Sent to local outbox (stub). Set SLACK_BOT_TOKEN in .env for real Slack DMs." }
      : { kind: "ok", text: "Test message sent — check your Slack DMs." });
  }

  async function disconnectSlack() {
    setSlackBusy(true);
    await fetch("/api/slack/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slackUserId: "", disconnect: true }),
    }).catch(() => {});
    setSlackBusy(false);
    void load();
  }

  async function revokeExtToken(id?: string, all?: boolean) {
    setExtBusy(all ? "all" : id || null);
    await fetch("/api/extension/pair", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(all ? { all: true } : { id }),
    }).catch(() => {});
    setExtBusy(null);
    void loadExtTokens();
  }

  if (loading || !me) {
    return <div className="py-16 text-center text-sm text-muted">Loading integrations…</div>;
  }

  const cap = me.quota?.cap ?? 0;

  return (
    <>
      {viewer && (
        <ConnectViewer
          platform={viewer.platform}
          token={viewer.token}
          onClose={() => cancelConnect(viewer.platform)}
        />
      )}
      {notice && (
        <div
          className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
            notice.kind === "ok" ? "border-accent/40 bg-accent/10 text-accent"
            : notice.kind === "err" ? "border-danger/40 bg-danger/10 text-danger"
            : "border-border bg-surface-2 text-muted"
          }`}
        >
          {notice.text}
        </div>
      )}
        <div className="mt-4">
          <div className="mb-4 rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm">
            <p className="font-medium">Connect one or more job platforms.</p>
            <p className="mt-1 text-muted">
              You log in on the <span className="text-foreground">real platform</span> inside a
              secure window here — <span className="text-foreground">Grindly never sees, types, or stores your password</span>.
              It stays signed in so the agent can find and prepare matches for you.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {integrations.map((integration) => {
              const meta = PLATFORM_META[integration.platform];
              const isConnected = integration.status === "connected";
              const isConnecting = integration.status === "connecting" || connectingPlatform === integration.platform;
              const isPaused = integration.status === "challenge_detected";
              return (
                <div key={integration.platform} className={`rounded-xl border p-4 transition ${
                  isConnected ? "border-accent/40 bg-accent/5" : "border-border bg-surface"
                }`}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-bold rounded-md px-1.5 py-0.5 border border-current ${meta.color}`}>{meta.icon}</span>
                      <span className="font-medium">{meta.label}</span>
                    </div>
                    <span className={`text-xs rounded-full px-2 py-0.5 ${
                      isConnected ? "bg-accent/20 text-accent"
                      : isConnecting ? "bg-brand/20 text-brand-2"
                      : isPaused ? "bg-warn/20 text-warn"
                      : "bg-surface-2 text-muted"
                    }`}>
                      {isConnected ? "Connected" : isConnecting ? "Connecting…" : isPaused ? "Paused" : "Not connected"}
                    </span>
                  </div>

                  {integration.lastError && !isConnected && (
                    <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                      {integration.lastError}
                    </div>
                  )}

                  {isConnected ? (
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs text-muted">Session ready for supported easy-apply jobs.</span>
                      <button onClick={() => disconnectPlatform(integration.platform)} className="text-xs text-muted hover:text-danger transition">Disconnect</button>
                    </div>
                  ) : isConnecting ? (
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs text-brand-2">Opening your secure login window…</span>
                      <button onClick={() => disconnectPlatform(integration.platform)} className="text-xs text-muted hover:text-danger transition">Cancel</button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-xs text-muted">
                        Log in yourself and handle any OTP or CAPTCHA normally. Grindly stores only the resulting browser session.
                      </p>
                      <button
                        onClick={() => connectPlatform(integration.platform)}
                        disabled={connectingPlatform !== null}
                        className="w-full press rounded-lg brand-gradient px-3 py-2 text-sm font-medium text-white hover:opacity-90 transition disabled:opacity-50"
                      >
                        Connect {meta.label}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Updates channel. Email + the in-app 🔔 bell are the defaults everyone
              gets with zero setup, so Slack is a tucked-away opt-in rather than an
              always-open form — most students never want it. */}
          <div className="mt-5 rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-base" aria-hidden>🔔</span>
                <span className="font-medium">Updates</span>
              </div>
              {me.user.slackConnected && (
                <span className="text-xs rounded-full px-2 py-0.5 bg-accent/20 text-accent">Slack on</span>
              )}
            </div>
            <p className="text-xs text-muted mb-3">
              Every update reaches you by <span className="text-foreground">email</span> and in the{" "}
              <span className="text-foreground">🔔 bell</span> above — nothing to set up.
            </p>
            {me.user.slackConnected ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted">Also DMing Slack <span className="text-foreground font-mono">{me.user.slackUserId}</span></span>
                <button onClick={testSlack} disabled={slackBusy} className="rounded-lg border border-border px-3 py-1.5 text-xs hover:border-brand/60 transition disabled:opacity-50">Send test</button>
                <button onClick={disconnectSlack} disabled={slackBusy} className="text-xs text-muted hover:text-danger transition">Disconnect</button>
              </div>
            ) : slackSetupOpen ? (
              <div>
                <p className="text-xs text-muted mb-2">
                  Paste your Slack member ID (Slack → your profile → ⋮ → Copy member ID).
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={slackIdDraft}
                    onChange={(e) => setSlackIdDraft(e.target.value)}
                    placeholder="U0XXXXXXX"
                    className="rounded-lg border border-border bg-surface px-3 py-2 text-sm w-44 outline-none font-mono"
                  />
                  <button onClick={connectSlack} disabled={slackBusy || !slackIdDraft.trim()} className="press rounded-lg brand-gradient px-3 py-2 text-sm font-medium text-white hover:opacity-90 transition disabled:opacity-50">
                    {slackBusy ? "…" : "Connect Slack"}
                  </button>
                  <button onClick={() => setSlackSetupOpen(false)} className="text-xs text-muted hover:text-foreground transition">Cancel</button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setSlackSetupOpen(true)}
                className="text-xs text-brand-2 hover:text-brand transition"
              >
                Want Slack DMs too? Set up Slack →
              </button>
            )}
          </div>

          {/* Browser extension — paired devices. The extension itself is
              connected from /extension/connect (needs the extension installed);
              this box is purely for reviewing/revoking what's already paired. */}
          <div className="mt-5 rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold rounded-md px-1.5 py-0.5 border border-current text-brand-2">Ext</span>
                <span className="font-medium">How you apply — your choice</span>
              </div>
              <span className={`text-xs rounded-full px-2 py-0.5 ${extTokens.length ? "bg-accent/20 text-accent" : "bg-surface-2 text-muted"}`}>
                {extTokens.length ? `${extTokens.length} paired` : "Optional"}
              </span>
            </div>
            <p className="text-xs text-muted mb-2">
              The agent finds, scores, and preps every match either way. The only choice is who fills the form:
            </p>
            <ul className="text-xs text-muted mb-3 space-y-1.5">
              <li>• <span className="text-foreground font-medium">Less manual (browser extension)</span> <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">coming soon</span> — it&apos;ll auto-fill the whole form in your own browser from your Apply Kit. Normal mode leaves final submit to you; any Autopilot beta requires separate opt-in and stops when it needs your input.</li>
              <li>• <span className="text-foreground font-medium">Do it yourself</span> — open the listing and fill it in by hand using the cover letter and answers Grindly already prepared. Nothing to install.</li>
            </ul>
            {extInstalled ? (
              <p className="text-xs text-muted mb-3">
                <Link href="/extension/connect" className="text-brand-2 underline">Connect / manage the extension →</Link>
              </p>
            ) : (
              <p className="text-xs text-muted mb-3">
                The browser extension is <span className="text-foreground">coming soon</span> — for now use
                “Do it yourself”. We&apos;ll let you know the moment it&apos;s ready.
              </p>
            )}
            {extTokens.length > 0 && (
              <div className="space-y-2">
                {extTokens.map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs">
                    <div className="min-w-0">
                      <div className="truncate text-foreground">{t.label}</div>
                      <div className="text-muted">
                        Paired {fmtRelative(t.createdAt)}
                        {t.lastUsedAt && <> · last used {fmtRelative(t.lastUsedAt)}</>}
                      </div>
                    </div>
                    <button
                      onClick={() => revokeExtToken(t.id)}
                      disabled={extBusy === t.id || extBusy === "all"}
                      className="shrink-0 text-muted hover:text-danger transition disabled:opacity-50"
                    >
                      {extBusy === t.id ? "…" : "Revoke"}
                    </button>
                  </div>
                ))}
                {extTokens.length > 1 && (
                  <button
                    onClick={() => revokeExtToken(undefined, true)}
                    disabled={extBusy === "all"}
                    className="text-xs text-muted hover:text-danger transition disabled:opacity-50"
                  >
                    {extBusy === "all" ? "Revoking…" : "Revoke all"}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* This was a whole apparatus for automatic inbox detection: a Gmail
              OAuth button, a "Scan now", a waitlist. All of it sat behind
              GMAIL_SCAN_ENABLED, which has never been set on any deploy and
              cannot be until gmail.readonly clears Google's restricted-scope
              review — a review nobody is pursuing. So the largest card on this
              page described a feature that could not be switched on.

              What survives is the part that works and that the user actually
              needs told: recruiter replies land in their inbox, not ours, so
              outcomes get marked by hand. One tap, on the application itself. */}
          <div className="mt-5 rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-base">📧</span>
              <span className="font-medium">When a company replies</span>
            </div>
            <p className="text-xs text-muted">
              The reply goes to your own inbox — Grindly never reads it. Mark the outcome on that
              application in one tap and your interview rate stays accurate.
            </p>
          </div>

          {/* Six steps became four, and the contradiction went with them: the
              old list said "Grindly never logs in and submits on your behalf"
              one line after describing what it does submit. Two paths, named
              plainly, is the whole model a user needs. */}
          <div className="mt-5 rounded-xl border border-border bg-surface p-4 text-sm text-muted">
            <p className="font-medium text-foreground mb-1">How applications work</p>
            <ol className="list-decimal pl-5 space-y-1.5 text-sm">
              <li>The agent runs every day on its own and scores each listing against your resume. <strong>Run now</strong> just starts one extra search.</li>
              <li>
                <strong className="text-foreground">If the application goes to the company directly</strong> — their own form or hiring inbox — the agent fills it in, attaches your tailored resume and sends it. Those show as <strong>Agent sent</strong>. Nothing needed from you.
              </li>
              <li>
                <strong className="text-foreground">If it lives on Internshala</strong> — the agent submits it from your connected account, so that one is hands-off too. Connect Internshala above to switch it on.
              </li>
              <li>
                <strong className="text-foreground">If a listing needs something only you can answer</strong> — a fact we don&apos;t hold, or a login we can&apos;t use — the agent prepares everything and hands it back rather than guessing.
              </li>
              <li>Come back and tap <strong>✓ I submitted it</strong> so your counts stay right — we&apos;ll ask automatically when you return to this tab.</li>
              <li>Up to <strong>{cap}</strong> applications a day on your plan. The agent never invents an answer about you; anything it can&apos;t answer honestly it hands back to you.</li>
            </ol>
          </div>

          {/* Account deletion moved to Profile ▸ Danger zone — account settings
              belong together, and it now runs through a typed-confirmation modal. */}
        </div>
    </>
  );
}
