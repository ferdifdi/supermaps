"""Precompute K-UC1 (TOD dashboard) station indicators to static JSON, one file per
mode, so the live dashboard endpoint can eventually load from disk instead of
recomputing every request. Each station currently needs several live Overpass round-
trips inside station_indicators() (roads, residential/green/parking POI, routes) plus
always-live safety/information/transit POI (no static equivalent exists for those) - for
a full-mode scan (K-UC1's own comment: "this scans ALL stations of one mode at once,
possibly thousands for TJ") that's the single slowest thing in the whole app.

Output is the RAW per-station indicators only (station_indicators()'s own dict shape:
station/station_id/mode_label/lon/lat/raw) - NOT the cross-station-normalized SCI/rank/
criteria/typology, since those depend on which stations end up in the same comparison
batch (tod_index() normalizes relative to whatever list it's given) and that decision
still belongs to whoever consumes this cache, not to this one-off generation script.
tod_index() itself is pure, fast, in-memory Python (no Overpass) - only the raw-indicator
gathering below is worth caching.

TJ note - "cukup BRT aja": TransJakarta's GTFS feed has ~2876 halte across the 3 route
categories this project includes (Angkutan Umum Integrasi/BRT/Transjabodetabek, see
app/gtfs.py's INCLUDED_ROUTE_CATEGORIES). Only the "BRT" category (~535 halte, route_desc
== "BRT" in routes.txt - the actual numbered busway corridors) is processed here. The
other two categories (feeder minibus integration routes, intercity express) would by far
dominate the station count for comparatively little "is this a TOD-relevant transit hub"
signal beyond the corridors themselves - _tj_brt_stations() below re-reads the GTFS zip
independently (routes.txt -> trips.txt -> stop_times.txt -> stops.txt) rather than
touching app/gtfs.py's shared in-memory state, so this script can't affect the live app's
own GTFS-derived headway data.

Run when the network to Overpass is actually up (same caveat as warm_cache.py - public
instances have blocklisted this project's IP before under load). This does NOT write
into app/gtfs.py's cache or touch anything the live app reads while running - only
produces the JSON files below, which nothing currently loads automatically (wiring the
dashboard endpoint to prefer this cache over a live scan is a separate follow-up, not
done here since you said you'd run this yourself first and look at the output).

    python generate_kuc1_static.py [modes]        # default: KRL,MRT,LRT,TJ
    python generate_kuc1_static.py TJ             # just one mode
"""

import asyncio
import csv
import io
import json
import sys
import zipfile
from pathlib import Path

from app import analysis
from app import main as backend_main

GTFS_ZIP = Path(__file__).parent / "data" / "gtfs" / "transjakarta.zip"
OUT_DIR = Path(__file__).parent / "data" / "k-uc1"


def _tj_brt_stations() -> list[dict]:
    """Same {id, name, mode_label, operator, lon, lat} shape as main.py's
    _tj_stations(), but limited to route_desc == "BRT" trips only (see module
    docstring). Reads the GTFS zip directly - independent of app/gtfs.py's own
    already-loaded, differently-filtered in-memory state."""
    with zipfile.ZipFile(GTFS_ZIP) as z:
        def read(name):
            with z.open(name) as f:
                return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")))

        routes = read("routes.txt")
        brt_route_ids = {r["route_id"] for r in routes if r.get("route_desc") == "BRT"}
        print(f"  {len(brt_route_ids)} BRT routes (of {len(routes)} total)")

        trips = read("trips.txt")
        brt_trip_ids = {t["trip_id"] for t in trips if t["route_id"] in brt_route_ids}

        stop_times = read("stop_times.txt")
        brt_stop_ids = {st["stop_id"] for st in stop_times if st["trip_id"] in brt_trip_ids}

        stops = read("stops.txt")
        stations = [
            {
                "id": f"gtfs:{s['stop_id']}", "name": s["stop_name"], "mode_label": "TJ",
                "operator": "TransJakarta",
                "lon": float(s["stop_lon"]), "lat": float(s["stop_lat"]),
            }
            for s in stops if s["stop_id"] in brt_stop_ids
        ]
        print(f"  {len(stations)} BRT halte (of {len(stops)} total stops in feed)")
        return stations


async def _stations_for(mode: str) -> list[dict]:
    if mode == "TJ":
        return _tj_brt_stations()
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
    modes = (sys.argv[1] if len(sys.argv) > 1 else "KRL,MRT,LRT,TJ").split(",")
    for mode in modes:
        await generate(mode.strip().upper())


if __name__ == "__main__":
    asyncio.run(main())
