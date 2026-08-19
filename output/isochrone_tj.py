"""Isochrone jalan kaki 400m + rute + jaringan jalan untuk SEMUA halte TransJakarta
(~8091 halte, dari GTFS resmi transjakarta.zip - bukan dari OSM, soalnya klasifikasi TJ
di OSM banyak salah/ketuker sama terminal bus lain).

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

PERINGATAN: meski udah di-cache, ini tetap job BESAR (8091 halte) dan bisa makan waktu
lama, apalagi Overpass API terkenal suka lambat/dibatasi. Progress disimpan checkpoint di
isochrone_tj_work.json (working file internal, bukan deliverable - jangan dihapus sebelum
semua halte selesai). Kalau ke-stop/mati di tengah jalan, tinggal jalankan ulang
`python isochrone_tj.py` - otomatis lanjut dari halte yang belum selesai, gak mulai dari
nol, lalu tulis ulang ke-4 shapefile dari data terbaru (cache road-fetch TIDAK ikut
disimpan di checkpoint - resume tetap fetch ulang dari nol untuk sisa halte, cuma
prosesnya sendiri tetap kena optimasi cache yang sama). Rute (shapes.txt) dari GTFS
lokal, gak butuh Overpass, jadi selalu diambil ulang tiap run.
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
OUT_DIR = Path(__file__).resolve().parent
WORK_FILE = OUT_DIR / "isochrone_tj_work.json"
FAILED_FILE = OUT_DIR / "isochrone_tj_400m_failed.txt"
STATIONS_SHP = OUT_DIR / "isochrone_tj_stations"
ROUTES_SHP = OUT_DIR / "isochrone_tj_routes"
ISOCHRONE_SHP = OUT_DIR / "isochrone_tj_isochrone_400m"
ROADS_SHP = OUT_DIR / "isochrone_tj_roads_400m"
STATIONS_GEOJSON = OUT_DIR / "isochrone_tj_stations.geojson"
ROUTES_GEOJSON = OUT_DIR / "isochrone_tj_routes.geojson"
ISOCHRONE_GEOJSON = OUT_DIR / "isochrone_tj_isochrone_400m.geojson"
ROADS_GEOJSON = OUT_DIR / "isochrone_tj_roads_400m.geojson"
CHECKPOINT_EVERY = 100

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
        roads = await osm.roads(lon, lat, RADIUS_QUERY)
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
    ambil shape_id-nya, jadi tiap koridor + arah + varian cabang punya jalurnya sendiri."""
    if not gtfs.GTFS_ZIP.exists():
        return []

    with zipfile.ZipFile(gtfs.GTFS_ZIP) as z:
        routes_by_id = {row["route_id"]: row for row in gtfs._read(z, "routes.txt")}

        shape_id_by_key = {}  # (route_id, direction_id) -> shape_id (trip representatif pertama)
        for row in gtfs._read(z, "trips.txt"):
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


async def main():
    gtfs._load()
    all_stops = [{"stop_id": sid, **s} for sid, s in gtfs._stops.items()]
    print(f"{len(all_stops)} halte TJ total (GTFS).")

    stops_done, roads_by_key = load_checkpoint()
    done_ids = {s["stop_id"] for s in stops_done}
    remaining = [s for s in all_stops if s["stop_id"] not in done_ids]
    print(f"{len(done_ids)} sudah selesai sebelumnya (checkpoint), {len(remaining)} sisa diproses.")

    print("Mengambil jalur rute (GTFS shapes.txt)...", flush=True)
    route_features = fetch_route_lines()
    print(f"{len(route_features)} jalur rute TJ ditemukan.")

    def checkpoint_and_write():
        save_checkpoint(stops_done, roads_by_key)
        write_all(stops_done, roads_by_key, route_features)

    failed = []
    for i, s in enumerate(remaining):
        try:
            poly, in_reach_roads = await station_isochrone(s["lon"], s["lat"])
            if poly is None:
                failed.append(s["name"])
            else:
                stops_done.append({
                    "stop_id": s["stop_id"], "name": s["name"],
                    "wheelchair": s.get("wheelchair", ""), "lon": s["lon"], "lat": s["lat"],
                    "poly": mapping(poly),
                })
                for r in in_reach_roads:
                    key = json.dumps(r["coords"])
                    roads_by_key[key] = r
        except Exception as e:
            failed.append(f"{s['name']} ({e})")

        done_total = len(done_ids) + i + 1
        print(f"[{done_total}/{len(all_stops)}] {s['name']}", flush=True)

        if (i + 1) % CHECKPOINT_EVERY == 0:
            checkpoint_and_write()
            print(f"--- checkpoint disimpan + shapefile/geojson ditulis ulang "
                  f"({len(stops_done)} halte) ---", flush=True)

    checkpoint_and_write()
    if failed:
        FAILED_FILE.write_text("\n".join(failed), encoding="utf-8")
    elif FAILED_FILE.exists():
        FAILED_FILE.unlink()

    print(f"\nSELESAI. {len(stops_done)} halte, {len(roads_by_key)} ruas jalan, "
          f"{len(route_features)} jalur rute ditulis ke {OUT_DIR}")
    if failed:
        print(f"{len(failed)} gagal, lihat {FAILED_FILE.name} - jalankan lagi script ini buat retry.")


if __name__ == "__main__":
    asyncio.run(main())
