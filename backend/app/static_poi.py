"""Precomputed parking/green/residential POI (output/poi_{parking,green,residential}_*.py),
loaded once so most of these lookups skip Overpass entirely - same static-first/live-
fallback pattern as static_transit.py, same MODE_RADIUS_M cutoffs (800m for MRT/KRL/LRT,
400m for TJ) and file layout (backend/data/static/).

Narrower than osm.pois()'s live fetch on purpose - this only covers the 3 categories
those output scripts actually target (parking: amenity=parking/motorcycle_parking; green:
trees + park/garden/forest/shelter; residential: building=residential/apartments/house).
Everything else osm.pois() covers (commercial, safety tags, crossings, transit stops,
office/building-count, etc.) has no static equivalent yet and stays live - callers still
need osm.pois() for those, this just lets residential/green/parking-derived numbers skip
it when the mode/radius is covered.
"""

import json

from shapely.geometry import Point
from shapely.strtree import STRtree

from .geo import to_m
from .static_transit import MODE_RADIUS_M, STATIC_DIR

_MODES = ("mrt", "krl", "lrt", "tj")
_KINDS = ("parking", "green", "residential")

_points: dict[str, dict[str, list]] = {k: {} for k in _KINDS}
_props: dict[str, dict[str, list]] = {k: {} for k in _KINDS}
_trees: dict[str, dict[str, STRtree]] = {k: {} for k in _KINDS}
_loaded: set[tuple[str, str]] = set()


def _load(kind: str, mode: str):
    """Reads/parses one (kind, mode) file only, not all 12 kind x mode combos at once -
    the old version loaded every mode's file the moment ANY lookup ran, which meant the
    very first static-mode request of a process session paid for parsing ~100MB of
    geojson across all 4 modes (TJ's alone is tens of MB) before it could answer a query
    about a single MRT station. Per-(kind, mode) loading spreads that cost across whichever
    combos actually get queried, and each combo is still only ever read once (cached in
    _loaded)."""
    if (kind, mode) in _loaded:
        return
    path = STATIC_DIR / f"poi_{kind}_{mode}_{MODE_RADIUS_M[mode]}m.geojson"
    pts, props = [], []
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        for f in data["features"]:
            lon, lat = f["geometry"]["coordinates"]
            pts.append(to_m(Point(lon, lat)))
            props.append({**f["properties"], "lon": lon, "lat": lat})
    _points[kind][mode] = pts
    _props[kind][mode] = props
    _trees[kind][mode] = STRtree(pts) if pts else STRtree([])
    _loaded.add((kind, mode))


def has_mode(kind: str, mode_label: str) -> bool:
    mode = (mode_label or "").lower()
    if mode not in _MODES:
        return False
    _load(kind, mode)
    return bool(_points.get(kind, {}).get(mode))


def _near(kind: str, mode_label: str, lon: float, lat: float, radius: int) -> list[dict] | None:
    """Properties of every `kind` POI within `radius` of (lon, lat), or None if this
    station's mode has no static file for `kind` yet or `radius` exceeds that mode's
    MODE_RADIUS_M - the caller should fall back to classifying a live osm.pois() fetch
    in either case (see osm.is_residential()/is_green()/parking amenity checks)."""
    mode = (mode_label or "").lower()
    if mode not in _MODES or radius > MODE_RADIUS_M.get(mode, 0):
        return None
    _load(kind, mode)
    pts = _points[kind].get(mode)
    if not pts:
        return None
    origin = to_m(Point(lon, lat))
    circle = origin.buffer(radius)
    tree = _trees[kind][mode]
    props = _props[kind][mode]
    idxs = tree.query(circle)
    return [props[i] for i in idxs if pts[i].distance(origin) <= radius]


def parking_near(mode_label: str, lon: float, lat: float, radius: int) -> list[dict] | None:
    """Each item's "kind" is "car" (amenity=parking) or "motorcycle" (amenity=
    motorcycle_parking) - matches osm.py's own car_parking/motorcycle_parking split."""
    return _near("parking", mode_label, lon, lat, radius)


def green_near(mode_label: str, lon: float, lat: float, radius: int) -> list[dict] | None:
    """Each item's "kind" is "tree", "green_area" (park/garden/forest/leisure) or
    "shelter" - see output/poi_green_*.py's fetch_green()."""
    return _near("green", mode_label, lon, lat, radius)


def residential_near(mode_label: str, lon: float, lat: float, radius: int) -> list[dict] | None:
    """Each item's "building" is the raw OSM tag value (residential/apartments/house) -
    same set osm.is_residential() checks."""
    return _near("residential", mode_label, lon, lat, radius)
