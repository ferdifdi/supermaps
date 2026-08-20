"""Isochrone jalan kaki 400m + rute + jaringan jalan untuk SEMUA halte TransJakarta
(~2876 halte dari 3 kategori GTFS: Angkutan Umum Integrasi, BRT, Transjabodetabek -
Mikrotrans dkk di luar scope), dari GTFS resmi transjakarta.zip - bukan dari OSM, soalnya
klasifikasi TJ di OSM banyak salah/ketuker sama terminal bus lain.

Install dulu (sekali saja): pip install -r requirements.txt   (isinya cuma pyshp)

Jalankan: python isochrone_tj.py
Output (folder yang sama dengan script ini), 4 layer, tiap layer ditulis DUA format
sekaligus - shapefile (buat QGIS/ArcGIS) dan .geojson (buat dibaca langsung sama backend
sebagai data statis, gak usah panggil Overpass lagi tiap generate use case):
  1. isochrone_tj_stations[.shp|.geojson]        (Point)    - titik tiap halte TJ
  2. isochrone_tj_routes[.shp|.geojson]          (PolyLine) - jalur busway (GTFS shapes.txt,
                                                    satu garis per route_id + direction_id)
  3. isochrone_tj_isochrone_400m[.shp|.geojson]  (Polygon)  - jangkauan jalan kaki 400m/halte
  4. isochrone_tj_roads_400m[.shp|.geojson]      (PolyLine) - ruas jalan di dalam jangkauan
                                                    400m itu (jaringan jalan yang dipakai
                                                    buat hitung isochrone-nya)
Shapefile set (.shp/.shx/.dbf/.prj, WGS84) lengkap dan bisa langsung dibuka di QGIS/ArcGIS.
GeoJSON WGS84 juga, siap dipakai backend/frontend tanpa konversi.

CUTOFF 400m (bukan 800m kayak MRT/KRL/LRT) khusus buat TJ - halte-nya jauh lebih rapat
(sering 300-500m antar-halte), jadi 400m udah representatif dan bikin job ini jauh lebih
ringan dibanding kalau dipaksa 800m.

Road-fetch DI-CACHE SPASIAL (lihat _RoadCache) - kalau halte baru masih dalam jangkauan
fetch OSM yang udah diambil buat halte sebelumnya, gak fetch ulang ke Overpass, langsung
pakai data yang udah ada. Ini krusial buat TJ: banyak halte cuma 300-500m dari halte
lain, jadi jaringan jalan yang sama kepake berkali-kali kalau di-fetch satu-satu.

PERINGATAN: meski udah di-cache, ini tetap job BESAR (~2876 halte) dan bisa makan waktu
lama, apalagi Overpass API terkenal suka lambat/dibatasi. Progress disimpan checkpoint di
isochrone_tj_work.json (working file internal, bukan deliverable - jangan dihapus sebelum
semua halte selesai). Kalau ke-stop/mati di tengah jalan (proses dimatikan paksa dkk),
tinggal jalankan ulang `python isochrone_tj.py` - otomatis lanjut dari halte yang belum
selesai, gak mulai dari nol, lalu tulis ulang ke-4 shapefile dari data terbaru (cache
road-fetch TIDAK ikut disimpan di checkpoint - resume tetap fetch ulang dari nol untuk
sisa halte, cuma prosesnya sendiri tetap kena optimasi cache yang sama). Halte yang GAGAL
karena error Overpass (bukan dimatikan paksa) di-retry OTOMATIS di dalam satu run yang
sama - lihat MAX_RETRY_ROUNDS/RETRY_BACKOFF_S. Halte yang TETAP gagal di >=
GIVEUP_THRESHOLD run terpisah di-skip permanen mulai run berikutnya - lihat
isochrone_tj_giveup.json - biar halte yang emang selalu gagal (koordinat rusak dkk) gak
bikin tiap rerun kejebak ngulang dia mulu. Rute (shapes.txt) dari GTFS lokal, gak butuh
Overpass, jadi selalu diambil ulang tiap run.
"""

import asyncio
import json
import sys
import zipfile
from pathlib import Path

import networkx as nx
from shapely.geometry import LineString, Point, mapping, shape
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from app import gtfs, network, osm  # noqa: E402
from app.geo import to_deg, to_m  # noqa: E402

try:
    import shapefile  # pyshp
except ImportError:
    sys.exit("Butuh pyshp - jalankan dulu: pip install -r requirements.txt")

CUTOFF_M = 400
RADIUS_QUERY = 1000  # sengaja jauh lebih besar dari CUTOFF_M - fetch yang lebih lebar
# berarti lebih banyak halte tetangga yang bisa reuse hasil fetch yang sama (lihat
# _RoadCache), jadi walau tiap fetch individual agak lebih berat, TOTAL panggilan
# Overpass jauh lebih sedikit.


# Halte yang GAGAL karena exception (timeout/error Overpass) di-retry OTOMATIS - sekali
# tiap checkpoint, lalu dalam beberapa ronde setelah semua halte diproses - sampai
# gak ada yang gagal lagi atau MAX_RETRY_ROUNDS habis. Halte yang poly-nya None (network
# jalan beneran gak nyampe dari titik itu - hasil geometri yang stabil, bukan gangguan
# jaringan) TIDAK di-retry, itu bukan kegagalan fetch, coba lagi gak bakal ubah hasilnya.
MAX_RETRY_ROUNDS = 10
RETRY_BACKOFF_S = 5  # first round's wait; doubles each round after that (see main()),
# capped at RETRY_BACKOFF_MAX_S - a burst of "all Overpass mirrors unreachable/rate-
# limited" errors means the mirrors need real recovery time, not just a few seconds.
RETRY_BACKOFF_MAX_S = 120

REQUEST_DELAY_S = 1.0  # sleep after every osm.roads() call that actually hits Overpass
# (skipped when _RoadCache serves a reused fetch instead - no request, no need to pace
# it), success or fail, main pass and retries alike - firing requests back-to-back with
# zero pacing is exactly what gets all 3 public mirrors rate-limited/502-ing at once
# (checked: happened in practice on a ~2876-halte run).
# A halte that's STILL in `failed` after a whole run's worth of retries (in-run rounds +
# next-run resume) has its cross-run fail count bumped in GIVEUP_FILE. Once that count
# hits GIVEUP_THRESHOLD (i.e. it failed every single retry across 3 separate script
# executions, not just within one run), it's excluded from `remaining` on every future
# run - permanently-broken halte (bad coordinates, a query Overpass always rejects, etc.)
# would otherwise eat a full MAX_RETRY_ROUNDS budget on every single rerun forever,
# forever blocking a clean "0 gagal" finish. Still listed in FAILED_FILE so it's never
# silently dropped - the user has to notice and decide (fix the data, or accept the gap).
# Doesn't apply to `unreachable` (poly is None) - that's a stable geometry result, not a
# fetch failure, never retried in the first place.
GIVEUP_THRESHOLD = 3

OUT_DIR = Path(__file__).resolve().parent
WORK_FILE = OUT_DIR / "isochrone_tj_work.json"
FAILED_FILE = OUT_DIR / "isochrone_tj_400m_failed.txt"
GIVEUP_FILE = OUT_DIR / "isochrone_tj_giveup.json"
STATIONS_SHP = OUT_DIR / "isochrone_tj_stations"
ROUTES_SHP = OUT_DIR / "isochrone_tj_routes"
ISOCHRONE_SHP = OUT_DIR / "isochrone_tj_isochrone_400m"
ROADS_SHP = OUT_DIR / "isochrone_tj_roads_400m"
STATIONS_GEOJSON = OUT_DIR / "isochrone_tj_stations.geojson"
ROUTES_GEOJSON = OUT_DIR / "isochrone_tj_routes.geojson"
ISOCHRONE_GEOJSON = OUT_DIR / "isochrone_tj_isochrone_400m.geojson"
ROADS_GEOJSON = OUT_DIR / "isochrone_tj_roads_400m.geojson"
CHECKPOINT_EVERY = 25  # was 100 - dikecilin biar kalau proses ke-stop di tengah jalan
# (atau internet putus/mirror down), progress yang hilang dan halte yang harus diulang
# lebih sedikit. Trade-off: nulis checkpoint + 4 shapefile/geojson lebih sering (agak
# nambah I/O), tapi itu jauh lebih murah dibanding ngulang puluhan panggilan Overpass.

WGS84_WKT = (
    'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",'
    'SPHEROID["WGS_1984",6378137.0,298.257223563]],'
    'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
)


class _RoadCache:
    """Reuses a previous osm.roads() fetch for a new station if that station's own
    CUTOFF_M reach is fully contained inside the earlier fetch's radius - i.e. within
    (RADIUS_QUERY - CUTOFF_M) of the earlier fetch's center. TJ halte are frequently
    300-500m apart, well inside that margin at RADIUS_QUERY=1000/CUTOFF_M=400 (600m
    margin), so most halte end up reusing a neighbor's fetch instead of hitting Overpass
    again. A plain list + linear scan is fine here - entries stay in the low thousands at
    worst (bounded by how many non-overlapping RADIUS_QUERY circles fit in Jabodetabek),
    scanned a few thousand times total, which is trivial next to the Overpass calls this
    is avoiding."""

    def __init__(self):
        self.entries: list[tuple[Point, list[dict]]] = []

    def get(self, point_m: Point):
        margin = RADIUS_QUERY - CUTOFF_M
        for center, roads in self.entries:
            if center.distance(point_m) <= margin:
                return roads
        return None

    def put(self, point_m: Point, roads: list[dict]):
        self.entries.append((point_m, roads))


_road_cache = _RoadCache()


async def station_isochrone(lon: float, lat: float):
    """Returns (isochrone polygon in degrees, list of road-segment coords that fall
    inside the isochrone) or (None, []) if unreachable."""
    origin_m = to_m(Point(lon, lat))
    roads = _road_cache.get(origin_m)
    if roads is None:
        # Paced (REQUEST_DELAY_S) even on exception, via finally - only when this
        # actually hits Overpass, not when _RoadCache serves a reused fetch (no request,
        # nothing to pace). The exception itself still propagates up normally afterwards.
        try:
            roads = await osm.roads(lon, lat, RADIUS_QUERY)
        finally:
            await asyncio.sleep(REQUEST_DELAY_S)
        _road_cache.put(origin_m, roads)
    if not roads:
        return None, []
    g = network.build(roads)
    try:
        node = network.nearest_node(g, origin_m)
    except ValueError:
        return None, []
    reached = nx.single_source_dijkstra_path_length(g, node, cutoff=CUTOFF_M, weight="length")
    poly_m = unary_union([Point(n).buffer(60) for n in reached]) if reached else origin_m.buffer(50)
    poly = to_deg(poly_m)
    in_reach = [r for r in roads if LineString(r["coords"]).intersects(poly)]
    return poly, in_reach


def fetch_route_lines() -> list[dict]:
    """Jalur busway TJ dari GTFS shapes.txt (bukan jalur jalan kaki). Satu baris per
    (route_id, direction_id) - satu trip representatif per kombinasi itu dipakai buat
    ambil shape_id-nya, jadi tiap koridor + arah + varian cabang punya jalurnya sendiri.

    Cuma rute dari 3 kategori route_desc di gtfs.INCLUDED_ROUTE_CATEGORIES (Angkutan Umum
    Integrasi, BRT, Transjabodetabek) - Mikrotrans/Rusun/Royaltrans/Bus Wisata di luar
    scope proyek ini, sama kayak filter halte-nya di gtfs.py."""
    if not gtfs.GTFS_ZIP.exists():
        return []

    with zipfile.ZipFile(gtfs.GTFS_ZIP) as z:
        routes_by_id = {row["route_id"]: row for row in gtfs._read(z, "routes.txt")}
        included_route_ids = {
            rid for rid, row in routes_by_id.items()
            if row.get("route_desc", "") in gtfs.INCLUDED_ROUTE_CATEGORIES
        }

        shape_id_by_key = {}  # (route_id, direction_id) -> shape_id (trip representatif pertama)
        for row in gtfs._read(z, "trips.txt"):
            if row["route_id"] not in included_route_ids:
                continue
            key = (row["route_id"], row.get("direction_id", ""))
            shape_id = row.get("shape_id")
            if shape_id and key not in shape_id_by_key:
                shape_id_by_key[key] = shape_id

        needed_shape_ids = set(shape_id_by_key.values())
        points_by_shape: dict[str, list[tuple[int, float, float]]] = {}
        for row in gtfs._read(z, "shapes.txt"):
            sid = row["shape_id"]
            if sid not in needed_shape_ids:
                continue
            points_by_shape.setdefault(sid, []).append((
                int(row["shape_pt_sequence"]),
                float(row["shape_pt_lon"]),
                float(row["shape_pt_lat"]),
            ))

    features = []
    for (route_id, direction_id), shape_id in shape_id_by_key.items():
        pts = points_by_shape.get(shape_id)
        if not pts:
            continue
        pts.sort(key=lambda p: p[0])
        coords = [[lon, lat] for _, lon, lat in pts]
        if len(coords) < 2:
            continue
        route = routes_by_id.get(route_id, {})
        features.append({
            "route_id": route_id,
            "direction_id": direction_id,
            "name": route.get("route_long_name") or route.get("route_short_name", ""),
            "short_name": route.get("route_short_name", ""),
            "coords": coords,
        })
    return features


def load_checkpoint():
    if not WORK_FILE.exists():
        return [], {}
    data = json.loads(WORK_FILE.read_text(encoding="utf-8"))
    return data["stops"], data["roads"]


def save_checkpoint(stops_done, roads_by_key):
    WORK_FILE.write_text(
        json.dumps({"stops": stops_done, "roads": roads_by_key}, ensure_ascii=False),
        encoding="utf-8",
    )


def load_giveup() -> dict:
    if not GIVEUP_FILE.exists():
        return {}
    return json.loads(GIVEUP_FILE.read_text(encoding="utf-8"))


def save_giveup(giveup: dict):
    GIVEUP_FILE.write_text(json.dumps(giveup, ensure_ascii=False), encoding="utf-8")


def _write_prj(base_path: Path):
    base_path.with_suffix(".prj").write_text(WGS84_WKT, encoding="utf-8")


def write_stations_shp(stops_done):
    w = shapefile.Writer(str(STATIONS_SHP), shapeType=shapefile.POINT)
    w.field("STOP_ID", "C", 40)
    w.field("NAME", "C", 80)
    w.field("MODE", "C", 10)
    w.field("WHEELCHR", "C", 20)
    for s in stops_done:
        w.point(s["lon"], s["lat"])
        w.record(s["stop_id"], s["name"], "TJ", s.get("wheelchair", ""))
    w.close()
    _write_prj(STATIONS_SHP)


def write_routes_shp(route_features):
    w = shapefile.Writer(str(ROUTES_SHP), shapeType=shapefile.POLYLINE)
    w.field("ROUTE_ID", "C", 20)
    w.field("DIRECTION", "C", 4)
    w.field("NAME", "C", 80)
    w.field("SHORTNAME", "C", 20)
    w.field("MODE", "C", 10)
    for feat in route_features:
        w.line([feat["coords"]])
        w.record(feat["route_id"], feat["direction_id"], feat["name"], feat["short_name"], "TJ")
    if not route_features:
        w.field("EMPTY", "C", 1)
        w.null()
        w.record("")
    w.close()
    _write_prj(ROUTES_SHP)


def write_isochrone_shp(stops_done):
    w = shapefile.Writer(str(ISOCHRONE_SHP), shapeType=shapefile.POLYGON)
    w.field("STOP_ID", "C", 40)
    w.field("NAME", "C", 80)
    w.field("MODE", "C", 10)
    w.field("ISO_M", "N", 6)
    for s in stops_done:
        geom = shape(s["poly"])
        polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
        parts = []
        for p in polys:
            p = orient(p, sign=-1.0)
            parts.append(list(p.exterior.coords))
            for interior in p.interiors:
                parts.append(list(interior.coords))
        w.poly(parts)
        w.record(s["stop_id"], s["name"], "TJ", CUTOFF_M)
    w.close()
    _write_prj(ISOCHRONE_SHP)


def write_roads_shp(roads_by_key):
    w = shapefile.Writer(str(ROADS_SHP), shapeType=shapefile.POLYLINE)
    w.field("HIGHWAY", "C", 30)
    w.field("SIDEWALK", "C", 20)
    w.field("LIT", "C", 10)
    w.field("SURFACE", "C", 30)
    w.field("WHEELCHR", "C", 20)
    for r in roads_by_key.values():
        w.line([r["coords"]])
        w.record(r.get("highway", ""), r.get("sidewalk", ""), r.get("lit", ""),
                  r.get("surface", ""), r.get("wheelchair", ""))
    if not roads_by_key:
        w.field("EMPTY", "C", 1)
        w.null()
        w.record("")
    w.close()
    _write_prj(ROADS_SHP)


def _fc(features):
    return {"type": "FeatureCollection", "features": features}


def write_stations_geojson(stops_done):
    features = [{
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [s["lon"], s["lat"]]},
        "properties": {
            "stop_id": s["stop_id"], "name": s["name"], "mode_label": "TJ",
            "wheelchair": s.get("wheelchair", ""),
        },
    } for s in stops_done]
    STATIONS_GEOJSON.write_text(json.dumps(_fc(features), ensure_ascii=False), encoding="utf-8")


def write_routes_geojson(route_features):
    features = [{
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": feat["coords"]},
        "properties": {
            "route_id": feat["route_id"], "direction_id": feat["direction_id"],
            "name": feat["name"], "short_name": feat["short_name"], "mode_label": "TJ",
        },
    } for feat in route_features]
    ROUTES_GEOJSON.write_text(json.dumps(_fc(features), ensure_ascii=False), encoding="utf-8")


def write_isochrone_geojson(stops_done):
    features = [{
        "type": "Feature",
        "geometry": s["poly"],
        "properties": {
            "stop_id": s["stop_id"], "name": s["name"], "mode_label": "TJ", "isochrone_m": CUTOFF_M,
        },
    } for s in stops_done]
    ISOCHRONE_GEOJSON.write_text(json.dumps(_fc(features), ensure_ascii=False), encoding="utf-8")


def write_roads_geojson(roads_by_key):
    features = [{
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": r["coords"]},
        "properties": {
            "highway": r.get("highway", ""), "sidewalk": r.get("sidewalk", ""),
            "lit": r.get("lit", ""), "surface": r.get("surface", ""),
            "wheelchair": r.get("wheelchair", ""),
        },
    } for r in roads_by_key.values()]
    ROADS_GEOJSON.write_text(json.dumps(_fc(features), ensure_ascii=False), encoding="utf-8")


def write_all(stops_done, roads_by_key, route_features):
    write_stations_shp(stops_done)
    write_routes_shp(route_features)
    write_isochrone_shp(stops_done)
    write_roads_shp(roads_by_key)
    write_stations_geojson(stops_done)
    write_routes_geojson(route_features)
    write_isochrone_geojson(stops_done)
    write_roads_geojson(roads_by_key)


async def _process(s: dict, stops_done: list, roads_by_key: dict, unreachable: list) -> str:
    """Fetches+builds one halte's isochrone. Returns "error" on exception (Overpass
    timeout/error - retryable by the caller). Returns "ok" or "unreachable" for the two
    real outcomes that won't change on retry: a completed isochrone (appended to
    stops_done) or a genuinely unreachable halte (poly is None - no road network reaches
    it, a stable geometry result, not a fetch failure - appended to `unreachable`, never
    retried)."""
    try:
        poly, in_reach_roads = await station_isochrone(s["lon"], s["lat"])
    except Exception as e:
        print(f"  GAGAL: {s['name']} ({e})", flush=True)
        return "error"
    if poly is None:
        unreachable.append(s["name"])
        return "unreachable"
    stops_done.append({
        "stop_id": s["stop_id"], "name": s["name"],
        "wheelchair": s.get("wheelchair", ""), "lon": s["lon"], "lat": s["lat"],
        "poly": mapping(poly),
    })
    for r in in_reach_roads:
        key = json.dumps(r["coords"])
        roads_by_key[key] = r
    return "ok"


async def _retry_failed(failed: list[dict], stops_done: list, roads_by_key: dict, unreachable: list) -> list[dict]:
    still_failed = []
    for s in failed:
        status = await _process(s, stops_done, roads_by_key, unreachable)
        if status == "ok":
            print(f"  BERHASIL (retry): {s['name']}", flush=True)
        elif status == "unreachable":
            print(f"  UNREACHABLE (retry): {s['name']}", flush=True)
        else:
            still_failed.append(s)
    return still_failed


async def main():
    gtfs._load()
    all_stops = [{"stop_id": sid, **s} for sid, s in gtfs._stops.items()]
    print(f"{len(all_stops)} halte TJ total (GTFS).")

    stops_done, roads_by_key = load_checkpoint()
    done_ids = {s["stop_id"] for s in stops_done}
    giveup = load_giveup()
    skip_ids = {sid for sid, c in giveup.items() if c >= GIVEUP_THRESHOLD}
    remaining = [s for s in all_stops if s["stop_id"] not in done_ids and s["stop_id"] not in skip_ids]
    print(f"{len(done_ids)} sudah selesai sebelumnya (checkpoint), {len(remaining)} sisa diproses.")
    if skip_ids:
        print(f"{len(skip_ids)} halte di-skip permanen (gagal terus di >= {GIVEUP_THRESHOLD} run terpisah) - lihat {GIVEUP_FILE.name}.")

    print("Mengambil jalur rute (GTFS shapes.txt)...", flush=True)
    route_features = fetch_route_lines()
    print(f"{len(route_features)} jalur rute TJ ditemukan.")

    def checkpoint_and_write():
        save_checkpoint(stops_done, roads_by_key)
        write_all(stops_done, roads_by_key, route_features)

    unreachable: list[str] = []
    failed: list[dict] = []
    for i, s in enumerate(remaining):
        done_total = len(done_ids) + i + 1
        status = await _process(s, stops_done, roads_by_key, unreachable)
        if status == "ok":
            print(f"[{done_total}/{len(all_stops)}] BERHASIL: {s['name']}", flush=True)
        elif status == "unreachable":
            print(f"[{done_total}/{len(all_stops)}] UNREACHABLE: {s['name']}", flush=True)
        else:
            failed.append(s)
            print(f"[{done_total}/{len(all_stops)}] (lihat GAGAL di atas)", flush=True)

        if (i + 1) % CHECKPOINT_EVERY == 0:
            checkpoint_and_write()
            print(f"--- checkpoint disimpan + shapefile/geojson ditulis ulang "
                  f"({len(stops_done)} halte, {len(failed)} gagal sejauh ini) ---", flush=True)
            if failed:
                print(f"--- retry {len(failed)} yang gagal sebelum lanjut ---", flush=True)
                failed = await _retry_failed(failed, stops_done, roads_by_key, unreachable)
                checkpoint_and_write()

    checkpoint_and_write()

    # Backoff doubles each round (5s, 10s, 20s... capped at RETRY_BACKOFF_MAX_S) - a flat
    # short wait doesn't give a rate-limited/down mirror real time to recover.
    round_no = 1
    while failed and round_no <= MAX_RETRY_ROUNDS:
        backoff = min(RETRY_BACKOFF_S * 2 ** (round_no - 1), RETRY_BACKOFF_MAX_S)
        print(f"\n--- Retry round {round_no}/{MAX_RETRY_ROUNDS}: {len(failed)} halte gagal, tunggu {backoff}s ---", flush=True)
        await asyncio.sleep(backoff)
        failed = await _retry_failed(failed, stops_done, roads_by_key, unreachable)
        checkpoint_and_write()
        round_no += 1

    newly_given_up = []
    for s in failed:
        giveup[s["stop_id"]] = giveup.get(s["stop_id"], 0) + 1
        if giveup[s["stop_id"]] >= GIVEUP_THRESHOLD:
            newly_given_up.append(s)
    for sid in list(giveup):
        if sid in done_ids:
            del giveup[sid]
    save_giveup(giveup)

    if failed or unreachable:
        lines = [f"{s['name']} ({s['stop_id']}) - GAGAL setelah retry, {giveup.get(s['stop_id'], '?')}x run terpisah" for s in failed]
        lines += [f"{name} - unreachable (tidak ada jaringan jalan)" for name in unreachable]
        FAILED_FILE.write_text("\n".join(lines), encoding="utf-8")
    elif FAILED_FILE.exists():
        FAILED_FILE.unlink()

    print(f"\nSELESAI. {len(stops_done)} halte, {len(roads_by_key)} ruas jalan, "
          f"{len(route_features)} jalur rute ditulis ke {OUT_DIR}")
    if unreachable:
        print(f"{len(unreachable)} halte unreachable (gak ada jaringan jalan dalam {CUTOFF_M}m) - bukan kegagalan, gak di-retry.")
    if newly_given_up:
        print(f"{len(newly_given_up)} halte baru DI-SKIP PERMANEN mulai run berikutnya (gagal {GIVEUP_THRESHOLD}x run terpisah): "
              + ", ".join(s["name"] for s in newly_given_up))
    if failed:
        print(f"{len(failed)} halte TETAP gagal setelah {MAX_RETRY_ROUNDS}x retry otomatis - lihat {FAILED_FILE.name}, jalankan lagi script ini buat coba lagi.")
    elif not unreachable:
        print("Semua halte berhasil diproses, tidak ada yang gagal.")


if __name__ == "__main__":
    asyncio.run(main())
