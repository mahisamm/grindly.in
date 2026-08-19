/**
 * What the resume list looks like while it is being fetched.
 *
 * Both pages under /app are `force-dynamic` and query Postgres before they
 * render, so navigating to them from a phone on a slow connection showed a
 * blank white screen for as long as that took — indistinguishable from a
 * failed navigation, which is why people press the link twice.
 *
 * Laid out at the real dimensions rather than as a centred spinner: a fallback
 * of a different shape makes the page jump when the content arrives, and a
 * spinner tells the user nothing about what is coming.
 */
export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-6 sm:py-10" aria-busy="true">
      {/* aria-hidden on the visuals, with one live sentence for a screen
          reader — a wall of decorative boxes announced one by one is worse
          than silence. */}
      <span className="sr-only" role="status">
        Loading your resumes
      </span>

      <div className="animate-pulse" aria-hidden="true">
        <div className="h-8 w-56 rounded" style={{ background: "var(--surface-2)" }} />
        <div className="mt-3 h-4 w-80 max-w-full rounded" style={{ background: "var(--surface-2)" }} />

        <div
          className="mt-6 rounded-xl border border-dashed sm:mt-8"
          style={{ borderColor: "var(--border)", height: "13rem" }}
        />

        <ul className="mt-8 grid gap-4 sm:mt-10 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              className="h-36 rounded-xl border"
              style={{ borderColor: "var(--border)", background: "var(--surface)" }}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}
