"use client";

export default function OfflinePage() {
  return (
    <main className="min-h-screen grid-bg flex items-center justify-center px-5">
      <div className="glass rounded-2xl p-8 text-center max-w-sm glow">
        <div className="text-4xl mb-3">📡</div>
        <h1 className="font-display text-2xl font-bold">You&apos;re offline</h1>
        <p className="mt-2 text-sm text-muted">
          Grindly needs a connection to run the agent and load your dashboard. Check your internet and try again.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-5 press rounded-lg brand-gradient px-5 py-2.5 text-sm font-medium text-white w-full"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
