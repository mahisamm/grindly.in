import type { NextConfig } from "next";
import path from "node:path";

const isDev = process.env.NODE_ENV === "development";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // 'unsafe-inline' is kept only because the Razorpay checkout modal may
      // inject inline event handlers we cannot verify without a live checkout
      // run. Payments default to stub mode, so this is dormant risk rather than
      // active — but it IS risk, and tightening it needs either confirming
      // Razorpay is CSP-clean without it or threading a per-request nonce.
      `script-src 'self' 'unsafe-inline' https://checkout.razorpay.com${isDev ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://*.razorpay.com",
      "connect-src 'self' https://*.razorpay.com",
      "frame-src https://*.razorpay.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  // Hide the on-screen dev route indicator (the floating "N" badge).
  devIndicators: false,
  // Pin the workspace root — a stray lockfile in the home dir was making Next
  // infer the wrong root, which broke route + metadata resolution.
  turbopack: {
    root: path.join(__dirname),
  },
  // The /sw.js rewrite is gone with the service worker. It cached every
  // non-API GET into the browser's Cache API — including /app/<id>, whose
  // props embed the full resume text, contact details and scores. On a shared
  // campus machine that served the previous user's resume to the next one
  // whenever the network dropped. It also listed a "/offline" route that does
  // not exist, and `caches.addAll` is atomic, so install rejected on every load
  // and the whole thing never actually ran. There is no offline story here
  // worth that risk.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
