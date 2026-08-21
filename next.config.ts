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
      // 'self' is here for the PDF preview beside a rebuild — the document is
      // served by our own ownership-checked route and framed on the compare
      // panel, which is the one place in the product where the claim and its
      // evidence sit next to each other. Without it the frame is blocked and
      // the panel renders an empty box with no error the user can act on.
      "frame-src 'self' https://*.razorpay.com",
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
        // Everything EXCEPT the rendered PDFs.
        //
        // The exclusion is load-bearing rather than tidy. Next applies every
        // matching rule, so with a bare "/(.*)" the variant-file route received
        // the global `X-Frame-Options: DENY` on top of its own
        // `frame-ancestors 'self'`, and the browser refused to frame the very
        // document the compare panel exists to show. Verified against the live
        // site, which was sending both headers at once.
        //
        // Two CSP headers would be no better: browsers intersect them, so a
        // global `frame-ancestors` would override the route's more permissive
        // one no matter which order they arrive in. The only fix that works is
        // for exactly one rule to match.
        source: "/((?!api/variants/[^/]+/file).*)",
        headers: securityHeaders,
      },
      {
        // The rendered PDFs, which the compare panel frames.
        //
        // X-Frame-Options: DENY blocks framing outright — including by the same
        // origin, which is the only kind we want. There is no SAMEORIGIN-plus-
        // nothing-else form of that header that also survives the wildcard rule
        // above, so this route overrides it and states the real policy in CSP
        // instead: this document may be framed by us and by nobody.
        //
        // frame-ancestors is the modern replacement for X-Frame-Options and is
        // the header that actually decides this in every current browser.
        //
        // No `sandbox` directive: the browser's built-in PDF viewer is a plugin
        // that a strict sandbox disables, so adding it would trade a working
        // preview for a blank frame — and the document is one this user is
        // already authorised to download.
        source: "/api/variants/:id/file",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
