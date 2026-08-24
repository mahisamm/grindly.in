"use client";

/**
 * The Razorpay checkout script, loaded on demand from the one place both
 * buyers share — the pricing page's pass checkout and the in-workspace
 * company unlock. Never in any page's critical path, and memoised so two
 * buttons cannot inject two script tags.
 */

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

let scriptPromise: Promise<boolean> | null = null;

/**
 * How long a checkout.js load gets before the button is told it failed.
 *
 * `onload` and `onerror` are not guaranteed to fire: a script tag blocked by a
 * content filter, or a connection that stalls after the handshake, can sit in
 * neither state indefinitely — and a promise that never settles left the Buy
 * button on "Opening…" until the user reloaded. Ten seconds is generous for a
 * ~40 KB script and short enough that the user still believes the retry.
 */
const LOAD_TIMEOUT_MS = 10_000;

export function loadRazorpay(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve) => {
    const el = document.createElement("script");
    el.src = "https://checkout.razorpay.com/v1/checkout.js";
    el.async = true;
    // Resolving false and dropping the memo lets the next click try again;
    // if the script does land late, the `window.Razorpay` fast path above
    // picks it up without a second tag.
    const timer = setTimeout(() => {
      scriptPromise = null;
      resolve(false);
    }, LOAD_TIMEOUT_MS);
    el.onload = () => {
      clearTimeout(timer);
      resolve(true);
    };
    el.onerror = () => {
      clearTimeout(timer);
      scriptPromise = null;
      resolve(false);
    };
    document.head.appendChild(el);
  });
  return scriptPromise;
}
