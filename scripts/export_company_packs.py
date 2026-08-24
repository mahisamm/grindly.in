"""Regenerate src/lib/companyPacks.json from agent/companies.py.

    python scripts/export_company_packs.py

Run it after editing a company pack; agent/tests/test_companies_snapshot.py
fails until the snapshot matches. See src/lib/companyPacks.ts for why the
snapshot exists.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "agent"))

import companies  # noqa: E402

OUT = os.path.join(ROOT, "src", "lib", "companyPacks.json")
snapshot = {"packs": companies.list_packs(), "disclaimer": companies.DISCLAIMER}
with open(OUT, "w", encoding="utf-8", newline="\n") as handle:
    handle.write(json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n")
print(f"wrote {len(snapshot['packs'])} packs to {os.path.relpath(OUT, ROOT)}")
