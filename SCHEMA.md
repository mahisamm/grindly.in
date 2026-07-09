# Grindly Database Schema

## ER Diagram

```
User (1) ──→ (1) Profile
  │
  ├─→ (N) Application ──→ (1) ResumeVersion (optional snapshot)
  │        └─→ (1) Job (optional)
  │
  ├─→ (N) Report
  ├─→ (N) UserIntegration
  ├─→ (N) ResumeVersion
  ├─→ (N) AuditLog
  ├─→ (N) Notification
  ├─→ (N) AgentRun
  └─→ (N) PlatformCredential
```

---

## Tables

### `users`
User accounts + billing + platform connection state.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (cuid) | Primary key |
| `email` | String | Unique, login credential |
| `name` | String? | Optional |
| `password_hash` | String? | Hashed password |
| `created_at` | DateTime | Account creation |
| `paid` | Boolean | Has active subscription? |
| `plan` | String | "free" \| "starter" \| "pro" — plan cap locked |
| `slack_user_id` | String? | Slack integration (stubbed) |
| `slack_channel` | String? | Slack integration (stubbed) |
| `slack_connected` | Boolean | Slack notification enabled? |
| `internshala_connected` | Boolean | Legacy — use UserIntegration table |
| `status` | String | "registered" \| "onboarding" \| "active" \| "paused" |

**Relations:**
- Has one Profile (1:1, cascade delete)
- Has many Applications (1:N, cascade delete)
- Has many Reports (1:N, cascade delete)
- Has many UserIntegrations (1:N, cascade delete)

---

### `profiles`
User preferences, firewall rules, and profile data (resume, skills).

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (cuid) | Primary key |
| `user_id` | String (FK) | Unique per user |
| `resume_text` | String? | Plain text resume |
| `resume_name` | String? | File name of resume |
| `skills` | String (JSON) | Array extracted from resume |
| `education` | String? | Education background |
| `experience_level` | String? | "student" \| "fresher" \| "1-2yr" |
| **Targeting** |
| `preferred_domains` | String (JSON) | ["Web Dev", "Data Science", ...] |
| `preferred_locations` | String (JSON) | ["Remote", "Bangalore", ...] |
| `work_mode` | String | "any" \| "remote" \| "onsite" |
| **Firewall** |
| `stipend_min` | Integer | Min monthly stipend (₹); 0 = unpaid OK |
| `max_per_day` | Integer | **DEPRECATED** — use plan cap from users.plan |
| `min_match_score` | Integer | 0–100 threshold (default 55) |
| `excluded_companies` | String (JSON) | ["Acme Corp", ...] |
| `auto_apply` | Boolean | Auto-submit or ask first? |
| **Generated** |
| `plan_json` | String? | Agent-generated application plan |
| `updated_at` | DateTime | Last modified |

**Relations:**
- Belongs to User (1:1, cascade delete)

---

### `user_integrations`
Platform connection state per user per platform.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (cuid) | Primary key |
| `user_id` | String (FK) | Composite key (user, platform) |
| `platform` | String | "linkedin" \| "internshala" \| "naukri" \| "unstop" \| "indeed" |
| `status` | String | "disconnected" \| "connected" \| "connecting" \| "needs_login" |
| `connected_at` | DateTime? | Timestamp of successful login (null if disconnected) |
| `updated_at` | DateTime | Last status change |

**Constraints:**
- Unique (user_id, platform) — one integration record per user per platform
- Cascade delete on user deletion

**Relations:**
- Belongs to User (FK user_id)

---

### `applications`
Per-run job application attempt (matched, applied, skipped, or failed).

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (cuid) | Primary key |
| `user_id` | String (FK) | Which user attempted |
| `job_id` | String (FK)? | Reference to Job (optional) |
| `job_title` | String | Job title (denormalized, copied) |
| `company` | String | Company name |
| `url` | String? | Job listing URL |
| `match_score` | Integer | 0–100 agent scoring |
| `status` | ApplyStatus | matched \| approved \| submitting \| applied \| skipped \| failed \| needs_review |
| `reason` | String? | Why matched / skipped / failed (free text) |
| `failure_reason` | FailureReason? | Machine reason on failure — see [src/lib/applyState.ts](src/lib/applyState.ts) |
| `screenshot_path` | String? | Proof image of the submit attempt |
| `resume_version_id` | String (FK)? | Exact ResumeVersion sent for this application |
| `applied_at` | DateTime? | When actually applied (if status=applied) |
| `outcome` | Outcome? | interview \| offer \| rejected \| no_response (user-reported) |
| `outcome_at` | DateTime? | When the outcome was reported |
| `created_at` | DateTime | Record creation timestamp |

**Relations:**
- Belongs to User (cascade delete)
- Belongs to Job (optional, nullable)
- Belongs to ResumeVersion (optional, nullable)

**Indexes:** `userId`, `[userId, status]`, `status`, `jobId`, `resumeVersionId`, `createdAt` — this is the most-queried table (dashboard, admin overview, per-platform fail-rate stats), so every common filter/sort column is indexed.

**Denormalization:** job_title, company, url are copied from Job table for query speed and archive purposes.

---

### `jobs`
Master job listing (indexed by source + external ID, not regenerated per user).

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (cuid) | Primary key |
| `source` | String | "internshala" \| "linkedin" \| "naukri" \| "unstop" \| "indeed" |
| `external_id` | String | Platform-specific job ID |
| `title` | String | Job title |
| `company` | String | Company name |
| `location` | String? | Job location |
| `stipend` | String? | Stipend range (e.g., "₹10,000–15,000") |
| `duration` | String? | Internship duration (e.g., "6 months") |
| `skills` | String (JSON) | ["Python", "React", ...] |
| `url` | String | Job listing URL |
| `scraped_at` | DateTime | When agent fetched this |

**Constraints:**
- Unique (source, external_id) — no duplicates per platform

**Relations:**
- Has many Applications (1:N)

---

### `reports`
Daily run summary sent to user (Slack, email, or dashboard).

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (cuid) | Primary key |
| `user_id` | String (FK) | Which user's run |
| `date` | String | "YYYY-MM-DD" run date |
| `matched_count` | Integer | Jobs matched by scoring |
| `applied_count` | Integer | Jobs successfully applied |
| `failed_count` | Integer | Jobs failed to apply |
| `summary` | String | Human-readable summary |
| `delivered` | Boolean | Was Slack notification sent? |
| `created_at` | DateTime | Report generated at |

**Relations:**
- Belongs to User (cascade delete)

---

### `resume_versions`
Immutable snapshot of the exact resume sent for one application — answers "which resume did the recruiter see?" Never mutated after create.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (cuid) | Primary key |
| `user_id` | String (FK) | Owner |
| `label` | String | Human label, e.g. "Frontend Dev @ Razorpay" |
| `job_title` / `company` | String? | Target role context |
| `text` | String | Exact tailored resume text sent |
| `file_path` | String? | Path to the exact PDF sent |
| `skills_claimed` | String (JSON) | Skills surfaced for this specific role |
| `base_skills` | String (JSON) | Master skills at time of send (truthfulness reference — see `agent/resume_ai.py`) |
| `created_at` | DateTime | Creation timestamp |

**Relations:** Belongs to User (cascade delete); has many Applications. **Index:** `userId`.

---

### `audit_logs`
Append-only audit trail — reconstruct what auth/agent did, for disputes.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (cuid) | Primary key |
| `user_id` | String (FK)? | Nullable — some events are pre-auth |
| `action` | String | login \| otp_issued \| otp_throttled \| apply \| apply_failed \| firewall_block \| session_expired \| consent \| high_failure_rate \| ... |
| `target` | String? | Job URL / platform / phone-mask / etc |
| `detail` | String? | Freeform or JSON |
| `created_at` | DateTime | Event timestamp |

**Indexes:** `userId`, `action`.

---

### `agent_runs`
DB-backed run queue — gives retries, per-user locking, and idempotent resume without needing Redis. `worker.py --serve`/`--drain` claims queued rows transactionally.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (cuid) | Primary key |
| `user_id` | String (FK) | Owner |
| `mode` | RunMode | mock \| live \| analyze |
| `status` | RunStatus | queued \| running \| done \| failed \| cancelled |
| `attempts` / `max_attempts` | Integer | Retry bookkeeping (default max 3) |
| `locked_by` / `locked_at` | String? / DateTime? | Worker instance holding the row |
| `error` | String? | Failure detail |
| `result` | String? | JSON `{applied,matched,failed}` |
| `created_at` / `updated_at` | DateTime | |

**Indexes:** `status`, `userId`.

---

### `platform_credentials`
Encrypted-at-rest platform credentials. Plaintext is **never** stored — ciphertext is AES-256-GCM (`src/lib/crypto.ts` / `agent/secret_box.py`).

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (cuid) | Primary key |
| `user_id` | String (FK) | Owner |
| `platform` | String | Platform name (includes "gmail" for the Gmail OAuth refresh token, in addition to the 5 apply platforms) |
| `ciphertext` | String | `base64(nonce).base64(ciphertext+tag)` |
| `updated_at` | DateTime | |

**Constraints:** unique `(userId, platform)`.

---

### `notifications`, `otp_tokens`, `otp_attempts`, `password_reset_tokens`, `rate_limit_entries`
Supporting tables for delivery tracking and DB-backed (multi-instance-safe) counters that replaced in-process `Map`s:

- **`notifications`** — tiered notification log (`tier`: urgent \| digest; `channel`: slack \| email \| console), indexed on `userId`.
- **`otp_tokens`** — phone OTP codes with expiry, indexed on `phone`.
- **`otp_attempts`** — brute-force counter per phone (`OtpAttempt`), unique + indexed on `phone`.
- **`password_reset_tokens`** — 15-minute single-use tokens, unique `tokenHash`, indexed on `userId`.
- **`rate_limit_entries`** — generic rate-limit counters keyed `"forgot:<ip>"` / `"otp:<phone>"` / etc, unique + indexed on `key`.

---

## API Field Mapping

### User Response (`GET /api/me`)
```json
{
  "user": {
    "id": "cuid",
    "email": "user@example.com",
    "name": "John Doe",
    "paid": true,
    "plan": "pro",
    "status": "active",
    "slackConnected": false,
    "internshalaConnected": false
  },
  "profile": {
    "preferredDomains": ["Web Dev"],
    "preferredLocations": ["Remote"],
    "workMode": "remote",
    "experienceLevel": "student",
    "stipendMin": 5000,
    "minMatchScore": 55,
    "excludedCompanies": [],
    "autoApply": true
  },
  "applications": [
    {
      "id": "cuid",
      "jobTitle": "Frontend Intern",
      "company": "TechCorp",
      "matchScore": 85,
      "status": "applied",
      "createdAt": "2026-06-17T10:30:00Z"
    }
  ],
  "reports": [
    {
      "date": "2026-06-17",
      "matchedCount": 15,
      "appliedCount": 8,
      "failedCount": 0
    }
  ],
  "integrations": [
    {
      "platform": "linkedin",
      "status": "connected",
      "connectedAt": "2026-06-15T14:22:00Z"
    },
    {
      "platform": "internshala",
      "status": "needs_login",
      "connectedAt": null
    }
  ],
  "stats": {
    "matched": 45,
    "applied": 32,
    "skipped": 10,
    "failed": 3,
    "avgScore": 72
  }
}
```

---

## Key Constraints & Patterns

### Plan Caps (Server-Locked)
- `Starter plan` → 10 applications/day (can't edit via profile form)
- `Pro plan` → 30 applications/day (can't edit via profile form)
- Read from `users.plan` column, not `profiles.max_per_day`
- Python agent checks `get_plan_cap(uid)` from `agent/db.py`

### Multi-Source Job Allocation
- Agent fetches jobs from 5 sources in priority order: LinkedIn → Internshala → Naukri → Unstop → Indeed
- Allocates plan cap across sources (e.g., 10 cap / 3 sources ≈ 3–4 per source)
- Each source module stores state in per-user per-platform browser profile: `agent/browser_profile/{uid}/{platform}/`

### Integration Status States
- `disconnected` — user clicked disconnect or never connected
- `connected` — user logged in via headed browser, session active
- `connecting` — browser window open, waiting for login (poll every 2s for 5m)
- `needs_login` — agent detected session expired during run, user must reconnect

### Fallback for Pre-Migration
- If `user_integrations` table doesn't exist yet, API endpoints gracefully catch errors
- Dashboard shows legacy `users.internshala_connected` as fallback for Internshala status
- Python agent calls `_ensure_integrations_table(c)` on startup

---

## Enums (native Postgres enums)

`status`/`role`/`plan`/`platform`/etc used to be bare `String` columns with the
valid value set only documented in comments — nothing stopped a typo'd value
from being written. They're now real Prisma/Postgres enums, verified against
actual read/write call sites in `src/` and `agent/` (not just doc comments):
`Role`, `PlanTier`, `UserStatus`, `Platform`, `IntegrationStatus`,
`ApplyStatus`, `FailureReason`, `Outcome`, `RunMode`, `RunStatus`. See
`prisma/schema.prisma` for the exact member lists. `ApplyStatus` and
`FailureReason` are mirrored with the Python agent via
`src/lib/applyState.ts` ↔ `agent/safety.py` — keep both in sync if the set
ever changes.

## Indexes (Postgres)

Postgres does **not** auto-index foreign-key columns — every FK below is
explicitly indexed, not just the default unique constraints:
- `users.email`, `users.googleId`, `users.phone` (unique)
- `user_integrations.(userId, platform)` (unique)
- `platform_credentials.(userId, platform)` (unique)
- `jobs.(source, externalId)` (unique)
- `applications.userId`, `applications.(userId, status)`, `applications.status`,
  `applications.jobId`, `applications.resumeVersionId`, `applications.createdAt`
- `resume_versions.userId`, `audit_logs.userId`, `audit_logs.action`,
  `agent_runs.status`, `agent_runs.userId`, `notifications.userId`
- `otp_tokens.phone`, `otp_attempts.phone` (unique), `password_reset_tokens.userId`,
  `password_reset_tokens.tokenHash` (unique), `rate_limit_entries.key` (unique)

No `prisma/migrations/` history exists yet — schema changes are applied via
`prisma db push` (see `docker-compose.yml`'s `migrate` service and
`prisma/MIGRATE_POSTGRES.md`). Baselining a real migration history against
the live prod DB is a manual follow-up, not something to generate blind
against an unknown prod state.

---

## Unused / Deprecated Fields

- `profiles.max_per_day` — kept for backward compatibility, **not** used for plan enforcement
- `users.internshala_connected` — legacy, kept for fallback; new code uses `user_integrations` table
- `applications.job_id` — optional; mostly for archive/audit purposes
