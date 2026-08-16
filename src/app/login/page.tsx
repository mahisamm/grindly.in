import { Suspense } from "react";
import type { Metadata } from "next";
import { AuthForm } from "../(auth)/AuthForm";
import { BrandPanel } from "../(auth)/BrandPanel";

export const metadata: Metadata = { title: "Sign in — Grindly" };

/**
 * Two-column split: ink brand panel, then the form.
 *
 * The Suspense boundary is required, not decorative — AuthForm reads `?error=`
 * with useSearchParams, and a statically prerendered page that does so without
 * one fails the build outright.
 */
export default function LoginPage() {
  return (
    <main className="grid min-h-screen grid-cols-1 lg:grid-cols-2">
      <BrandPanel />
      <div className="grid-bg relative flex min-w-0 items-center justify-center">
        <Suspense fallback={<div className="min-h-[60vh]" />}>
          <AuthForm mode="login" />
        </Suspense>
      </div>
    </main>
  );
}
