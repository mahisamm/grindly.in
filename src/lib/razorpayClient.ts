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

export function loadRazorpay(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve) => {
    const el = document.createElement("script");
    el.src = "https://checkout.razorpay.com/v1/checkout.js";
    el.async = true;
    el.onload = () => resolve(true);
    el.onerror = () => {
      scriptPromise = null;
      resolve(false);
    };
    document.head.appendChild(el);
  });
  return scriptPromise;
}
