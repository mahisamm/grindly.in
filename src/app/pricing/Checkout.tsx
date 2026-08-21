"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Sku } from "@/lib/plans";
import { loadRazorpay } from "@/lib/razorpayClient";

/**
 * Buy a pass.
 *
 * Two provider paths behind one button. In stub mode — the default, and what a
 * fresh clone runs — the confirm call is made directly and the plan is granted
 * without money moving, so the whole flow is exercisable by anyone evaluating
 * this. In Razorpay mode the checkout script is loaded on demand (never in the
 * page's critical path) and the signature it returns is verified server-side.
 *
 * The client never sends a price. It sends a SKU; the server records what that
 * costs on the order row and reads it back at confirmation.
 */
export function Checkout({
  sku,
  signedIn,
  paymentsLive,
}: {
  sku: Sku;
  signedIn: boolean;
  /**
   * False when the server is in stub mode. The button then says so.
   *
   * Without this the page rendered "₹399" above a "Buy" that granted the plan
   * for free — so one unset environment variable handed out unlimited passes
   * while the page displayed a price, and neither the operator nor the user had
   * any way to tell.
   */
  paymentsLive: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function buy() {
    if (!signedIn) {
      router.push(`/signup?next=/pricing`);
      return;
    }
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku }),
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
        description: order.product?.name,
        handler: (response: Record<string, string>) => {
          void confirm({
            orderId: order.orderId,
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
          });
        },
        modal: {
          // Without this the button stays in "Opening…" forever when someone
          // closes the payment window, and the only way out is a page reload.
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
      setDone(true);
      setBusy(false);
      router.refresh();
    } catch {
      setError("We could not confirm that payment.");
      setBusy(false);
    }
  }

  if (done) {
    return (
      <button onClick={() => router.push("/app")} className="btn btn-primary mt-6 w-full justify-center">
        Pass active — go to your resumes
      </button>
    );
  }

  return (
    <div className="mt-6">
      <button onClick={buy} disabled={busy} className="btn btn-primary w-full justify-center">
        {busy
          ? "Opening…"
          : !signedIn
            ? "Sign up to buy"
            : paymentsLive
              ? "Buy"
              : "Activate (demo — no payment)"}
      </button>
      {!paymentsLive && signedIn && (
        <p className="text-muted mt-2 text-xs leading-snug">
          This server has no payment provider configured, so this grants the plan
          without charging anything.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs" style={{ color: "#a3271b" }}>
          {error}
        </p>
      )}
    </div>
  );
}
