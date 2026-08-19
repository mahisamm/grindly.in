"use client";

import { useSyncExternalStore } from "react";

/**
 * Light, dark, or whatever the machine says.
 *
 * Three states rather than a switch, and the third is the default. A binary
 * toggle has to pick a starting side, and picking one means overriding a choice
 * the reader already made in their operating system — which is the setting that
 * is right for them at 2am without anyone having to think about it.
 *
 * The choice lives in localStorage and is applied to <html> as `data-theme`.
 * The inline script in the root layout reads the same key before first paint,
 * which is what stops a dark-mode reader getting one white frame on every
 * server-rendered navigation. This component only changes it afterwards.
 *
 * Read with useSyncExternalStore rather than an effect. localStorage IS an
 * external store, and this is what that hook is for: the server snapshot is
 * "system" (the server cannot know), the client snapshot is the real value, and
 * React reconciles the two itself instead of us rendering a guess and then
 * correcting it in an effect — which is a hydration mismatch on the one control
 * whose entire job is to already be correct.
 */

export const THEME_KEY = "grindly-theme";
export type ThemeChoice = "light" | "dark" | "system";

/** Notifies subscribers in THIS tab; `storage` only fires in the others. */
const CHANGE_EVENT = "grindly-theme-change";

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "dark" || stored === "light" ? stored : "system";
  } catch {
    // Private browsing, or storage disabled entirely.
    return "system";
  }
}

/** The server has no idea, and says so rather than guessing. */
function serverChoice(): ThemeChoice {
  return "system";
}

function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // The theme still applies to this page; it just will not be remembered,
    // which is a better outcome than throwing inside a click handler.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function ThemeToggle() {
  const choice = useSyncExternalStore(subscribe, readChoice, serverChoice);

  return (
    <fieldset className="border-border rounded-full border p-0.5">
      <legend className="sr-only">Colour theme</legend>
      <div className="flex">
        {(
          [
            ["light", "Light"],
            ["dark", "Dark"],
            ["system", "System"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={choice === value}
            onClick={() => apply(value)}
            className="cursor-pointer rounded-full px-3 py-1 text-xs font-semibold transition-colors"
            style={{
              // See Compare.tsx: 12px label, so --cta rather than --vermilion.
              background: choice === value ? "var(--cta)" : "transparent",
              color: choice === value ? "var(--on-cta)" : "var(--muted)",
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
