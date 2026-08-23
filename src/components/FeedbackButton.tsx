"use client";

import { useState } from "react";
import { FeedbackDialog } from "@/components/ReportProblem";

/** A button that opens the feedback dialog — for places with no account menu
    (the phone's settings page). */
export function FeedbackButton({ className = "btn text-sm" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        Contact &amp; feedback
      </button>
      <FeedbackDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
