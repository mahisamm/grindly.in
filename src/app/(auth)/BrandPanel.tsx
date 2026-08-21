import Link from "next/link";
import { Logo } from "@/components/Brand";
import { Magnifier, Shield, Target, Doc } from "@/components/Doodles";
import { ParticleField } from "@/components/ParticleField";

/**
 * The ink panel beside the sign-in form.
 *
 * Carried over from the pre-pivot login page, which had it and which the new
 * one had dropped to a bare centred form. It is worth keeping: sign-in is the
 * first screen a stranger sees, and a lone input box on an empty page says
 * nothing about what they are signing in to.
 *
 * The four lines are the product's actual claims, not decoration — each one is
 * something the code does and the tests hold. The old panel promised "daily
 * progress reports in Slack" and "five leading job platforms", which described
 * a product that no longer exists; a brand panel making claims the software
 * cannot keep is worse than no brand panel.
 *
 * Desktop only. On a phone this would push the form below the fold, and the
 * form is the point.
 */
export function BrandPanel() {
  // Plain words, deliberately. This panel greets people who have never heard
  // of parsing, and the earlier version spoke to people who had — beta
  // feedback said new visitors could not tell what the product does. Every
  // line here survives the "would my cousin get it" test.
  const points: [React.ComponentType<{ size?: number }>, string][] = [
    [Magnifier, "See exactly what that software reads from your file"],
    [Doc, "Get a score and a plain list of what to fix"],
    [Target, "Rebuild it as a clean version machines read perfectly"],
    [Shield, "It never invents skills or jobs you don't have"],
  ];

  return (
    <aside
      className="relative hidden overflow-hidden border-r border-ink lg:flex lg:flex-col lg:justify-between"
      style={{
        background: "var(--ink)",
        color: "var(--paper)",
        padding: "clamp(28px,4vw,52px)",
      }}
    >
      {/* Paper-toned, because this panel is painted var(--ink) and ink specks
          on ink are a canvas doing arithmetic for nobody. Contained by the
          aside, which is already `relative overflow-hidden`. */}
      <ParticleField tone="paper" className="particle-field--contained" />

      {/* Two vermilion washes, corner to corner. Pointer-events off and
          aria-hidden — it is atmosphere, not content. */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden
        style={{
          background:
            "radial-gradient(60% 50% at 80% 10%, rgba(227,64,42,.18) 0%, transparent 70%), radial-gradient(50% 40% at 10% 90%, rgba(227,64,42,.10) 0%, transparent 70%)",
        }}
      />
      <span
        aria-hidden
        className="font-display pointer-events-none absolute -right-[4%] -bottom-[14%] leading-none"
        style={{ fontSize: "clamp(16rem, 30vw, 30rem)", color: "rgba(242,236,225,0.045)" }}
      >
        G
      </span>

      <Link href="/" className="relative z-[2] inline-flex">
        <Logo size={34} withWordmark light />
      </Link>

      <div className="relative z-[2]">
        <h2
          className="font-display leading-[1.06]"
          style={{ fontSize: "clamp(2.2rem,3.6vw,3.4rem)", color: "var(--paper)" }}
        >
          Software reads your resume
          <br />
          <span className="accent-italic">before any human does.</span>
        </h2>
        <p className="mt-4 max-w-md text-sm" style={{ color: "rgba(242,236,225,0.72)" }}>
          Apply to Amazon, and their system pulls your name, skills and dates out
          of the file first. If your layout confuses it, the recruiter sees a
          half-empty profile — and you never hear back, or why. Grindly shows you
          what that software sees, and fixes it.
        </p>

        <ul className="mt-8 space-y-3.5">
          {points.map(([Icon, text], i) => (
            <li
              key={i}
              className="flex items-center gap-3"
              style={{ color: "rgba(242,236,225,0.88)" }}
            >
              <span
                className="inline-flex size-9 flex-none items-center justify-center rounded-xl"
                style={{
                  border: "1px solid rgba(242,236,225,0.28)",
                  background: "rgba(242,236,225,0.06)",
                }}
              >
                <Icon size={18} />
              </span>
              <span className="text-sm">{text}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="relative z-[2] text-sm" style={{ color: "rgba(242,236,225,0.7)" }}>
        {/* Ornament, not content — it says nothing the sentence beside it does
            not. Hidden from the accessibility tree and set in the identity
            vermilion, which is 3.24:1 on ink: fine for decoration, short of the
            4.5:1 that would be required if it carried meaning. */}
        <span aria-hidden="true" className="tracking-[0.18em]" style={{ color: "var(--vermilion)" }}>
          ✦✦✦✦✦
        </span>{" "}
        The rubric is published. Same file, same score, every time.
      </p>
    </aside>
  );
}
