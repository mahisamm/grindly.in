import { Suspense } from "react";
import type { Metadata } from "next";
import { ForgotForm } from "./ForgotForm";
import { smtpConfigured } from "@/lib/config";

export const metadata: Metadata = { title: "Reset your password — Grindly" };

export default function ForgotPage() {
  return (
    <Suspense fallback={<div className="min-h-[60vh]" />}>
      {/* Told up front rather than after they have typed an address and
          waited. Evaluated per request on the server, so configuring SMTP
          makes the warning disappear without a rebuild. */}
      <ForgotForm mailAvailable={smtpConfigured() || process.env.NODE_ENV !== "production"} />
    </Suspense>
  );
}
