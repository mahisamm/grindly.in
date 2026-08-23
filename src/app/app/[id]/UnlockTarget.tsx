"use client";

import { useState } from "react";
import Link from "next/link";
import { loadRazorpay } from "@/lib/razorpayClient";
import { useIsIndia } from "@/components/Region";

/**
 * The purchase moment, exactly where it happens.
 *
 * A free user pressed "Tailor for Google" and the server answered
 * `target_locked`. Sending them to the pricing page from here loses half of
 * them in the navigation; this card takes the payment in place and re-runs
 * the tailoring they already asked for the moment it settles. The pass
 * upsell rides along as one line of arithmetic, not a second button fighting
 * for the click.
 *
 * Same provider discipline as pricing/Checkout.tsx: the client sends a SKU
 * and a target id, never a price; in stub mode the confirm call grants
 * without money moving so the whole flow stays exercisable on a dev clone.
 */
export function UnlockTarget({
  targetId,
  targetName,
  paymentsLive,
  onUnlocked,
  onDismiss,
}: {
  targetId: string;
  targetName: string;
  paymentsLive: boolean;
  /** Called after the unlock settles — the workspace re-runs the tailoring. */
  onUnlocked: () => void;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const india = useIsIndia();

  async function buy() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku: "pack1", targetId }),
      });
      const order = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(order?.error ?? "Could not start checkout.");
        setBusy(false);
        return;
      }

      if (order.provider === "stub") {
        await confirm({ orderId: order.orderId });
        return;
      }

      const loaded = await loadRazorpay();
      if (!loaded || !window.Razorpay) {
        setError("The payment window could not load. Check your connection and try again.");
        setBusy(false);
        return;
      }
      const rzp = new window.Razorpay({
        key: order.keyId,
        order_id: order.providerOrderId,
        amount: order.amount,
        currency: order.currency,
        name: "Grindly",
        description: `Unlock ${targetName}`,
        handler: (response: Record<string, string>) => {
          void confirm({
            orderId: order.orderId,
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
          });
        },
        modal: {
          ondismiss: () => {
            setBusy(false);
            setError("Payment cancelled.");
          },
        },
      });
      rzp.open();
    } catch {
      setError("Something went wrong starting checkout.");
      setBusy(false);
    }
  }

  async function confirm(body: Record<string, string>) {
    try {
      const res = await fetch("/api/pay/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "We could not confirm that payment.");
        setBusy(false);
        return;
      }
      setBusy(false);
      onUnlocked();
    } catch {
      setError("We could not confirm that payment.");
      setBusy(false);
    }
  }

  // The rupee rail cannot take a foreign card cleanly, and a checkout that
  // declines is worse than an honest "not yet". The dollar sheet ($7.99)
  // arrives with the merchant-of-record integration.
  if (!india) {
    return (
      <div
        className="bg-surface border-border mt-5 rounded-xl border p-5"
        role="region"
        aria-label="Paid unlocks are not available in your region yet"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-display text-lg font-semibold">
              Tailoring for {targetName || "this company"} is a paid unlock
            </h3>
            <p className="text-muted mt-1.5 max-w-xl text-sm leading-relaxed">
              Paid checkout is not available in your region yet — it is coming.
              Everything on the free tier — your score, the full report, gap reports
              for any company, and your free rebuilds — works everywhere today.{" "}
              <a href="/pricing" className="text-brand underline">
                See what the plans will cost in your currency
              </a>
              .
            </p>
          </div>
          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            className="text-muted hover:text-ink cursor-pointer text-sm underline"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="bg-surface mt-5 rounded-xl border-2 p-5"
      style={{ borderColor: "var(--brand)" }}
      role="region"
      aria-label="Unlock this company"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-lg font-semibold">
            Unlock {targetName || "this company"} — ₹99
          </h3>
          <p className="text-muted mt-1.5 max-w-xl text-sm leading-relaxed">
            Once, for this company, for good: tailored rebuilds aimed at what they
            actually screen for, the gap report, and a cover letter. Your tailoring
            starts the moment the payment settles.
          </p>
          <p className="text-muted mt-2 text-xs leading-relaxed">
            Applying to four or more companies?{" "}
            <Link href="/pricing" className="text-brand underline">
              The ₹399 Season Pass
            </Link>{" "}
            covers every company for three months — four unlocks would already cost more.
          </p>
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-muted hover:text-ink cursor-pointer text-sm underline"
        >
          Not now
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button onClick={buy} disabled={busy} className="btn btn-primary min-w-44 justify-center">
          {busy ? "Opening…" : paymentsLive ? `Unlock for ₹99` : "Activate (demo — no payment)"}
        </button>
        {!paymentsLive && (
          <span className="text-muted text-xs">
            This server has no payment provider configured, so this grants the unlock free.
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs" style={{ color: "#a3271b" }}>
          {error}
        </p>
      )}
    </div>
  );
}
