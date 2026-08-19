"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Move the "sending this one" pointer to a resume.
 *
 * The undo for promoting a rebuild, and the reason promoting one is not a
 * decision anybody has to think hard about. It writes a single column; nothing
 * is copied and nothing is deleted, so pressing it on the wrong card costs one
 * more press.
 *
 * It lives outside the card's link rather than inside it. A button nested in an
 * anchor is invalid markup and, more to the point, is a control that a keyboard
 * user reaches by tabbing into a link — the click either navigates or does not
 * depending on where exactly the pointer landed.
 */
export function MakePrimary({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function choose() {
    setBusy(true);
    setError(false);
    try {
      const res = await fetch(`/api/resumes/${id}/primary`, { method: "POST" });
      if (!res.ok) {
        setError(true);
        return;
      }
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={() => void choose()}
      disabled={busy}
      className="text-muted hover:text-ink cursor-pointer text-xs font-medium underline underline-offset-2"
    >
      {busy ? "Switching…" : error ? "Did not save — try again" : "Send this one instead"}
    </button>
  );
}
