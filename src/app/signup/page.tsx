import { Suspense, ViewTransition } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { googleOAuthConfigured } from "@/lib/config";
import { AuthForm } from "../(auth)/AuthForm";
import { BrandPanel } from "../(auth)/BrandPanel";
import { AmbientBackground } from "@/components/AmbientBackground";

export const metadata: Metadata = { title: "Create your account — Grindly" };
// Reads the session cookie and the server's capabilities, so it cannot be
// prerendered — and should not be: showing a sign-in form to someone already
// signed in is a dead end they have to notice for themselves.
export const dynamic = "force-dynamic";

export default async function SignupPage() {
  if (await currentUser()) redirect("/app");

  return (
    // Same soft arrival as the login page — see the note there.
    <ViewTransition enter="page-in" default="none">
      <main className="grid min-h-screen grid-cols-1 lg:grid-cols-2">
        <BrandPanel />
        <div className="grid-bg relative flex min-w-0 items-center justify-center overflow-hidden">
          <AmbientBackground contain />
          {/* Required, not decorative: AuthForm reads `?error=` with
              useSearchParams, and a page that does so without a boundary fails
              the build. */}
          <Suspense fallback={<div className="min-h-[60vh]" />}>
            <div className="relative z-[1] min-w-0">
              <AuthForm mode="signup" googleAuth={googleOAuthConfigured()} />
            </div>
          </Suspense>
        </div>
      </main>
    </ViewTransition>
  );
}
