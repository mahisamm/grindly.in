import { Suspense } from "react";
import type { Metadata } from "next";
import { ResetForm } from "./ResetForm";

export const metadata: Metadata = { title: "Choose a new password — Grindly" };

export default function ResetPage() {
  return (
    <Suspense fallback={<div className="min-h-[60vh]" />}>
      <ResetForm />
    </Suspense>
  );
}
