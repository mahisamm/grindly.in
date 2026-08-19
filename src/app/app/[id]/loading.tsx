/**
 * The resume workspace, while it is being fetched.
 *
 * This page does more work before its first byte than any other in the product:
 * a resume with its variants, targets and scores, plus a Python spawn for the
 * company packs. On a phone that is a second or two of nothing at all, and
 * "nothing at all" is what a broken link looks like.
 */
export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-6 sm:py-10" aria-busy="true">
      <span className="sr-only" role="status">
        Loading this resume
      </span>

      <div className="animate-pulse" aria-hidden="true">
        <div className="h-4 w-28 rounded" style={{ background: "var(--surface-2)" }} />
        <div className="mt-6 h-9 w-72 max-w-full rounded" style={{ background: "var(--surface-2)" }} />

        {/* The tab row, at the widths the four real labels occupy. */}
        <div className="border-border mt-6 flex gap-4 border-b pb-3">
          {[88, 96, 140, 168].map((w) => (
            <div
              key={w}
              className="h-4 max-w-[22%] rounded"
              style={{ width: w, background: "var(--surface-2)" }}
            />
          ))}
        </div>

        <div className="mt-8 grid gap-10 lg:grid-cols-[1.4fr_1fr]">
          <div className="h-72 rounded-xl" style={{ background: "var(--surface-2)" }} />
          <div className="flex flex-col gap-4">
            <div className="h-40 rounded-xl" style={{ background: "var(--surface-2)" }} />
            <div className="h-28 rounded-xl" style={{ background: "var(--surface-2)" }} />
          </div>
        </div>
      </div>
    </div>
  );
}
