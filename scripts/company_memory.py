#!/usr/bin/env python3
"""Company memory: one cached card per employer, reused across roles.

    .venv/bin/python scripts/company_memory.py --refresh
    .venv/bin/python scripts/company_memory.py --lookup "Vidyard"
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any

from jobsearch_lib import (
    COMPANIES_FILE,
    company_key,
    file_lock,
    load_positions,
    now_iso,
    read_json,
    write_json,
)


def empty_store() -> dict:
    return {"version": 1, "updated_at": now_iso(), "companies": []}


def load_store() -> dict:
    data = read_json(COMPANIES_FILE, default=empty_store())
    if not isinstance(data, dict):
        return empty_store()
    data.setdefault("companies", [])
    return data


def save_store(data: dict) -> None:
    data["updated_at"] = now_iso()
    write_json(COMPANIES_FILE, data)


def _clip_research(md: str | None) -> str | None:
    if not md:
        return None
    lines = []
    for line in md.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            continue
        lines.append(re.sub(r"^[-*]\s+", "", s))
        if len(" ".join(lines)) > 420:
            break
    text = " ".join(lines).strip()
    return text[:500] if text else None


def upsert(store: dict, record: dict) -> dict:
    key = record.get("key") or company_key(record.get("name") or "")
    record["key"] = key
    companies = store.setdefault("companies", [])
    existing = next((c for c in companies if c.get("key") == key), None)
    if existing is None:
        record.setdefault("added_at", now_iso())
        record["updated_at"] = now_iso()
        companies.append(record)
        return record
    for field in ("name", "website", "size", "funding", "summary", "sector"):
        incoming = record.get(field)
        if incoming and incoming != existing.get(field):
            existing[field] = incoming
    existing["updated_at"] = now_iso()
    return existing


def lookup(store: dict, name: str) -> dict | None:
    key = company_key(name)
    if not key:
        return None
    for row in store.get("companies") or []:
        if row.get("key") == key:
            return row
    # Loose: one token of the name equals the stored key.
    for row in store.get("companies") or []:
        if key in (row.get("key") or "") or (row.get("key") or "") in key:
            if abs(len(key) - len(row.get("key") or "")) <= 8:
                return row
    return None


def refresh_from_positions() -> dict:
    positions = load_positions().get("positions") or []
    store = load_store()
    by_key: dict[str, list[dict]] = {}
    for p in positions:
        name = p.get("company") or ""
        key = company_key(name)
        if not key:
            continue
        by_key.setdefault(key, []).append(p)

    for key, group in by_key.items():
        group.sort(key=lambda p: p.get("found_date") or "", reverse=True)
        latest = group[0]
        researched = next((p for p in group if p.get("research_md")), latest)
        size = next((p.get("company_size") for p in group if p.get("company_size")), None)
        funding = next(
            (p.get("company_funding") for p in group if p.get("company_funding")), None
        )
        website = next((p.get("company_url") for p in group if p.get("company_url")), None)
        upsert(
            store,
            {
                "key": key,
                "name": latest.get("company"),
                "website": website,
                "size": size,
                "funding": funding,
                "summary": _clip_research(researched.get("research_md")),
                "roles_seen": len(group),
            },
        )
    return store


def apply_to_position(position: dict, store: dict) -> dict[str, Any]:
    """Fill blank scoring chips from memory. Does not overwrite known values."""
    row = lookup(store, position.get("company") or "")
    filled = []
    if not row:
        return {"used": False, "filled": filled}
    if not position.get("company_url") and row.get("website"):
        position["company_url"] = row["website"]
        filled.append("company_url")
    if not position.get("company_size") and row.get("size"):
        position["company_size"] = row["size"]
        filled.append("company_size")
    if not position.get("company_funding") and row.get("funding"):
        position["company_funding"] = row["funding"]
        filled.append("company_funding")
    return {"used": True, "filled": filled, "summary": row.get("summary")}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--lookup")
    args = parser.parse_args()

    with file_lock():
        if args.lookup:
            store = load_store()
            row = lookup(store, args.lookup)
            print(json.dumps(row or {"error": "not found"}, indent=2, ensure_ascii=False))
            return 0 if row else 1
        store = refresh_from_positions()
        save_store(store)
        print(json.dumps({"companies": len(store["companies"])}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
