"""One-time cache warm-up for the TOD dashboard.

Fetches every KRL/MRT/LRT station's roads/POIs/route data and caches it to disk,
one Overpass request at a time, so the deployed dashboard reads from cache instead
of hitting Overpass live (which gets IPs blocked under load - see commit 336350c).

Run when the network to Overpass is actually up, then commit backend/cache/.

    python warm_cache.py [modes]        # default: KRL,MRT,LRT
"""

import asyncio
import sys

from app import analysis, osm


async def main():
    modes = (sys.argv[1] if len(sys.argv) > 1 else "KRL,MRT,LRT").split(",")
    stations = [s for s in await osm.stations() if s["mode_label"] in modes]
    print(f"{len(stations)} stations to warm ({', '.join(modes)})")

    ok, failed = 0, []
    for i, station in enumerate(stations, 1):
        try:
            await analysis.station_indicators(station)
            ok += 1
            print(f"[{i}/{len(stations)}] ok: {station['name']}")
        except Exception as e:
            failed.append(station["name"])
            print(f"[{i}/{len(stations)}] FAILED: {station['name']} ({e})")

    print(f"\n{ok} warmed, {len(failed)} failed.")
    if failed:
        print("Failed stations (retry later):", ", ".join(failed))


if __name__ == "__main__":
    asyncio.run(main())
