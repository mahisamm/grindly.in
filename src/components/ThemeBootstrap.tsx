"use client";

import { useEffect } from "react";
import { THEME_KEY } from "@/components/ThemeToggle";

/**
 * Apply a saved colour choice after React owns the document.
 *
 * Mutating <html> in a blocking script before hydration made the browser DOM
 * disagree with the server tree on every route.  A stable first render is more
 * important than a pre-hydration colour preference; the system palette remains
 * available through CSS until this small client effect applies an explicit
 * saved choice.
 */
export function ThemeBootstrap() {
  useEffect(() => {
    try {
      const choice = localStorage.getItem(THEME_KEY);
      if (choice === "dark" || choice === "light") {
        document.documentElement.setAttribute("data-theme", choice);
      }
    } catch {
      // Storage can be unavailable in private browsing. The system palette is
      // already the correct safe fallback.
    }
  }, []);

  return null;
}
