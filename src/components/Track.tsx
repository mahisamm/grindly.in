"use client";

import { useEffect } from "react";

/**
 * Fires one anonymous pageview beacon per full page load. Mounted once in the
 * root layout, so it survives client-side navigations and reports the entry
 * path — enough to count visitors and sessions without a heavyweight analytics
 * SDK (and CSP-safe: same-origin fetch only). Failures are silent by design.
 */
export default function Track() {
  useEffect(() => {
    const path = window.location.pathname || "/";
    // Don't count the owner's own admin sessions as visitor traffic.
    if (path.startsWith("/admin")) return;
    // keepalive so the beacon still sends if the user navigates away immediately.
    fetch("/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
      keepalive: true,
    }).catch(() => {});
  }, []);

  return null;
}
