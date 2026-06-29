# Grindly Database Schema

## ER Diagram

```
User (1) ──→ (1) Profile
  │
  ├─→ (N) Application
  │
  ├─→ (N) Report
  │
  └─→ (N) UserIntegration

Job (1) ──→ (N) Application
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
| `status` | String | "matched" \| "applied" \| "skipped" \| "failed" |
| `reason` | String? | Why matched / skipped / failed |
| `applied_at` | DateTime? | When actually applied (if status=applied) |
| `created_at` | DateTime | Record creation timestamp |

**Relations:**
- Belongs to User (cascade delete)
- Belongs to Job (optional, nullable)

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

## Indexes (SQLite)

Default Prisma indexes:
- `users.email` (unique)
- `user_integrations.userId_platform` (unique)
- `jobs.source_externalId` (unique)
- Foreign key columns for query performance

Optional (not yet added):
- `applications.userId, status` — dashboard filters
- `applications.createdAt DESC` — recent apps sorting
- `reports.userId, date DESC` — daily reports lookup

---

## Unused / Deprecated Fields

- `profiles.max_per_day` — kept for backward compatibility, **not** used for plan enforcement
- `users.internshala_connected` — legacy, kept for fallback; new code uses `user_integrations` table
- `applications.job_id` — optional; mostly for archive/audit purposes
