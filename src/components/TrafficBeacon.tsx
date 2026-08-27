"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

type Attribution = {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  referrerHost?: string;
};

const ATTRIBUTION_KEY = "grindly:first-touch";
const VALUE = /^[a-z0-9][a-z0-9._ -]{0,79}$/i;

function clean(value: string | null): string | undefined {
  const trimmed = value?.trim() ?? "";
  return VALUE.test(trimmed) ? trimmed : undefined;
}

function firstTouch(params: URLSearchParams): Attribution {
  try {
    const saved = sessionStorage.getItem(ATTRIBUTION_KEY);
    if (saved) return JSON.parse(saved) as Attribution;

    const incoming: Attribution = {
      utmSource: clean(params.get("utm_source")),
      utmMedium: clean(params.get("utm_medium")),
      utmCampaign: clean(params.get("utm_campaign")),
    };
    if (!incoming.utmSource && document.referrer) {
      const host = new URL(document.referrer).hostname.toLowerCase();
      if (host && host !== location.hostname) incoming.referrerHost = clean(host);
    }
    sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(incoming));
    return incoming;
  } catch {
    return {};
  }
}

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
    // Attribution is intentionally first-touch and session-scoped. A campaign
    // link gets credit for the visit it brought, but we never retain a full
    // query string or a referrer's path.
    const body = JSON.stringify({ path: pathname, ...firstTouch(new URLSearchParams(window.location.search)) });
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
