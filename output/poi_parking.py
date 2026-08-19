"""POI parkir (mobil + motor) - MAPID gak punya kategori parkir, jadi ini tetap OSM,
tapi didownload sekali jadi static dalam 800m dari SEMUA stasiun/halte (KRL+MRT+LRT+TJ
digabung satu list, dedup global) - biar backend gak perlu manggil osm.pois() live tiap
kali `car_parking`/`motorcycle_parking` (K-UC1) dihitung.

Install dulu (sekali saja): pip install -r requirements.txt

Jalankan: python poi_parking.py
Output: poi_parking_800m.geojson (folder yang sama dengan script ini)

Tiap fitur punya properti "kind": "car" (amenity=parking) atau "motorcycle"
(amenity=motorcycle_parking).

Butuh koneksi internet (Overpass API). Progress disimpan checkpoint di
poi_parking_work.json - kalau ke-stop/gagal di tengah jalan, jalankan lagi
`python poi_parking.py`, otomatis lanjut dari stasiun yang belum selesai.
"""

import asyncio
import json
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from shapely.geometry import Point  # noqa: E402

from app import gtfs, osm  # noqa: E402
from app.geo import to_m  # noqa: E402

RADIUS_M = 800
OUT_DIR = Path(__file__).resolve().parent
WORK_FILE = OUT_DIR / "poi_parking_work.json"
OUTPUT_FILE = OUT_DIR / "poi_parking_800m.geojson"
FAILED_FILE = OUT_DIR / "poi_parking_800m_failed.txt"
CHECKPOINT_EVERY = 30


THIN_CELL_M = 500  # < RADIUS_M so a dropped station's 800m circle is still ~fully
# covered by the kept representative's circle (worst-case corner-to-corner gap in a
# 500m grid cell is ~707m, comfortably under 800m).


def thin_stations(stations: list[dict]) -> list[dict]:
    """Keeps at most one station per THIN_CELL_M x THIN_CELL_M metric grid cell. Matters
    a LOT for TJ specifically - ~8091 halte, often 300-500m apart along a corridor, so
    querying every single one individually is mostly re-fetching the same parking spots
    over and over. Dropped stations' walk-shed is still covered by a kept neighbor's
    circle, so this doesn't lose meaningful coverage, just redundant queries."""
    seen_cells = set()
    kept = []
    for s in stations:
        p = to_m(Point(s["lon"], s["lat"]))
        cell = (round(p.x / THIN_CELL_M), round(p.y / THIN_CELL_M))
        if cell in seen_cells:
            continue
        seen_cells.add(cell)
        kept.append(s)
    return kept


async def all_target_stations() -> list[dict]:
    """KRL/MRT/LRT (OSM) + TJ (GTFS) - the same combined set used everywhere else
    stations are enumerated, so every mode's walk-shed gets covered once. Thinned (see
    thin_stations) before being returned - TJ's ~8091 halte would otherwise dominate the
    query count for almost no extra coverage."""
    stations = list(await osm.stations())
    gtfs._load()
    stations += [
        {"id": f"gtfs:{sid}", "name": s["name"], "lon": s["lon"], "lat": s["lat"]}
        for sid, s in gtfs._stops.items()
    ]
    return thin_stations(stations)


async def fetch_parking(lon: float, lat: float, radius: int) -> list[dict]:
    q = f"""
    [out:json][timeout:25];
    (
      node["amenity"="parking"](around:{radius},{lat},{lon});
      way["amenity"="parking"](around:{radius},{lat},{lon});
      node["amenity"="motorcycle_parking"](around:{radius},{lat},{lon});
      way["amenity"="motorcycle_parking"](around:{radius},{lat},{lon});
    );
    out center tags;
    """
    data = await osm.overpass(q)
    out = []
    for el in data["elements"]:
        tags = el.get("tags", {})
        lon_ = el.get("lon") if el["type"] == "node" else el.get("center", {}).get("lon")
        lat_ = el.get("lat") if el["type"] == "node" else el.get("center", {}).get("lat")
        if lon_ is None or lat_ is None:
            continue
        kind = "motorcycle" if tags.get("amenity") == "motorcycle_parking" else "car"
        out.append({
            "id": f"{el['type']}/{el['id']}", "kind": kind,
            "name": tags.get("name", ""), "lon": lon_, "lat": lat_,
        })
    return out


def load_checkpoint():
    if not WORK_FILE.exists():
        return {}, set()
    data = json.loads(WORK_FILE.read_text(encoding="utf-8"))
    return data["points"], set(data["done_station_ids"])


def save_checkpoint(points_by_key, done_ids):
    WORK_FILE.write_text(
        json.dumps({"points": points_by_key, "done_station_ids": list(done_ids)}, ensure_ascii=False),
        encoding="utf-8",
    )


def write_geojson(points_by_key):
    features = [{
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]},
        "properties": {"kind": p["kind"], "name": p["name"]},
    } for p in points_by_key.values()]
    OUTPUT_FILE.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False),
        encoding="utf-8",
    )


async def main():
    stations = await all_target_stations()
    print(f"{len(stations)} titik query setelah thinning (grid {THIN_CELL_M}m) - KRL+MRT+LRT+TJ digabung, TJ-nya sendiri ~8091 halte sebelum di-thin.")

    points_by_key, done_ids = load_checkpoint()
    remaining = [s for s in stations if s["id"] not in done_ids]
    print(f"{len(done_ids)} sudah selesai sebelumnya (checkpoint), {len(remaining)} sisa diproses.")

    failed = []
    for i, s in enumerate(remaining):
        try:
            found = await fetch_parking(s["lon"], s["lat"], RADIUS_M)
            for p in found:
                points_by_key[p["id"]] = p
            done_ids.add(s["id"])
        except Exception as e:
            failed.append(f"{s['name']} ({e})")

        print(f"[{len(done_ids)}/{len(stations)}] {s['name']} - {len(points_by_key)} titik terkumpul", flush=True)

        if (i + 1) % CHECKPOINT_EVERY == 0:
            save_checkpoint(points_by_key, done_ids)
            write_geojson(points_by_key)
            print("--- checkpoint disimpan ---", flush=True)

    save_checkpoint(points_by_key, done_ids)
    write_geojson(points_by_key)
    if failed:
        FAILED_FILE.write_text("\n".join(failed), encoding="utf-8")
    elif FAILED_FILE.exists():
        FAILED_FILE.unlink()

    print(f"\nSELESAI. {len(points_by_key)} titik parkir ditulis ke {OUTPUT_FILE}")
    if failed:
        print(f"{len(failed)} stasiun gagal, lihat {FAILED_FILE.name} - jalankan lagi script ini buat retry.")


if __name__ == "__main__":
    asyncio.run(main())
