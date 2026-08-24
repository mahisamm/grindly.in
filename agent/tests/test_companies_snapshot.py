"""`src/lib/companyPacks.json` must equal what the agent would say.

The landing page and the workspace read the company packs from that committed
snapshot instead of spawning Python (see src/lib/companyPacks.ts for why). A
snapshot that drifts from `agent/companies.py` would show one list on the
landing page and tailor to another — this pins them equal and says how to fix
it when they are not.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SNAPSHOT = os.path.join(ROOT, "src", "lib", "companyPacks.json")
REGENERATE = "python scripts/export_company_packs.py"


def test_the_committed_snapshot_matches_the_agent():
    import companies

    with open(SNAPSHOT, encoding="utf-8") as handle:
        snapshot = json.load(handle)
    expected = {"packs": companies.list_packs(), "disclaimer": companies.DISCLAIMER}
    assert snapshot == expected, (
        f"src/lib/companyPacks.json is out of date with agent/companies.py — run `{REGENERATE}`"
    )
    # Every pack has the shape the TypeScript side types it as.
    for pack in snapshot["packs"]:
        assert set(pack) >= {"slug", "name", "summary", "emphasis", "keywords", "sources", "best_for"}, pack["slug"]
        assert pack["slug"] and pack["name"]
