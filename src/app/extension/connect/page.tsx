"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/Brand";

// "Connect extension" page. The user lands here (from the extension popup or the
// dashboard), we confirm they're logged in, mint an extension token via
// /api/extension/pair, and hand it to the installed extension by posting a window
// message its bridge content script picks up. If the extension isn't detected we
// fall back to a copyable token so pairing still works.

type Phase = "checking" | "need_login" | "ready" | "pairing" | "done" | "no_extension" | "error";

export default function ExtensionConnectPage() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [token, setToken] = useState("");
  const [extPresent, setExtPresent] = useState(false);

  // Are we logged in, and is the extension installed?
  useEffect(() => {
    let cancelled = false;
    const checkSession = () =>
      fetch("/api/me")
        .then((r) => {
          if (cancelled) return;
          // Only advance login→ready; never knock a mid-pairing/done state back.
          setPhase((p) => (p === "checking" || p === "need_login" ? (r.ok ? "ready" : "need_login") : p));
        })
        .catch(() => !cancelled && setPhase((p) => (p === "checking" ? "error" : p)));
    checkSession();
    // If they log in in another tab and come back, notice it without a manual reload.
    const onFocus = () => checkSession();
    window.addEventListener("focus", onFocus);

    // The bridge content script sets this attribute when the extension is present.
    // Wrapped in a named reader (not a bare setState in the effect body) — the
    // same external-DOM-sync pattern the dashboard uses.
    const syncPresence = () =>
      setExtPresent(!!document.documentElement.getAttribute("data-grindly-extension"));
    syncPresence();

    const onMsg = (e: MessageEvent) => {
      if (e.source !== window || !e.data) return;
      if (e.data.type === "grindly-ext:pong") setExtPresent(true);
      if (e.data.type === "grindly-ext:paired") setPhase(e.data.ok ? "done" : "no_extension");
    };
    window.addEventListener("message", onMsg);

    // Keep looking, rather than deciding once.
    //
    // The content script runs at document_idle and this effect runs after
    // hydration; either can win. A single ping loses that race outright —
    // window.postMessage is not queued for a listener that does not exist yet,
    // so if this fires first the ping goes to nobody and never repeats. The
    // page then reported the extension as absent forever. (The bridge also
    // announces itself now, which covers the same race from its side.)
    const observer = new MutationObserver(syncPresence);
    observer.observe(document.documentElement, {
      attributes: true, attributeFilter: ["data-grindly-extension"],
    });
    window.postMessage({ type: "grindly-ext:ping" }, window.location.origin);
    const retry = window.setInterval(() => {
      if (document.documentElement.getAttribute("data-grindly-extension")) {
        syncPresence();
        window.clearInterval(retry);
        return;
      }
      window.postMessage({ type: "grindly-ext:ping" }, window.location.origin);
    }, 400);
    // Stop after a few seconds: by then it really is not installed, and the
    // page offers a code to paste either way.
    const giveUp = window.setTimeout(() => window.clearInterval(retry), 4000);

    return () => {
      cancelled = true;
      observer.disconnect();
      window.clearInterval(retry);
      window.clearTimeout(giveUp);
      window.removeEventListener("message", onMsg);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const connect = useCallback(async () => {
    setPhase("pairing");
    const res = await fetch("/api/extension/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Browser extension" }),
    }).catch(() => null);
    if (!res || !res.ok) {
      setPhase("error");
      return;
    }
    const data = (await res.json()) as { token: string };
    setToken(data.token);
    // Hand the token to the extension. Its bridge replies with grindly-ext:paired.
    window.postMessage({ type: "grindly-ext:pair", token: data.token }, window.location.origin);
    // If no reply arrives, the extension probably isn't installed — offer the token.
    setTimeout(() => setPhase((p) => (p === "pairing" ? "no_extension" : p)), 2500);
  }, []);

  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-8">
        <div className="mb-6 flex items-center gap-2">
          <Logo />
          <span className="text-muted">· extension</span>
        </div>

        {phase === "checking" && <p className="text-muted">Checking your session…</p>}

        {phase === "need_login" && (
          <>
            <h1 className="text-xl font-semibold">Log in first</h1>
            <p className="mt-2 text-sm text-muted">
              Sign in to your Grindly account, then come back to connect the extension.
            </p>
            <Link href="/login?next=/extension/connect" className="mt-5 inline-block rounded-lg brand-gradient px-5 py-2.5 text-sm font-medium text-white">
              Go to login
            </Link>
          </>
        )}

        {/*
          One "ready" state, and Connect is always offered.

          This used to fork on extPresent, and the branch for "we can't see the
          extension" was a dead end: a "Coming soon" notice, a link back to the
          dashboard, and no way to pair. The paste-a-code fallback below existed
          the whole time but could only be reached by pressing Connect — which
          that branch did not render. So any user whose extension we failed to
          detect could never connect, by any route, ever. Detection is a race
          (see the effect above), which means this was not a rare case.

          extPresent now only changes the wording. Connect works either way:
          it mints the token first and offers it to copy if the handshake does
          not land.
        */}
        {phase === "ready" && (
          <>
            <h1 className="text-xl font-semibold">Connect the extension</h1>
            <p className="mt-2 text-sm text-muted">
              This links the browser extension to your Grindly account so it can fill your matched
              applications — in your own browser, signed in as you.
            </p>
            {!extPresent && (
              <div className="mt-3 rounded-lg border border-border bg-surface-2 px-3 py-3 text-xs text-muted">
                <p className="text-foreground">We can&apos;t see the extension in this browser yet.</p>
                {/*
                  It is not in the Chrome Web Store yet (that needs a developer
                  account and a review that takes days), so during the beta the
                  build is downloaded and loaded unpacked. Spelled out here
                  because "install the extension" is not an instruction anyone
                  can follow when there is nowhere to install it from — and
                  there wasn't: dist/ is gitignored and no page linked to it.
                */}
                <ol className="mt-2 list-decimal space-y-1 pl-4">
                  <li>
                    <a href="/grindly-extension.zip" download className="text-brand underline">
                      Download the extension
                    </a>{" "}
                    and unzip it somewhere you won&apos;t delete.
                  </li>
                  <li>Open <span className="text-foreground">chrome://extensions</span> and turn on Developer mode.</li>
                  <li>Click <span className="text-foreground">Load unpacked</span> and pick the unzipped folder.</li>
                  <li>Come back here and press Connect.</li>
                </ol>
                <p className="mt-2">
                  Already installed it? Press Connect anyway — you&apos;ll get a code to paste
                  into the extension.
                </p>
              </div>
            )}
            <button onClick={connect} className="mt-5 w-full rounded-lg brand-gradient px-5 py-2.5 text-sm font-medium text-white hover:opacity-90 transition">
              Connect
            </button>
          </>
        )}

        {phase === "pairing" && <p className="text-muted">Connecting…</p>}

        {phase === "done" && (
          <>
            <h1 className="text-xl font-semibold text-accent">Connected ✓</h1>
            <p className="mt-2 text-sm text-muted">
              You’re all set. Open a job on Internshala or a company’s own application page and click
              <span className="text-foreground"> “Fill with Grindly.”</span>
            </p>
            <Link href="/dashboard" className="mt-5 inline-block rounded-lg border border-border px-5 py-2.5 text-sm hover:border-brand/40 transition">
              Back to dashboard
            </Link>
          </>
        )}

        {phase === "no_extension" && (
          <>
            <h1 className="text-xl font-semibold">Almost there</h1>
            <p className="mt-2 text-sm text-muted">
              We couldn’t reach the extension automatically. If it’s installed, paste this one-time
              code into the extension’s “Paste code” box. Keep it private — it links to your account.
            </p>
            <div className="mt-4 flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs">{token}</code>
              <button
                onClick={() => navigator.clipboard.writeText(token).catch(() => {})}
                className="rounded-lg border border-border px-3 py-2 text-xs hover:border-brand/40 transition"
              >
                Copy
              </button>
            </div>
          </>
        )}

        {phase === "error" && (
          <p className="text-danger">Something went wrong. Please reload and try again.</p>
        )}
      </div>
    </main>
  );
}
