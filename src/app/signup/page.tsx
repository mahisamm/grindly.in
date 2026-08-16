import { Suspense } from "react";
import type { Metadata } from "next";
import { AuthForm } from "../(auth)/AuthForm";

export const metadata: Metadata = { title: "Create your account — Grindly" };

export default function SignupPage() {
  return (
    <Suspense fallback={<div className="min-h-[60vh]" />}>
      <AuthForm mode="signup" />
    </Suspense>
  );
}
