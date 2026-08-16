import { Suspense } from "react";
import type { Metadata } from "next";
import { AuthForm } from "../(auth)/AuthForm";

export const metadata: Metadata = { title: "Sign in — Grindly" };

/**
 * The Suspense boundary is required, not decorative: AuthForm reads
 * `?error=` with useSearchParams, and a statically prerendered page that
 * does so without one fails the build outright.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-[60vh]" />}>
      <AuthForm mode="login" />
    </Suspense>
  );
}
