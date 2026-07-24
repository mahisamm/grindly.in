"use client";

/**
 * Last resort. `error.tsx` wraps pages, but it does NOT wrap the root layout —
 * so anything that throws in the layout itself (a provider, a font load, a
 * failed env read at module scope) escaped every boundary we had and rendered
 * Next's built-in error screen: no branding, no explanation, and no link back.
 * A beta user who hit it had no way to tell a broken deploy from a broken
 * account, and nothing to click.
 *
 * This file REPLACES the root layout when it renders, which is exactly why it
 * imports nothing: no globals.css, no Logo, no providers. Whatever just failed
 * may be one of those, and a fallback that depends on the thing it is falling
 * back from is not a fallback. Inline styles only.
 */

export default function GlobalError({
  error,
  reset,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
  unstable_retry?: () => void;
}) {
  // Re-fetching is what a root-layout failure usually needs; clearing the error
  // state alone would re-render the same broken tree. Fall back to reset when
  // retry isn't provided.
  const retry = unstable_retry ?? reset;

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "20px",
          background: "#0b0b0f",
          color: "#f4f4f5",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <title>Something went wrong — Grindly</title>
        <div style={{ maxWidth: "26rem", textAlign: "center" }}>
          <div style={{ fontSize: "2.75rem", fontWeight: 700, letterSpacing: "-0.02em" }}>
            Grindly
          </div>
          <h1 style={{ marginTop: "1.5rem", fontSize: "1.25rem", fontWeight: 600 }}>
            Something went wrong on our side
          </h1>
          <p style={{ marginTop: "0.75rem", fontSize: "0.875rem", lineHeight: 1.6, color: "#a1a1aa" }}>
            This is a fault in Grindly, not in your account or your resume. Your
            data is untouched. Try again, and if it keeps happening tell us and
            quote the reference below.
          </p>
          {error?.digest && (
            <p
              style={{
                marginTop: "1rem",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "0.75rem",
                color: "#71717a",
              }}
            >
              ref {error.digest}
            </p>
          )}
          <div
            style={{
              marginTop: "2rem",
              display: "flex",
              gap: "0.75rem",
              justifyContent: "center",
              flexWrap: "wrap",
            }}
          >
            {retry && (
              <button
                onClick={() => retry()}
                style={{
                  cursor: "pointer",
                  border: "none",
                  borderRadius: "0.75rem",
                  padding: "0.7rem 1.25rem",
                  fontSize: "0.875rem",
                  fontWeight: 600,
                  color: "#fff",
                  background: "linear-gradient(135deg, #6d5efc, #b45cff)",
                }}
              >
                Try again
              </button>
            )}
            {/* A plain anchor, not next/link — routing is part of what may be broken. */}
            <a
              href="/"
              style={{
                borderRadius: "0.75rem",
                border: "1px solid #3f3f46",
                padding: "0.7rem 1.25rem",
                fontSize: "0.875rem",
                fontWeight: 600,
                color: "#f4f4f5",
                textDecoration: "none",
              }}
            >
              Go home
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
