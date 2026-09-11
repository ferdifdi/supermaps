"""Precompute K-UC1 (TOD dashboard) station indicators to static JSON, one file per
mode, so the live dashboard endpoint can eventually load from disk instead of
recomputing every request. Each station currently needs several live Overpass round-
trips inside station_indicators() (roads, residential/green/parking POI, routes) plus
always-live safety/information/transit POI (no static equivalent exists for those).

Output is the RAW per-station indicators only (station_indicators()'s own dict shape:
station/station_id/mode_label/lon/lat/raw) - NOT the cross-station-normalized SCI/rank/
criteria/typology, since those depend on which stations end up in the same comparison
batch (tod_index() normalizes relative to whatever list it's given) and that decision
still belongs to whoever consumes this cache, not to this one-off generation script.
tod_index() itself is pure, fast, in-memory Python (no Overpass) - only the raw-indicator
gathering below is worth caching.

TJ is out of scope for K-UC1 entirely (removed as a selectable dashboard mode - see
frontend/src/tod.js's MODES) - thousands of halte made a full-mode scan far slower than
KRL/MRT/LRT for comparatively little TOD-dashboard value, so this script only ever
generates those three.

Run when the network to Overpass is actually up (same caveat as warm_cache.py - public
instances have blocklisted this project's IP before under load). Produces the JSON files
below, which nothing currently loads automatically (wiring the dashboard endpoint to
prefer this cache over a live scan is a separate follow-up, not done here since you said
you'd run this yourself first and look at the output).

    python generate_kuc1_static.py [modes]        # default: KRL,MRT,LRT
    python generate_kuc1_static.py MRT            # just one mode
"""

import asyncio
import json
import sys
from pathlib import Path

from app import analysis
from app import main as backend_main

OUT_DIR = Path(__file__).parent / "data" / "k-uc1"


async def _stations_for(mode: str) -> list[dict]:
    all_rail = await backend_main._rail_stations()
    return [s for s in all_rail if s["mode_label"] == mode]


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
    path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved {len(results)}/{len(stations)} stations to {path}")
    if failed:
        print(f"Failed ({len(failed)}, retry later): {', '.join(failed)}")


async def main():
    modes = (sys.argv[1] if len(sys.argv) > 1 else "KRL,MRT,LRT").split(",")
    for mode in modes:
        await generate(mode.strip().upper())


if __name__ == "__main__":
    asyncio.run(main())
