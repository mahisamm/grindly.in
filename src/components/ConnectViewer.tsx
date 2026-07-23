"use client";

import { memo, useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";

type Props = {
  platform: string;
  token: string;
  onClose: () => void;
};

// A dropped WebSocket mid-login used to be terminal: the canvas went black, the
// user got "Lost connection", and the only way forward was to close and restart
// the whole remote session (losing anything already typed). Proxy hiccups and
// mobile network switches are routine, so we retry a few times with backoff
// before admitting defeat.
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;

/**
 * Live view of the remote-browser login session started by
 * agent/connect_service.py. The user watches and drives a real Chromium
 * window running on the server — this is how a hosted (no-local-machine,
 * no-screen) user logs into LinkedIn/Naukri/etc themselves, so Grindly
 * never sees or stores the password.
 *
 * Auth model: the token in the WebSocket URL is the only thing gating this
 * view — see docker-compose's `connect` service + Caddyfile's
 * /connect-ws/ route. It's short-lived and single-use server-side; this
 * component does not add its own auth layer beyond "you had to be logged
 * into Grindly to ever receive this token from GET /api/integrations".
 *
 * memo()'d on purpose: the parent dashboard re-renders on its own polling
 * cadence, and this subtree owns a live canvas that must not be disturbed by
 * anything except a genuine token/platform change.
 */
function ConnectViewer({ platform, token, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // "reconnecting" is its own state, not a derived read of the retry counter:
  // refs must not be read during render, and the user needs to be told the
  // difference between "still opening" and "dropped, coming back".
  const [status, setStatus] = useState<"connecting" | "reconnecting" | "live" | "error">("connecting");
  // Retry bookkeeping lives in refs — bumping it must reconnect the socket, not
  // re-run render logic, and the effect below must not restart because of it.
  const retriesRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/connect-ws/?token=${encodeURIComponent(token)}`;

    let rfb: RFB | null = null;
    let cancelled = false;
    retriesRef.current = 0;

    const connect = () => {
      if (cancelled) return;
      try {
        // Tear down whatever the dead session left behind first. noVNC appends
        // its own canvas to this element and does not always remove it on an
        // unexpected drop — without this, each retry would stack another canvas
        // on top of the last.
        try { rfb?.disconnect(); } catch { /* already gone */ }
        el.replaceChildren();
        rfb = new RFB(el, url);
        rfb.scaleViewport = true;
        rfb.addEventListener("connect", () => {
          if (cancelled) return;
          retriesRef.current = 0; // a good connection resets the budget
          setStatus("live");
        });
        rfb.addEventListener("disconnect", () => {
          if (cancelled) return;
          if (retriesRef.current < MAX_RETRIES) {
            retriesRef.current += 1;
            setStatus("reconnecting");
            // Linear backoff: the session it reconnects to is short-lived, so
            // waiting minutes to retry would outlive the thing being retried.
            timerRef.current = setTimeout(connect, RETRY_DELAY_MS * retriesRef.current);
            return;
          }
          setStatus("error");
        });
      } catch {
        // Syncing an external system's (noVNC/WebSocket) failure into React state.
        setStatus("error");
      }
    };

    connect();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      try {
        rfb?.disconnect();
      } catch {
        // already gone — fine
      }
    };
  }, [token]);

  // No backdrop-click-to-close: a login in progress is easy to lose with a
  // stray click, and closing tears down the whole remote session. Only the
  // explicit Close button cancels.
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div className="glass rounded-2xl p-4 max-w-3xl w-full glow">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="font-display text-lg font-semibold capitalize">Log into {platform}</h2>
            <p className="text-sm text-muted mt-0.5">
              {status === "connecting" && "Connecting to the browser…"}
              {status === "reconnecting" && "Connection dropped — reconnecting to your login window, nothing is lost…"}
              {status === "live" && "Log in below — this window is running on Grindly's server, but only you can see it. Your password never touches Grindly."}
              {status === "error" && "Lost connection to the browser. Close this and try again."}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-danger/60 transition shrink-0 ml-3"
          >
            Close
          </button>
        </div>
        {status === "live" && (
          <div className="mb-3 space-y-1.5">
            <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
              Sign in with your <span className="font-medium capitalize">{platform}</span> email &amp; password.
              Google sign-in is turned off in this window — Google blocks it from remote browsers. If you only
              ever used <span className="font-medium">&ldquo;Continue with Google&rdquo;</span>, set a password
              first on {platform} via <span className="font-medium">Forgot password</span>, then use it here.
            </div>
            <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted">
              <span className="text-foreground font-medium">Asked for a verification code?</span> That&apos;s
              normal for a first login — {platform} emails you a code. Open your inbox, then type it into the
              window here. You have a few minutes.
            </div>
          </div>
        )}
        <div
          ref={containerRef}
          className="w-full aspect-video rounded-xl overflow-hidden border border-border bg-black"
        />
      </div>
    </div>
  );
}

// Only a real session change (new platform/token) should tear down the canvas.
// onClose identity changes with every parent render and must not count.
export default memo(
  ConnectViewer,
  (a, b) => a.token === b.token && a.platform === b.platform,
);
