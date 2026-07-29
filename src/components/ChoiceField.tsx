"use client";
import { useState } from "react";
import type { ProffField } from "@/lib/proffQuestions";

export const OTHER = "__other__";

/**
 * Pick from a list, or say something the list doesn't cover.
 *
 * Free text alone produced answers the agent could not use: "asap" is not one of
 * a form's dropdown options, and "around 20-25 depending on my sem" cannot go in
 * a numeric input. A list alone would be worse — it would force a user whose
 * situation isn't listed to pick something untrue about themselves, and every
 * one of these is stated to an employer under their name. So: a list, plus a way
 * out of it.
 *
 * Shared by setup and the dashboard's profile tab on purpose. These answers are
 * facts about the user, not preferences, and one of the two screens rendering
 * them differently is how an answer given at signup becomes uneditable later.
 */
export default function ChoiceField({
  field,
  value,
  onChange,
}: {
  field: ProffField;
  value: string;
  onChange: (v: string) => void;
}) {
  const options = field.options ?? [];
  const isListed = value !== "" && options.includes(value);
  // A pre-filled value the list doesn't contain (read off the resume, or typed
  // last time) has to keep the box open, or it silently disappears on render.
  const [custom, setCustom] = useState(value !== "" && !isListed);

  return (
    <div className="space-y-2">
      <select
        aria-label={field.label}
        value={custom ? OTHER : value}
        onChange={(e) => {
          if (e.target.value === OTHER) {
            setCustom(true);
            onChange("");
            return;
          }
          setCustom(false);
          onChange(e.target.value);
        }}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand transition"
      >
        <option value="">Select…</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        <option value={OTHER}>Something else…</option>
      </select>
      {custom && (
        <input
          type="text"
          autoFocus
          aria-label={`${field.label} — your own answer`}
          value={value}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand transition"
        />
      )}
    </div>
  );
}
