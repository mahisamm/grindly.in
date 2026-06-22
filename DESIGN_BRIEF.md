# NexPath — Internship Agent UI Design Brief

## Project Overview

**NexPath** is an AI-powered internship agent that automates job applications across 5 platforms. Users pay for a plan, connect their accounts once, and the agent runs daily to search, score, and apply to matching internships.

**User Journey:**
1. Register → Auth
2. Payment (choose Starter 10/day or Pro 30/day)
3. Complete profile (domains, locations, firewall rules)
4. Connect platforms (LinkedIn, Internshala, Naukri, Unstop, Indeed)
5. Run agent → view applications + reports

---

## Data Schema (Simplified)

```
User
├─ id, email, name
├─ paid (boolean) — unlocks agent
├─ plan ("starter" | "pro") — caps daily applications (10 vs 30)
├─ status (active | suspended)
├─ slackConnected, internshalaConnected (legacy)
│
├─ Profile (one-to-one)
│  ├─ preferredDomains (array: ["Web Dev", "Data Science"])
│  ├─ preferredLocations (array: ["Remote", "Bangalore"])
│  ├─ workMode ("any" | "remote" | "onsite")
│  ├─ experienceLevel ("student" | "fresher" | "1-2yr")
│  ├─ stipendMin (₹, 0+ = unpaid OK)
│  ├─ minMatchScore (0–100 firewall)
│  ├─ excludedCompanies (array)
│  └─ autoApply (boolean)
│
├─ Applications (many) — per-run job application record
│  ├─ id, createdAt
│  ├─ platform (linkedin | internshala | naukri | unstop | indeed)
│  ├─ jobId, jobTitle, company, location
│  ├─ matchScore (0–100)
│  ├─ status ("applied" | "skipped" | "failed")
│  └─ failureReason
│
├─ Reports (many) — daily run summaries
│  ├─ date
│  ├─ matched, applied, skipped, failed (counts)
│  └─ platforms (list of platforms agent touched)
│
└─ UserIntegration (many) — platform connection state
   ├─ platform (linkedin | internshala | naukri | unstop | indeed)
   ├─ status ("disconnected" | "connecting" | "connected" | "needs_login")
   ├─ connectedAt (timestamp or null)
   └─ updatedAt

Plan Caps (server-locked, not user-editable):
├─ Starter → 10 applications/day
└─ Pro → 30 applications/day
```

---

## Current UI Structure

### 1. **Auth Pages**
- `/login` — email + password
- `/signup` — email, password, name
- `/onboarding` — post-signup, post-payment flow

### 2. **Dashboard** (multi-tab interface)
Main tabs: **Profile** | **Integrations** | **Applications** | **Reports**

#### Tab: Profile
- Shows PROFF_FIELDS (8 profile questions)
- Targeting: domains, locations, workMode, experienceLevel
- Firewall: stipendMin, minMatchScore, excludedCompanies, autoApply
- Save → updates DB
- CTA: "Run live" (if integrations connected; disabled otherwise)

#### Tab: Integrations
- 5 platform cards in grid
- Each card shows: platform name, logo/icon, current status badge, connect/disconnect button
- Status states:
  - **Connected** (green) — agent can use this platform
  - **Needs login** (yellow) — session expired, reconnect required
  - **Connecting** (blue) — browser window open, waiting for user to log in
  - **Not connected** (gray) — available but not yet set up
- Header count: "Connected: 3/5"
- Warning banner if 0 connected: "Set up at least one platform to start"
- Click "Connect" → spawns headed browser → user logs in once → status flips to "Connected" on poll
- Click "Disconnect" → instant status flip to "Not connected"

#### Tab: Applications
- Table/list of recent 100 applications (newest first)
- Columns: Date, Platform, Job title, Company, Score, Status (applied/skipped/failed)
- Filters: platform, date range, status
- Sorting: date desc, score desc
- Search by company/job title
- Show "Applied: 45 | Skipped: 12 | Failed: 3" summary

#### Tab: Reports
- Calendar or timeline view of last 14 days
- Per-day card: date, summary (matched X, applied Y, skipped Z, failed W)
- Click day → see applications from that run
- Breakdown by platform for that day

### 3. **Header/Nav**
- Logo + branding (NexPath)
- Current plan badge (Starter | Pro)
- User profile icon (email, logout)

---

## Design Constraints & Considerations

### 1. **Plan Cap Enforcement**
- **Starter (10/day)** can see in profile but **cannot edit**
- Cap is server-locked at payment time
- Daily run applies up to N jobs across all connected sources
- UX note: don't surface "max per day" in editable profile fields

### 2. **Multi-Platform Orchestration**
- Agent runs once per day, allocates cap across sources proportionally
- If user has 3 platforms connected: ~3–4 jobs per platform
- If a platform's session expires mid-run: agent detects and flags "needs_login"
- UX note: show platform-specific "reconnect required" warning immediately

### 3. **Connection Flow (No Password Storage)**
- User clicks "Connect [Platform]" → browser window pops (headed Playwright)
- User logs in naturally, agent watches for success indicator
- No password ever touches NexPath backend
- Status polls every 2 sec for 5 min timeout
- UX note: show spinner + "Waiting for you to log in..." during connecting state

### 4. **Job Scoring & Filtering**
- Before applying: agent scores job vs. profile (0–100)
- If score < minMatchScore → skipped (user firewall)
- If no Easy Apply button → skipped (platform limitation)
- If auto-apply off → shown to user first (pending future UI)
- UX note: display score prominently; explain skips (e.g., "Score 42 < threshold 55")

### 5. **Session Expiry Handling**
- Any platform can drop to "needs_login" any time (user logged out elsewhere, cookie expired, etc.)
- Agent detects on next run: returns login_required flag
- DB updates status → dashboard shows yellow warning
- User clicks "Reconnect" → browser window pops again
- UX note: this can happen between runs, so integrations tab should always be accessible

### 6. **Bot Detection Mitigation**
- Agent uses per-user per-platform browser profiles (real cookies, realistic headers)
- Human-paced delays between actions
- No CAPTCHA handling (user can manually solve if needed during connect)
- UX note: don't add race conditions; keep "Run live" button available for manual triggers

### 7. **Pricing Model**
- Starter: ₹X/mo, 10 apps/day
- Pro: ₹Y/mo, 30 apps/day
- Both include all 5 platforms
- Payment via Stripe (integration pending)
- UX note: show plan type and cap on dashboard; allow plan upgrade/downgrade

---

## Key Metrics to Display

| Metric | Location | Purpose |
|--------|----------|---------|
| Connected platform count | Integrations tab header | Quick status check |
| Total applications (lifetime) | Dashboard stats | Engagement signal |
| Applied vs skipped vs failed | Applications tab / Reports | Quality metrics |
| Average match score | Stats sidebar | Profile tuning feedback |
| Daily run summary | Reports tab | Trend visibility |

---

## Design Goals

1. **Clarity over bells** — user should know:
   - Which platforms are ready
   - How many jobs agent will apply to today
   - What happened in last run (results, not just counts)
   - Why jobs were skipped

2. **Confidence in automation** — user should trust:
   - Agent won't break job application flow (e.g., multi-step modals handled)
   - Profile filters are honored
   - Session expiry is detected and surfaced
   - No personal data leaked

3. **Frictionless connection** — zero complexity:
   - One click → browser pops → log in once → done
   - Reconnection is same flow, repeated as needed
   - Disconnect is instant, no confirmation needed

4. **Mobile-friendly** — dashboard works on tablets/phones:
   - Integrations card grid stacks
   - Tables convert to card layout
   - CTA buttons always accessible

---

## Color / Status Semantics (Suggested)

- **Green** — Connected, ready to use, success
- **Yellow** — Needs action (needs login), warning
- **Blue** — In progress (connecting), neutral
- **Gray** — Inactive / unavailable / not set up
- **Red** — Failed, error (use sparingly)

---

## Tone & Messaging

- **Conversational, not robotic** — "Agent found 15 matches, applied to 8" not "8/15 jobs processed"
- **Action-oriented** — "Connect LinkedIn" not "Configure LinkedIn integration"
- **Empowering** — "You're all set" not "Configuration complete"
- **Honest on limitations** — "External-only roles skipped" not "Failed to apply"

---

## Next Steps for Claude Design

Give Claude Design this brief + ask for:

1. **Integrations tab redesign** — make 5 platforms feel cohesive + statuses clear
2. **Applications table** — sortable, filterable, score-prominent
3. **Reports visualization** — daily trend chart or timeline
4. **Profile form UX** — grouped sections (Targeting vs Firewall), help text integrated
5. **Status alerts** — where/how to surface "needs_login", "no platforms connected", etc.
6. **Mobile adaptation** — how tabs, grids, tables reflow

---

## File References

- **Frontend:** `src/app/dashboard/page.tsx` (main dashboard, 800+ lines)
- **API routes:** `src/app/api/integrations/` (connect, disconnect, status)
- **Schema:** `prisma/schema.prisma` (User, Profile, Application, Report, UserIntegration models)
- **Config:** `src/lib/proffQuestions.ts` (PROFF_FIELDS, DEFAULTS)
- **Agent logic:** `agent/worker.py` (daily run orchestration, allocation, scoring)
