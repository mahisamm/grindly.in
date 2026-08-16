import { Suspense } from "react";
import type { Metadata } from "next";
import { AuthForm } from "../(auth)/AuthForm";
import { BrandPanel } from "../(auth)/BrandPanel";

export const metadata: Metadata = { title: "Create your account — Grindly" };

export default function SignupPage() {
  return (
    <main className="grid min-h-screen grid-cols-1 lg:grid-cols-2">
      <BrandPanel />
      <div className="grid-bg relative flex min-w-0 items-center justify-center">
        <Suspense fallback={<div className="min-h-[60vh]" />}>
          <AuthForm mode="signup" />
        </Suspense>
      </div>
    </main>
  );
}
