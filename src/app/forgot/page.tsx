import { Suspense } from "react";
import type { Metadata } from "next";
import { ForgotForm } from "./ForgotForm";

export const metadata: Metadata = { title: "Reset your password — Grindly" };

export default function ForgotPage() {
  return (
    <Suspense fallback={<div className="min-h-[60vh]" />}>
      <ForgotForm />
    </Suspense>
  );
}
