"use client";

import { useSyncExternalStore } from "react";

/**
 * Which price sheet a visitor sees.
 *
 * India pays in rupees through Razorpay, live today. Everyone else sees the
 * dollar sheet — $7.99 per company, $29 pass — priced against what their
 * market charges ($29–50 A MONTH is the going rate for resume tools), never
 * a currency conversion of the Indian price: converted paise reads as a toy
 * abroad and halves itself in fixed processor fees. Foreign checkout waits
 * on a merchant-of-record account, so those buttons say "coming soon" and
 * mean it.
 *
 * Region comes from the browser's timezone rather than IP geolocation: it
 * needs no service, no consent banner, and no server plumbing, and the
 * failure mode is only ever showing a traveller the wrong price SHEET — the
 * server still refuses any purchase the rail cannot take. The server render
 * shows the Indian sheet; non-Indian browsers swap after hydration via
 * useSyncExternalStore, which reconciles without a hydration warning.
 */

const noopSubscribe = () => () => {};

function readIsIndia(): boolean {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz === "Asia/Kolkata" || tz === "Asia/Calcutta";
  } catch {
    return true;
  }
}

export function useIsIndia(): boolean {
  return useSyncExternalStore(noopSubscribe, readIsIndia, () => true);
}

/** One price, in the visitor's sheet. Amounts in smallest units. */
export function RegionPrice({
  inrPaise,
  usdCents,
  className,
}: {
  inrPaise: number;
  usdCents: number;
  className?: string;
}) {
  const india = useIsIndia();
  return (
    <span className={className}>
      {india ? formatInr(inrPaise) : formatUsd(usdCents)}
    </span>
  );
}

/** Renders children for Indian visitors, the fallback for everyone else. */
export function IndiaOnly({
  children,
  fallback = null,
}: {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  return useIsIndia() ? <>{children}</> : <>{fallback}</>;
}

function formatInr(paise: number): string {
  const major = paise / 100;
  return `₹${major.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function formatUsd(cents: number): string {
  const major = cents / 100;
  return `$${major.toLocaleString("en-US", {
    minimumFractionDigits: major % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}
