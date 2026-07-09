"use client";

import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";

type Props = {
  platform: string;
  token: string;
  onClose: () => void;
};

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
 */
export default function ConnectViewer({ platform, token, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "error">("connecting");

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/connect-ws/?token=${encodeURIComponent(token)}`;

    let rfb: RFB | null = null;
    try {
      rfb = new RFB(el, url);
      rfb.scaleViewport = true;
      rfb.addEventListener("connect", () => setStatus("live"));
      rfb.addEventListener("disconnect", () => setStatus("error"));
    } catch {
      setStatus("error");
    }

    return () => {
      try {
        rfb?.disconnect();
      } catch {
        // already gone — fine
      }
    };
  }, [token]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4" onClick={onClose}>
      <div
        className="glass rounded-2xl p-4 max-w-3xl w-full glow"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="font-display text-lg font-semibold capitalize">Log into {platform}</h2>
            <p className="text-sm text-muted mt-0.5">
              {status === "connecting" && "Connecting to the browser…"}
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
        <div
          ref={containerRef}
          className="w-full aspect-video rounded-xl overflow-hidden border border-border bg-black"
        />
      </div>
    </div>
  );
}
