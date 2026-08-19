"""POI ruang hijau buat stasiun KRL: pohon individual, taman/kebun/hutan kota, tempat
berteduh (shelter) - dalam 800m dari tiap stasiun KRL, biar backend gak perlu manggil
osm.trees()/osm.pois() live tiap kali M-UC1 "Kenyamanan" tab dibuka.

Install dulu (sekali saja): pip install -r requirements.txt

Jalankan: python poi_green_krl.py
Output: poi_green_krl_800m.geojson (folder yang sama dengan script ini)

Tiap fitur punya properti "kind": "tree" (titik pohon), "green_area" (park/garden/forest/
leisure hijau lainnya - polygon atau titik tergantung cara OSM-nya digambar), "shelter"
(tempat berteduh beratap).

Butuh koneksi internet (Overpass API). Progress disimpan checkpoint di
poi_green_krl_work.json - kalau ke-stop/gagal di tengah jalan, jalankan lagi
`python poi_green_krl.py`, otomatis lanjut dari stasiun yang belum selesai.
"""

import asyncio
import json
import sys
from pathlib import Path

from shapely.geometry import Point

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from app import gtfs, osm  # noqa: E402
from app.geo import to_m  # noqa: E402

MODE = "KRL"
RADIUS_M = 800
OUT_DIR = Path(__file__).resolve().parent
WORK_FILE = OUT_DIR / "poi_green_krl_work.json"
OUTPUT_FILE = OUT_DIR / "poi_green_krl_800m.geojson"
FAILED_FILE = OUT_DIR / "poi_green_krl_800m_failed.txt"
CHECKPOINT_EVERY = 30

THIN_CELL_M = 500  # < RADIUS_M so a dropped station's 800m circle is still ~fully
# covered by the kept representative's circle (worst-case corner-to-corner gap in a
# 500m grid cell is ~707m, comfortably under 800m).


def thin_stations(stations: list[dict]) -> list[dict]:
    """Keeps at most one station per THIN_CELL_M x THIN_CELL_M metric grid cell. Matters
    most for TJ (own script, ~8091 halte often 300-500m apart along a corridor) but kept
    uniform across every mode's script - harmless no-op when stations are already spaced
    out (MRT/KRL/LRT), real savings where they aren't. Dropped stations' walk-shed is
    still covered by a kept neighbor's circle, so this doesn't lose meaningful coverage,
    just redundant queries."""
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


async def target_stations() -> list[dict]:
    """KRL stations (OSM) - TJ (this project's poi_green_tj.py) is the only mode sourced
    from GTFS instead, since OSM's TJ-tagged nodes are unreliable (see osm.py's
    mode_label() docstring)."""
    if MODE == "TJ":
        gtfs._load()
        stations = [
            {"id": f"gtfs:{sid}", "name": s["name"], "lon": s["lon"], "lat": s["lat"]}
            for sid, s in gtfs._stops.items()
        ]
    else:
        stations = [s for s in await osm.stations() if s["mode_label"] == MODE]
    return thin_stations(stations)


async def fetch_green(lon: float, lat: float, radius: int) -> list[dict]:
    """Pohon individual, area hijau (taman/kebun/hutan kota/rekreasi), dan tempat
    berteduh - satu query gabungan biar hemat panggilan Overpass per stasiun."""
    q = f"""
    [out:json][timeout:25];
    (
      node["natural"="tree"](around:{radius},{lat},{lon});
      way["leisure"~"park|garden|nature_reserve"](around:{radius},{lat},{lon});
      way["landuse"~"forest|grass|meadow|recreation_ground"](around:{radius},{lat},{lon});
      node["leisure"~"park|garden|nature_reserve"](around:{radius},{lat},{lon});
      node["amenity"="shelter"](around:{radius},{lat},{lon});
      way["amenity"="shelter"](around:{radius},{lat},{lon});
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
        if tags.get("natural") == "tree":
            kind = "tree"
        elif tags.get("amenity") == "shelter":
            kind = "shelter"
        else:
            kind = "green_area"
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
    stations = await target_stations()
    print(f"{len(stations)} stasiun {MODE} (setelah thinning grid {THIN_CELL_M}m).")

    points_by_key, done_ids = load_checkpoint()
    remaining = [s for s in stations if s["id"] not in done_ids]
    print(f"{len(done_ids)} sudah selesai sebelumnya (checkpoint), {len(remaining)} sisa diproses.")

    failed = []
    for i, s in enumerate(remaining):
        try:
            found = await fetch_green(s["lon"], s["lat"], RADIUS_M)
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

    print(f"\nSELESAI. {len(points_by_key)} titik ruang hijau ditulis ke {OUTPUT_FILE}")
    if failed:
        print(f"{len(failed)} stasiun gagal, lihat {FAILED_FILE.name} - jalankan lagi script ini buat retry.")


if __name__ == "__main__":
    asyncio.run(main())
