# Grindly Apply Assistant (browser extension)

Fills your matched job applications from your Grindly account, **in your own
browser**, on Internshala / LinkedIn / Naukri / Unstop / Indeed. You always click
Submit yourself — the extension never submits, and never touches the Submit
button (enforced by `src/__tests__/safety.test.ts`).

## Why an extension (and not server-side auto-apply)

Filling a form from our servers is fingerprinted as a bot regardless of who clicks
Submit — that risks the user's job-platform account. Running in the user's own
browser is the same category as a password manager: it is *their* real session, so
there's nothing for the platform to flag. See the plan for the full rationale.

## Architecture

```
grindly.in  ──/api/extension/pair──▶  mints a bearer token (stored hashed)
     │
     ▼ (window.postMessage)
bridge.js (content script on grindly.in)  ──▶  background.js  (stores token; ONLY place it lives)
                                                     │
job page (linkedin.com/…)                            │  /api/extension/kit?url=…  (Bearer token)
     │                                               ▼
filler.js  ◀──message──  background.js  ◀──── the kit (cover letter, answers, profile facts)
     │
     ▼  GrindlyFill.applyFills(document, kit)   ← fills fields; NEVER submits
```

- **`src/fillEngine.js`** — the fill logic. Pure `planFills(fields, kit)` core
  (unit-tested) + thin DOM glue. Ships as-is; no build step.
- **`src/background.js`** — service worker; the only holder of the token.
- **`src/content/bridge.js`** — runs on grindly.in: pairing handoff + presence marker.
- **`src/content/filler.js`** — runs on job sites: floating "Fill with Grindly" button.
- **`src/popup/`** — connection status + connect/disconnect.

## Load it for local testing (developer)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` folder.
3. Log in at grindly.in, open `/extension/connect`, click **Connect**.
4. Open a **due matched** job listing on a supported site → click **Fill with Grindly**.

## What still needs live testing (cannot be verified in CI)

The pure decision logic is unit-tested, but the per-platform **selectors** and the
real fill/handoff can only be confirmed against a live, logged-in session on each
site. Validate on your own account, Internshala first, before wider rollout.

## Packaging for the Chrome Web Store

`node build.mjs` produces `dist/grindly-extension-<version>.zip`. Before submitting
you must add real icons (see `icons/README.md`) — the store requires a 128×128 PNG.
Submission itself needs a Chrome Web Store developer account; see `STORE.md`.
