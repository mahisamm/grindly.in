# Chrome Web Store — submission pack

> **This is the one step I (the agent) cannot do for you.** Submitting requires
> your own Chrome Web Store developer account (one-time US$5), and Google's review
> takes days and can bounce on policy. Everything below is prepared so you only
> have to upload and fill the form.

## Pre-submit checklist

- [ ] Add icons: `icons/icon16.png`, `icon48.png`, `icon128.png` (see `icons/README.md`),
      then add an `"icons"` block + `action.default_icon` to `manifest.json`.
- [ ] `node build.mjs` → upload `dist/grindly-extension-<version>.zip`.
- [ ] Privacy policy URL: `https://grindly.in/extension/privacy` (already live).
- [ ] Single purpose (see below) + per-permission justifications (see below).

## Store listing copy

**Name:** Grindly — Apply Assistant

**Summary (132 char max):**
Auto-fill your job applications from your Grindly account — in your own browser. You always click Submit yourself.

**Description:**
Grindly finds internships and jobs that match you, tailors your resume, and drafts
your cover letter and screening answers. This extension fills that prepared kit into
the application form on Internshala, LinkedIn, Naukri, Unstop and Indeed — in your
own browser, in one click. You review and submit yourself; the extension never
submits for you. Requires a Grindly account (grindly.in).

## Single purpose (required field)

> Fill the signed-in user's own Grindly-prepared application kit into job-application
> forms on supported job sites, at the user's explicit click. It does not submit forms.

## Permission justifications (required per permission)

- **`storage`** — stores the account-pairing token locally so the extension can fetch
  the user's own kits. Nothing else is stored.
- **`activeTab`** — read the current job page's URL to look up the matching kit, and
  fill the form only when the user clicks the button.
- **host `grindly.in`** — fetch the signed-in user's kits over HTTPS.
- **host `internshala.com`, `linkedin.com`, `naukri.com`, `unstop.com`, `indeed.com`** —
  the job sites whose application forms the user asks the extension to fill.

Not requested: `<all_urls>`, `tabs`, `webRequest`, `scripting` (broad), analytics.
This narrow scope is deliberate and should be stated in the review notes.

## Data-use disclosures (Privacy practices tab)

- Does the item collect user data? **Yes — authentication token (stored locally only).**
- Sold/transferred to third parties? **No.**
- Used for anything unrelated to the single purpose? **No.**
- Used to determine creditworthiness / lending? **No.**

## Review notes (paste into "Notes to reviewer")

> The extension is a companion to grindly.in. It fills the signed-in user's own
> prepared application materials into supported job-site forms at the user's click,
> and never submits the form (the user clicks Submit). The token stored via `storage`
> only authorizes reading that same user's data from grindly.in. Test account and
> steps available on request.
