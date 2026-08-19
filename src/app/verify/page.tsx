import { Suspense } from "react";
import type { Metadata } from "next";
import { VerifyForm } from "./VerifyForm";

export const metadata: Metadata = { title: "Confirm your email — Grindly" };

export default function VerifyPage() {
  return (
    <Suspense fallback={<div className="min-h-[60vh]" />}>
      <VerifyForm />
    </Suspense>
  );
}
