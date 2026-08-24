import snapshot from "./companyPacks.json";
import type { CompanyPack } from "./reportTypes";

/**
 * The curated company packs, without spawning the Python agent.
 *
 * `agent/companies.py` is the source of truth; this is a committed snapshot of
 * `list_packs()` and `DISCLAIMER`, pinned equal to it by
 * `agent/tests/test_companies_snapshot.py`. It exists because two pages read
 * the packs at times the agent cannot run: the landing page is prerendered at
 * build time (no interpreter in that stage — every deploy shipped a landing
 * page with the company section silently missing until the first
 * revalidation), and the workspace is loaded on every visit (a process spawn
 * per page view, degrading to an empty picker on any hiccup).
 *
 * Search and per-slug lookups still go through the agent; only the full list
 * is read here. Regenerate with `python scripts/export_company_packs.py`.
 */
export const COMPANY_PACKS: CompanyPack[] = snapshot.packs as CompanyPack[];
export const COMPANY_DISCLAIMER: string = snapshot.disclaimer;
