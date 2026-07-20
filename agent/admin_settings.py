"""Reads the same data/admin-settings.json the web admin panel writes.

Both the web and worker containers mount the shared `appdata` volume at
/app/data (see docker-compose.yml), and the web app writes settings to
`<cwd>/data/admin-settings.json` = /app/data/admin-settings.json — so this
reads the identical file, no IPC needed. Best-effort: any read/parse failure
is treated as "no override" rather than blocking the worker.
"""
from __future__ import annotations

import json
import os


def _settings_path() -> str:
    base = os.environ.get("GRINDLY_PROFILE_BASE", "")
    if base:
        return os.path.join(os.path.dirname(os.path.normpath(base)), "admin-settings.json")
    return os.path.join(os.path.dirname(__file__), "..", "data", "admin-settings.json")


def read_admin_settings() -> dict:
    try:
        with open(_settings_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def maintenance_mode() -> bool:
    return bool(read_admin_settings().get("maintenanceMode", False))
