"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/**
 * One page view per navigation, to /api/track (see that route for what is
 * and is not recorded). Renders nothing.
 *
 * `sendBeacon` rather than fetch: it survives the tab closing mid-request and
 * never blocks the navigation it describes. The last-sent path is remembered
 * so a re-render of the same route does not count twice. The operator's own
 * admin pages are excluded at the source — a dashboard that counts the person
 * reading it is off by one forever.
 */
export function TrafficBeacon() {
  const pathname = usePathname();
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (!pathname || pathname === last.current) return;
    if (pathname.startsWith("/admin")) return;
    last.current = pathname;
    const body = JSON.stringify({ path: pathname });
    try {
      if (typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon("/api/track", new Blob([body], { type: "application/json" }));
      } else {
        void fetch("/api/track", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    } catch {
      /* nothing a visitor does depends on this */
    }
  }, [pathname]);

  return null;
}
