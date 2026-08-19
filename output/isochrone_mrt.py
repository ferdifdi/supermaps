"""Isochrone jalan kaki 800m + rute + jaringan jalan untuk semua stasiun MRT (Jabodetabek).

Install dulu (sekali saja): pip install -r requirements.txt   (isinya cuma pyshp)

Jalankan: python isochrone_mrt.py
Output (folder yang sama dengan script ini), 4 layer, tiap layer ditulis DUA format
sekaligus - shapefile (buat QGIS/ArcGIS) dan .geojson (buat dibaca langsung sama backend
sebagai data statis, gak usah panggil Overpass lagi tiap generate use case):
  1. isochrone_mrt_stations[.shp|.geojson]        (Point)     - titik tiap stasiun MRT
  2. isochrone_mrt_routes[.shp|.geojson]          (PolyLine)  - jalur rel MRT (OSM route=subway)
  3. isochrone_mrt_isochrone_800m[.shp|.geojson]  (Polygon)   - jangkauan jalan kaki 800m/stasiun
  4. isochrone_mrt_roads_800m[.shp|.geojson]      (PolyLine)  - ruas jalan yang ada di dalam
                                                                 jangkauan 800m itu (jaringan
                                                                 jalan yang dipakai buat hitung
                                                                 isochrone-nya)
Shapefile set (.shp/.shx/.dbf/.prj, WGS84) lengkap dan bisa langsung dibuka di QGIS/ArcGIS.
GeoJSON WGS84 juga, siap dipakai backend/frontend tanpa konversi.

Isochrone dihitung multi-source Dijkstra dari titik pusat stasiun DAN semua pintu masuk/
keluar asli yang ada datanya di OSM (railway=subway_entrance) - bukan cuma dari 1 titik
pusat, biar stasiun dengan banyak exit tersebar (umum di MRT bawah tanah) gak underestimate
jangkauannya. Kalau OSM gak punya data entrance buat suatu stasiun, otomatis fallback ke
titik pusat aja (properti "entrances_used"/"ENTRIES" di outputnya kasih tau berapa entrance
yang kepakai per stasiun - 0 berarti fallback).

Butuh koneksi internet (Overpass API).

Progress disimpan checkpoint di isochrone_mrt_work.json (working file internal, bukan
deliverable - jangan dihapus sebelum semua stasiun selesai). Kalau ada stasiun yang gagal
(Overpass down/rate-limited), yang sudah berhasil TETAP TERSIMPAN. Tinggal jalankan lagi
`python isochrone_mrt.py` - otomatis skip yang sudah selesai, cuma retry yang gagal, lalu
tulis ulang ke-4 shapefile dari data terbaru. Daftar yang masih gagal dicatat di
isochrone_mrt_800m_failed.txt.
"""

import asyncio
import json
import sys
from pathlib import Path

import networkx as nx
from shapely.geometry import LineString, Point, mapping, shape
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from app import network, osm  # noqa: E402
from app.geo import to_deg, to_m  # noqa: E402

try:
    import shapefile  # pyshp
except ImportError:
    sys.exit("Butuh pyshp - jalankan dulu: pip install -r requirements.txt")

MODE = "MRT"
ROUTE_TAG = "subway"  # OSM route=* value buat relasi jalur MRT
CUTOFF_M = 800
RADIUS_QUERY = 1000  # radius fetch OSM - harus lebih besar dari CUTOFF_M biar graf gak kepotong pas di tepi
OUT_DIR = Path(__file__).resolve().parent
WORK_FILE = OUT_DIR / "isochrone_mrt_work.json"
FAILED_FILE = OUT_DIR / "isochrone_mrt_800m_failed.txt"
STATIONS_SHP = OUT_DIR / "isochrone_mrt_stations"
ROUTES_SHP = OUT_DIR / "isochrone_mrt_routes"
ISOCHRONE_SHP = OUT_DIR / "isochrone_mrt_isochrone_800m"
ROADS_SHP = OUT_DIR / "isochrone_mrt_roads_800m"
STATIONS_GEOJSON = OUT_DIR / "isochrone_mrt_stations.geojson"
ROUTES_GEOJSON = OUT_DIR / "isochrone_mrt_routes.geojson"
ISOCHRONE_GEOJSON = OUT_DIR / "isochrone_mrt_isochrone_800m.geojson"
ROADS_GEOJSON = OUT_DIR / "isochrone_mrt_roads_800m.geojson"
CHECKPOINT_EVERY = 20

WGS84_WKT = (
    'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",'
    'SPHEROID["WGS_1984",6378137.0,298.257223563]],'
    'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
)


async def station_isochrone(lon: float, lat: float, extra_points: list[tuple[float, float]] | None = None):
    """Returns (isochrone polygon in degrees, list of road-segment coords that fall
    inside the isochrone) or (None, []) if unreachable.

    extra_points: real entrance/exit node coords for this station (OSM
    railway=subway_entrance, when it exists - see fetch_entrances()). A station with
    several street exits spread 100m+ apart is understated by walking from just its one
    center point, so this does a multi-source Dijkstra from the center point AND every
    known entrance, unioning what's reachable from any of them. Falls back to the center
    point alone when extra_points is empty (most KRL/many LRT stations have no separate
    entrance nodes mapped in OSM)."""
    roads = await osm.roads(lon, lat, RADIUS_QUERY)
    if not roads:
        return None, []
    g = network.build(roads)
    origins_m = [to_m(Point(lon, lat))] + [to_m(Point(elon, elat)) for elon, elat in (extra_points or [])]
    source_nodes = set()
    for om in origins_m:
        try:
            source_nodes.add(network.nearest_node(g, om))
        except ValueError:
            continue
    if not source_nodes:
        return None, []
    reached = nx.multi_source_dijkstra_path_length(g, source_nodes, cutoff=CUTOFF_M, weight="length")
    poly_m = unary_union([Point(n).buffer(60) for n in reached]) if reached else origins_m[0].buffer(50)
    poly = to_deg(poly_m)
    in_reach = [r for r in roads if LineString(r["coords"]).intersects(poly)]
    return poly, in_reach


async def fetch_entrances() -> list[tuple[float, float]]:
    """railway=subway_entrance nodes across the whole bbox - OSM coverage is uneven (MRT's
    underground stations are well-mapped, LRT partially, KRL not at all as of this
    writing) - fetched once and matched to the nearest station below, shared by every
    station instead of one query each."""
    q = f"""
    [out:json][timeout:60];
    node["railway"="subway_entrance"]({osm._bbox()});
    out;
    """
    data = await osm.overpass(q)
    return [(el["lon"], el["lat"]) for el in data["elements"]]


ENTRANCE_MATCH_RADIUS_M = 300  # beyond this, an entrance more plausibly belongs to a
# different nearby station than to this one


def match_entrances(stations: list[dict], entrances: list[tuple[float, float]]) -> dict[str, list[tuple[float, float]]]:
    """Assigns each entrance node to its single nearest station, only if within
    ENTRANCE_MATCH_RADIUS_M - avoids attributing an entrance to a station it doesn't
    actually belong to just because it's also nearby."""
    by_station: dict[str, list[tuple[float, float]]] = {}
    if not entrances or not stations:
        return by_station
    station_pts = [(s["id"], to_m(Point(s["lon"], s["lat"]))) for s in stations]
    for elon, elat in entrances:
        ept = to_m(Point(elon, elat))
        sid, d = min(((sid, ept.distance(spt)) for sid, spt in station_pts), key=lambda t: t[1])
        if d <= ENTRANCE_MATCH_RADIUS_M:
            by_station.setdefault(sid, []).append((elon, elat))
    return by_station


async def fetch_route_lines(route_tag: str) -> list[dict]:
    """Jalur rel/busway asli (bukan jalan kaki) dari relasi route=* OSM. Satu Feature
    MultiLineString per relasi (nama/nomor jalur), digabung dari semua ruas jalan/rel
    yang jadi anggotanya."""
    q = f"""
    [out:json][timeout:90];
    rel["route"="{route_tag}"]({osm._bbox()});
    out body;
    >;
    out geom qt;
    """
    data = await osm.overpass(q)

    relations = [el for el in data["elements"] if el["type"] == "relation"]
    ways_geom = {
        el["id"]: [[p["lon"], p["lat"]] for p in el["geometry"]]
        for el in data["elements"]
        if el["type"] == "way" and el.get("geometry")
    }

    features = []
    for rel in relations:
        member_way_ids = [m["ref"] for m in rel.get("members", []) if m["type"] == "way"]
        lines = [ways_geom[wid] for wid in member_way_ids if wid in ways_geom]
        if not lines:
            continue
        tags = rel.get("tags", {})
        features.append({
            "name": tags.get("name", ""),
            "ref": tags.get("ref", ""),
            "operator": tags.get("operator", ""),
            "lines": lines,
        })
    return features


def load_checkpoint():
    if not WORK_FILE.exists():
        return [], {}
    data = json.loads(WORK_FILE.read_text(encoding="utf-8"))
    return data["stations"], data["roads"]


def save_checkpoint(stations_done, roads_by_key):
    WORK_FILE.write_text(
        json.dumps({"stations": stations_done, "roads": roads_by_key}, ensure_ascii=False),
        encoding="utf-8",
    )


def _write_prj(base_path: Path):
    base_path.with_suffix(".prj").write_text(WGS84_WKT, encoding="utf-8")


def write_stations_shp(stations_done):
    w = shapefile.Writer(str(STATIONS_SHP), shapeType=shapefile.POINT)
    w.field("STA_ID", "C", 40)
    w.field("NAME", "C", 80)
    w.field("MODE", "C", 10)
    w.field("OPERATOR", "C", 60)
    for s in stations_done:
        w.point(s["lon"], s["lat"])
        w.record(s["id"], s["name"], s["mode_label"], s.get("operator", ""))
    w.close()
    _write_prj(STATIONS_SHP)


def write_routes_shp(route_features):
    w = shapefile.Writer(str(ROUTES_SHP), shapeType=shapefile.POLYLINE)
    w.field("NAME", "C", 80)
    w.field("REF", "C", 20)
    w.field("OPERATOR", "C", 60)
    w.field("MODE", "C", 10)
    for feat in route_features:
        w.line(feat["lines"])
        w.record(feat["name"], feat["ref"], feat["operator"], MODE)
    if not route_features:
        w.field("EMPTY", "C", 1)
        w.null()
        w.record("")
    w.close()
    _write_prj(ROUTES_SHP)


def write_isochrone_shp(stations_done):
    w = shapefile.Writer(str(ISOCHRONE_SHP), shapeType=shapefile.POLYGON)
    w.field("STA_ID", "C", 40)
    w.field("NAME", "C", 80)
    w.field("MODE", "C", 10)
    w.field("OPERATOR", "C", 60)
    w.field("ISO_M", "N", 6)
    w.field("ENTRIES", "N", 3)
    for s in stations_done:
        geom = shape(s["poly"])
        polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
        parts = []
        for p in polys:
            p = orient(p, sign=-1.0)
            parts.append(list(p.exterior.coords))
            for interior in p.interiors:
                parts.append(list(interior.coords))
        w.poly(parts)
        w.record(s["id"], s["name"], s["mode_label"], s.get("operator", ""), CUTOFF_M, s.get("entrances_used", 0))
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


def write_stations_geojson(stations_done):
    features = [{
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [s["lon"], s["lat"]]},
        "properties": {
            "id": s["id"], "name": s["name"], "mode_label": s["mode_label"],
            "operator": s.get("operator", ""),
        },
    } for s in stations_done]
    STATIONS_GEOJSON.write_text(json.dumps(_fc(features), ensure_ascii=False), encoding="utf-8")


def write_routes_geojson(route_features):
    features = [{
        "type": "Feature",
        "geometry": {"type": "MultiLineString", "coordinates": feat["lines"]},
        "properties": {
            "name": feat["name"], "ref": feat["ref"], "operator": feat["operator"], "mode_label": MODE,
        },
    } for feat in route_features]
    ROUTES_GEOJSON.write_text(json.dumps(_fc(features), ensure_ascii=False), encoding="utf-8")


def write_isochrone_geojson(stations_done):
    features = [{
        "type": "Feature",
        "geometry": s["poly"],
        "properties": {
            "id": s["id"], "name": s["name"], "mode_label": s["mode_label"],
            "operator": s.get("operator", ""), "isochrone_m": CUTOFF_M,
            "entrances_used": s.get("entrances_used", 0),
        },
    } for s in stations_done]
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


def write_all(stations_done, roads_by_key, route_features):
    write_stations_shp(stations_done)
    write_routes_shp(route_features)
    write_isochrone_shp(stations_done)
    write_roads_shp(roads_by_key)
    write_stations_geojson(stations_done)
    write_routes_geojson(route_features)
    write_isochrone_geojson(stations_done)
    write_roads_geojson(roads_by_key)


async def main():
    all_stations = [s for s in await osm.stations() if s["mode_label"] == MODE]
    print(f"{len(all_stations)} stasiun {MODE} total.")

    stations_done, roads_by_key = load_checkpoint()
    done_ids = {s["id"] for s in stations_done}
    remaining = [s for s in all_stations if s["id"] not in done_ids]
    print(f"{len(done_ids)} sudah selesai sebelumnya (checkpoint), {len(remaining)} sisa diproses.")

    print("Mengambil jalur rute (OSM route relations)...", flush=True)
    try:
        route_features = await fetch_route_lines(ROUTE_TAG)
        print(f"{len(route_features)} jalur rute {MODE} ditemukan.")
    except Exception as e:
        route_features = []
        print(f"Gagal ambil rute: {e}")

    print("Mengambil data pintu masuk/keluar (OSM subway_entrance)...", flush=True)
    try:
        entrances = await fetch_entrances()
        entrance_map = match_entrances(all_stations, entrances)
        print(f"{len(entrances)} entrance ditemukan, {len(entrance_map)} stasiun ke-match "
              f"(radius {ENTRANCE_MATCH_RADIUS_M}m) - sisanya pakai titik pusat stasiun aja.")
    except Exception as e:
        entrance_map = {}
        print(f"Gagal ambil data entrance, semua stasiun pakai titik pusat aja: {e}")

    def checkpoint_and_write():
        save_checkpoint(stations_done, roads_by_key)
        write_all(stations_done, roads_by_key, route_features)

    failed = []
    for i, s in enumerate(remaining):
        try:
            extra_points = entrance_map.get(s["id"], [])
            poly, in_reach_roads = await station_isochrone(s["lon"], s["lat"], extra_points)
            if poly is None:
                failed.append(s["name"])
            else:
                stations_done.append({
                    "id": s["id"], "name": s["name"], "mode_label": s["mode_label"],
                    "operator": s["operator"], "lon": s["lon"], "lat": s["lat"],
                    "poly": mapping(poly), "entrances_used": len(extra_points),
                })
                for r in in_reach_roads:
                    key = json.dumps(r["coords"])
                    roads_by_key[key] = r
        except Exception as e:
            failed.append(f"{s['name']} ({e})")

        done_total = len(done_ids) + i + 1
        print(f"[{done_total}/{len(all_stations)}] {s['name']}", flush=True)

        if (i + 1) % CHECKPOINT_EVERY == 0:
            checkpoint_and_write()
            print(f"--- checkpoint disimpan + shapefile/geojson ditulis ulang "
                  f"({len(stations_done)} stasiun) ---", flush=True)

    checkpoint_and_write()
    if failed:
        FAILED_FILE.write_text("\n".join(failed), encoding="utf-8")
    elif FAILED_FILE.exists():
        FAILED_FILE.unlink()

    print(f"\nSELESAI. {len(stations_done)} stasiun, {len(roads_by_key)} ruas jalan, "
          f"{len(route_features)} jalur rute ditulis ke {OUT_DIR}")
    if failed:
        print(f"{len(failed)} gagal, lihat {FAILED_FILE.name} - jalankan lagi script ini buat retry.")


if __name__ == "__main__":
    asyncio.run(main())
