"""POI bangunan residential (building=residential/apartments/house) buat stasiun KRL -
MAPID gak punya kategori perumahan/bangunan, jadi ini tetap OSM, didownload sekali jadi
static dalam 800m dari tiap stasiun KRL (bukan 800m kayak MRT/KRL/LRT - lihat
static_transit.MODE_RADIUS_M, TJ stasiun-nya jauh lebih rapat), biar backend gak perlu
manggil osm.pois() live tiap kali `population_density`/`residential_diversity` (K-UC1)
atau residential_mix (M-UC1 walk_score) dihitung.

Install dulu (sekali saja): pip install -r requirements.txt

Jalankan: python poi_residential_krl.py
Output: poi_residential_krl_800m.geojson (folder yang sama dengan script ini)

Tiap fitur punya properti "building" (nilai tag building=* aslinya: residential/
apartments/house) - sama persis yang dicek osm.is_residential().

PERINGATAN: bangunan residential itu jumlahnya BANYAK di area padat (bisa ribuan per
stasiun) - job ini lebih berat dari poi_green_*.py/poi_parking_*.py, DAN TJ punya ~2876
stasiun (3 kategori GTFS: Angkutan Umum Integrasi, BRT, Transjabodetabek - Mikrotrans dkk
di luar scope, di-thin dulu grid 250m, tapi tetap job PALING BESAR dari semua script
poi_*.py gabungan). Wajar makan waktu paling lama dari semuanya.

Butuh koneksi internet (Overpass API). Progress disimpan checkpoint di
poi_residential_krl_work.json - kalau ke-stop di tengah jalan (proses dimatikan paksa dkk),
jalankan lagi `python poi_residential_krl.py`, otomatis lanjut dari stasiun yang belum
selesai. Stasiun yang gagal (timeout/error Overpass, bukan dimatikan paksa) di-retry
OTOMATIS di dalam satu run yang sama - gak perlu jalankan ulang manual buat itu (lihat
MAX_RETRY_ROUNDS/RETRY_BACKOFF_S, backoff-nya dobel tiap ronde). Tiap request juga dikasih
jeda REQUEST_DELAY_S biar gak nembak Overpass beruntun sampai kena rate-limit/502. Stasiun
yang TETAP gagal di >= GIVEUP_THRESHOLD run terpisah (bukan cuma di dalam satu run) di-skip
permanen mulai run berikutnya - lihat poi_residential_krl_giveup.json - biar stasiun yang
emang selalu gagal (koordinat rusak dkk) gak bikin tiap rerun kejebak ngulang dia mulu.
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
WORK_FILE = OUT_DIR / "poi_residential_krl_work.json"
OUTPUT_FILE = OUT_DIR / "poi_residential_krl_800m.geojson"
FAILED_FILE = OUT_DIR / "poi_residential_krl_800m_failed.txt"
GIVEUP_FILE = OUT_DIR / "poi_residential_krl_giveup.json"
CHECKPOINT_EVERY = 20  # smaller than poi_green_*.py/poi_parking_*.py - each call can return a lot more elements

# A stasiun that's STILL in `failed` after a whole run's worth of retries (in-run rounds +
# next-run resume) has its cross-run fail count bumped in GIVEUP_FILE. Once that count
# hits GIVEUP_THRESHOLD (i.e. it failed every single retry across 3 separate script
# executions, not just within one run), it's excluded from `remaining` on every future
# run - permanently-broken stasiun (bad coordinates, a query Overpass always rejects, etc.)
# would otherwise eat a full MAX_RETRY_ROUNDS budget on every single rerun forever,
# forever blocking a clean "0 gagal" finish. Still listed in FAILED_FILE so it's never
# silently dropped - the user has to notice and decide (fix the data, or accept the gap).
GIVEUP_THRESHOLD = 3

THIN_CELL_M = 500  # < RADIUS_M so a dropped station's 800m circle is still ~fully
# covered by the kept representative's circle (worst-case corner-to-corner gap in a
# 500m grid cell is ~707m, comfortably under 800m).

# Failed stasiun (Overpass timeout/error) get retried automatically - once right after each
# checkpoint, then in dedicated rounds after the whole list is done - instead of just
# being dumped to FAILED_FILE for the user to manually rerun the script. MAX_RETRY_ROUNDS
# caps it so a stasiun that fails for a non-transient reason can't hang the script forever;
# whatever's still failing after that many rounds falls back to the old FAILED_FILE +
# manual-rerun path.
MAX_RETRY_ROUNDS = 10
RETRY_BACKOFF_S = 5  # first round's wait; doubles each round after that (see main()),
# capped at RETRY_BACKOFF_MAX_S - a burst of "all Overpass mirrors unreachable/rate-
# limited" errors means the mirrors need real recovery time, not just a few seconds.
RETRY_BACKOFF_MAX_S = 120

REQUEST_DELAY_S = 1.0  # sleep after every Overpass call (success or fail), main pass and
# retries alike - firing requests back-to-back with zero pacing is exactly what gets all
# 3 public mirrors rate-limited/502-ing at once (checked: happened in practice on a
# run skala besar). A flat per-request delay is cheap insurance against that.


def thin_stations(stations: list[dict]) -> list[dict]:
    """Keeps at most one station per THIN_CELL_M x THIN_CELL_M metric grid cell. Matters
    most for TJ (own script, ~2876 halte (3 kategori GTFS: Angkutan Umum Integrasi, BRT, Transjabodetabek - Mikrotrans dkk di luar scope) often 300-500m apart along a corridor) but kept
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
    """KRL stations (OSM) - TJ (this project's poi_residential_tj.py) is the only mode
    sourced from GTFS instead, since OSM's TJ-tagged nodes are unreliable (see osm.py's
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


async def fetch_residential(lon: float, lat: float, radius: int) -> list[dict]:
    q = f"""
    [out:json][timeout:40];
    (
      node["building"~"^(residential|apartments|house)$"](around:{radius},{lat},{lon});
      way["building"~"^(residential|apartments|house)$"](around:{radius},{lat},{lon});
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
        out.append({
            "id": f"{el['type']}/{el['id']}", "building": tags.get("building", ""),
            "lon": lon_, "lat": lat_,
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


def load_giveup() -> dict:
    if not GIVEUP_FILE.exists():
        return {}
    return json.loads(GIVEUP_FILE.read_text(encoding="utf-8"))


def save_giveup(giveup: dict):
    GIVEUP_FILE.write_text(json.dumps(giveup, ensure_ascii=False), encoding="utf-8")


def write_geojson(points_by_key):
    features = [{
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]},
        "properties": {"building": p["building"]},
    } for p in points_by_key.values()]
    OUTPUT_FILE.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False),
        encoding="utf-8",
    )


async def _process(s: dict, points_by_key: dict, done_ids: set) -> bool:
    """Fetches one stasiun, folding results into points_by_key/done_ids on success.
    Returns whether it succeeded - callers collect the failures to retry. Always paces
    itself by REQUEST_DELAY_S afterwards, success or fail, so a caller looping over many
    stations never hammers Overpass back-to-back."""
    try:
        found = await fetch_residential(s["lon"], s["lat"], RADIUS_M)
    except Exception as e:
        print(f"  GAGAL: {s['name']} ({e})", flush=True)
        await asyncio.sleep(REQUEST_DELAY_S)
        return False
    for p in found:
        points_by_key[p["id"]] = p
    done_ids.add(s["id"])
    await asyncio.sleep(REQUEST_DELAY_S)
    return True


async def _retry_failed(failed: list[dict], points_by_key: dict, done_ids: set) -> list[dict]:
    still_failed = []
    for s in failed:
        if await _process(s, points_by_key, done_ids):
            print(f"  BERHASIL (retry): {s['name']}", flush=True)
        else:
            still_failed.append(s)
    return still_failed


async def main():
    stations = await target_stations()
    print(f"{len(stations)} stasiun {MODE} (setelah thinning grid {THIN_CELL_M}m).")

    points_by_key, done_ids = load_checkpoint()
    giveup = load_giveup()
    skip_ids = {sid for sid, c in giveup.items() if c >= GIVEUP_THRESHOLD}
    remaining = [s for s in stations if s["id"] not in done_ids and s["id"] not in skip_ids]
    print(f"{len(done_ids)} sudah selesai sebelumnya (checkpoint), {len(remaining)} sisa diproses.")
    if skip_ids:
        print(f"{len(skip_ids)} stasiun di-skip permanen (gagal terus di >= {GIVEUP_THRESHOLD} run terpisah) - lihat {GIVEUP_FILE.name}.")

    failed: list[dict] = []
    for i, s in enumerate(remaining):
        if await _process(s, points_by_key, done_ids):
            print(f"[{len(done_ids)}/{len(stations)}] {s['name']} - {len(points_by_key)} bangunan terkumpul", flush=True)
        else:
            failed.append(s)

        if (i + 1) % CHECKPOINT_EVERY == 0:
            save_checkpoint(points_by_key, done_ids)
            write_geojson(points_by_key)
            print(f"--- checkpoint disimpan ({len(done_ids)}/{len(stations)}, {len(failed)} gagal sejauh ini) ---", flush=True)
            if failed:
                print(f"--- retry {len(failed)} yang gagal sebelum lanjut ---", flush=True)
                failed = await _retry_failed(failed, points_by_key, done_ids)
                save_checkpoint(points_by_key, done_ids)
                write_geojson(points_by_key)

    save_checkpoint(points_by_key, done_ids)
    write_geojson(points_by_key)

    # Backoff doubles each round (5s, 10s, 20s... capped at RETRY_BACKOFF_MAX_S) - a flat
    # short wait doesn't give a rate-limited/down mirror real time to recover.
    round_no = 1
    while failed and round_no <= MAX_RETRY_ROUNDS:
        backoff = min(RETRY_BACKOFF_S * 2 ** (round_no - 1), RETRY_BACKOFF_MAX_S)
        print(f"\n--- Retry round {round_no}/{MAX_RETRY_ROUNDS}: {len(failed)} stasiun gagal, tunggu {backoff}s ---", flush=True)
        await asyncio.sleep(backoff)
        failed = await _retry_failed(failed, points_by_key, done_ids)
        save_checkpoint(points_by_key, done_ids)
        write_geojson(points_by_key)
        round_no += 1

    newly_given_up = []
    for s in failed:
        giveup[s["id"]] = giveup.get(s["id"], 0) + 1
        if giveup[s["id"]] >= GIVEUP_THRESHOLD:
            newly_given_up.append(s)
    for sid in list(giveup):
        if sid in done_ids:
            del giveup[sid]
    save_giveup(giveup)

    if failed:
        FAILED_FILE.write_text(
            "\n".join(f"{s['name']} ({s['id']}) - gagal {giveup.get(s['id'], '?')}x run terpisah" for s in failed),
            encoding="utf-8",
        )
    elif FAILED_FILE.exists():
        FAILED_FILE.unlink()

    print(f"\nSELESAI. {len(points_by_key)} bangunan residential ditulis ke {OUTPUT_FILE}")
    if newly_given_up:
        print(f"{len(newly_given_up)} stasiun baru DI-SKIP PERMANEN mulai run berikutnya (gagal {GIVEUP_THRESHOLD}x run terpisah): "
              + ", ".join(s["name"] for s in newly_given_up))
    if failed:
        print(f"{len(failed)} stasiun TETAP gagal setelah {MAX_RETRY_ROUNDS}x retry otomatis - lihat {FAILED_FILE.name}, jalankan lagi script ini buat coba lagi.")
    else:
        print("Semua stasiun berhasil diproses, tidak ada yang gagal.")

if __name__ == "__main__":
    asyncio.run(main())
