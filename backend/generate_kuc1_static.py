"""Precompute K-UC1 (TOD dashboard) station indicators to static JSON, one file per
mode, so the live dashboard endpoint loads from disk instead of recomputing every
request (see app/main.py's tod_dashboard(), which reads these same files back). Each
station needs several live Overpass round-trips inside station_indicators() (roads,
residential/green/parking POI, routes) plus always-live safety/information/transit POI
(no static equivalent exists for those).

Output per mode: backend/data/k-uc1/{mode}.json, shaped
{"generated_at": "<ISO 8601 date>", "stations": [station_indicators() dicts]} - the RAW
per-station indicators only (station/station_id/mode_label/lon/lat/raw), NOT the
cross-station-normalized SCI/rank/criteria/typology, since those depend on which
stations end up in the same comparison batch (tod_index() normalizes relative to
whatever list it's given) and that decision belongs to the endpoint consuming this
cache, not to this generation script. tod_index() itself is pure, fast, in-memory Python
(no Overpass) - only the raw-indicator gathering below is worth caching. generated_at is
surfaced back through /api/analysis/tod-dashboard's metadata so the frontend's info panel
can say when each mode's static data was last generated.

TJ is out of scope for K-UC1 entirely (removed as a selectable dashboard mode - see
frontend/src/tod.js's MODES) - thousands of halte made a full-mode scan far slower than
KRL/MRT/LRT for comparatively little TOD-dashboard value, so this script only ever
generates those three.

The 4 Jakarta Airport Skytrain stations (Bandara Soekarno-Hatta + Terminal 1/2/3) are
excluded from LRT - OSM tags them railway=light_rail same as LRT Jabodebek, but it's a
separate airport people-mover system (see app/main.py's _KUC1_EXCLUDED_LRT_IDS, reused
here so both stay in sync).

Run when the network to Overpass is actually up (same caveat as warm_cache.py - public
instances have blocklisted this project's IP before under load).

    python generate_kuc1_static.py [modes]        # default: KRL,MRT,LRT
    python generate_kuc1_static.py MRT            # just one mode
"""

import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from app import analysis
from app import main as backend_main

OUT_DIR = Path(__file__).parent / "data" / "k-uc1"


async def _stations_for(mode: str) -> list[dict]:
    all_rail = await backend_main._rail_stations()
    return [
        s for s in all_rail
        if s["mode_label"] == mode and s["id"] not in backend_main._KUC1_EXCLUDED_LRT_IDS
    ]


async def generate(mode: str):
    print(f"\n=== {mode} ===")
    stations = await _stations_for(mode)
    print(f"{len(stations)} stations to process")

    results = []
    failed = []
    for i, station in enumerate(stations, 1):
        try:
            r = await analysis.station_indicators(station)
            results.append(r)
            print(f"[{mode} {i}/{len(stations)}] ok: {station['name']}")
        except Exception as e:
            failed.append(station["name"])
            print(f"[{mode} {i}/{len(stations)}] FAILED: {station['name']} ({e})")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{mode.lower()}.json"
    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "stations": results,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved {len(results)}/{len(stations)} stations to {path}")
    if failed:
        print(f"Failed ({len(failed)}, retry later): {', '.join(failed)}")


async def main():
    modes = (sys.argv[1] if len(sys.argv) > 1 else "KRL,MRT,LRT").split(",")
    for mode in modes:
        await generate(mode.strip().upper())


if __name__ == "__main__":
    asyncio.run(main())
