"""MAPID Data Catalogue POIs, downloaded by hand to backend/data/ (see data/README.md).

Each file is named "{CATEGORY} DI {KOTA/KABUPATEN} TAHUN {YEAR}.geojson" - one MAPID
category, one kota/kabupaten, all Point features. Loaded once and merged in memory.

ROLES controls which categories are used and what indicator role they fill. To add a
category once you've downloaded it: drop the .geojson files in backend/data/ and add
one line here mapping its file prefix to a role. Categories not listed are ignored,
even if the files exist - this project has pulled more MAPID data than is wired in.

Data source is kept separate from OSM on purpose: once a role has MAPID coverage,
nothing here falls back to OSM for it, so OSM's flaky/rate-limited Overpass API is
called less often overall.
"""

import json
from pathlib import Path

from shapely.geometry import Point
from shapely.strtree import STRtree

from .geo import to_m

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

ROLES = {
    "APOTEK": "basic_need",
    "KLINIK": "basic_need",
    "PUSKESMAS": "basic_need",
    "RUMAH SAKIT": "basic_need",
    "MAKANAN DAN MINUMAN": "basic_need",
    "PERDAGANGAN DAN RETAIL": "retail",
    "KANTOR": "office",
    "HALTE": "transit",
    "STASIUN": "transit",
}

# PERDAGANGAN DAN RETAIL is a mixed bag (Toko Pakaian, Elektronik, Mainan, ...) - most
# of it is discretionary shopping, not a daily need. These TIPE_2 sub-categories get
# "basic_need" *in addition to* their file's base role ("retail"), since they're the
# only genuinely daily-necessity ones in that category.
# TOKO MAKANAN DAN MINUMAN is deliberately excluded: it likely overlaps the same
# physical places already counted in MAKANAN DAN MINUMAN/RESTORAN.
EXTRA_BASIC_NEED_SUBTYPES = {"MINIMARKET", "SUPERMARKET", "TOKO KELONTONG", "PASAR"}

# M-UC2's three daily-need categories (proposal: "pangan/minimarket/apotek"), by TIPE_1/TIPE_2.
BASIC_NEED_CATEGORIES = {"pangan", "minimarket", "kesehatan"}


def _basic_need_category(props: dict) -> str | None:
    if props.get("TIPE_1") == "MAKANAN DAN MINUMAN":
        return "pangan"
    if props.get("TIPE_1") == "KESEHATAN DAN PENGOBATAN":
        return "kesehatan"
    if props.get("TIPE_2") in EXTRA_BASIC_NEED_SUBTYPES:
        return "minimarket"
    return None


_points: list[Point] = []
_roles: list[list[str]] = []
_props: list[dict] = []
_tree: STRtree | None = None


def _load():
    global _tree
    if _tree is not None:
        return
    for prefix, role in ROLES.items():
        for path in DATA_DIR.glob(f"{prefix} DI *.geojson"):
            data = json.loads(path.read_text(encoding="utf-8"))
            for f in data["features"]:
                lon, lat = f["geometry"]["coordinates"][:2]
                props = f["properties"]
                roles = [role]
                category = _basic_need_category(props)
                if category:
                    roles.append("basic_need")
                _points.append(to_m(Point(lon, lat)))
                _roles.append(roles)
                _props.append({
                    "lon": lon, "lat": lat, "name": props.get("NAMA", ""),
                    "category": category,
                })
    _tree = STRtree(_points) if _points else STRtree([])


def _near(lon: float, lat: float, radius: int, role: str) -> list[dict]:
    _load()
    if not _points:
        return []
    origin = to_m(Point(lon, lat))
    idx = _tree.query(origin.buffer(radius))
    return [_props[i] for i in idx if role in _roles[i] and _points[i].distance(origin) <= radius]


def retail(lon: float, lat: float, radius: int) -> list[dict]:
    """PERDAGANGAN DAN RETAIL - shops and services, not offices."""
    return _near(lon, lat, radius, "retail")


def offices(lon: float, lat: float, radius: int) -> list[dict]:
    """KANTOR."""
    return _near(lon, lat, radius, "office")


def basic_needs(lon: float, lat: float, radius: int) -> list[dict]:
    """APOTEK, KLINIK, PUSKESMAS, RUMAH SAKIT, MAKANAN DAN MINUMAN, RESTORAN."""
    return _near(lon, lat, radius, "basic_need")


def transit_stops(lon: float, lat: float, radius: int) -> list[dict]:
    """HALTE, STASIUN."""
    return _near(lon, lat, radius, "transit")
