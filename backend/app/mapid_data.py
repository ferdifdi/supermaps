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
    "PUSAT PERBELANJAAN": "basic_need",
    "PASAR": "basic_need",
    "PASAR MODERN": "basic_need",
    "BANK": "basic_need",
    "ATM": "basic_need",
    "PERDAGANGAN DAN RETAIL": "retail",  # also basic_need, see BASIC_NEED_CATEGORY_BY_PREFIX
    "KANTOR": "office",
}

# M-UC2's five daily-need categories, one per source file (RESTORAN stays excluded -
# checked empirically, it's a 100% exact-coordinate duplicate of MAKANAN DAN MINUMAN;
# see data/README.md).
BASIC_NEED_CATEGORY_BY_PREFIX = {
    "MAKANAN DAN MINUMAN": "pangan",
    "PUSAT PERBELANJAAN": "pusat_perbelanjaan_pasar",
    "PASAR": "pusat_perbelanjaan_pasar",
    "PASAR MODERN": "pusat_perbelanjaan_pasar",
    "BANK": "keuangan",
    "ATM": "keuangan",
    "PERDAGANGAN DAN RETAIL": "perdagangan_retail",
    "APOTEK": "kesehatan",
    "KLINIK": "kesehatan",
    "PUSKESMAS": "kesehatan",
    "RUMAH SAKIT": "kesehatan",
}
BASIC_NEED_CATEGORIES = ("pangan", "pusat_perbelanjaan_pasar", "keuangan", "perdagangan_retail", "kesehatan")

# U-UC1 business-type competitor search (see analysis.site_selection) - the exact MAPID
# prefixes a business owner can pick as "what am I opening". Real MAPID Data Catalogue
# POIs, not MAPID Missions - Missions (StrukGo/MenuGo/PropertiGo) was dropped for U-UC1,
# coverage was too sparse to be usable (see docs).
BUSINESS_TYPES = list(ROLES)

_points: list[Point] = []
_roles: list[list[str]] = []
_prefixes: list[str] = []
_props: list[dict] = []
_tree: STRtree | None = None


def _load():
    global _tree
    if _tree is not None:
        return
    for prefix, role in ROLES.items():
        category = BASIC_NEED_CATEGORY_BY_PREFIX.get(prefix)
        for path in DATA_DIR.glob(f"{prefix} DI *.geojson"):
            data = json.loads(path.read_text(encoding="utf-8"))
            for f in data["features"]:
                lon, lat = f["geometry"]["coordinates"][:2]
                props = f["properties"]
                roles = [role]
                if category and role != "basic_need":
                    roles.append("basic_need")
                _points.append(to_m(Point(lon, lat)))
                _roles.append(roles)
                _prefixes.append(prefix)
                _props.append({
                    "lon": lon, "lat": lat, "name": props.get("NAMA", ""),
                    "category": category,
                    "tipe_2": props.get("TIPE_2", ""), "tipe_3": props.get("TIPE_3", ""),
                    "alamat": props.get("ALAMAT", ""), "telepon": props.get("TELEPON", ""),
                    "status": props.get("STATUS", ""), "kecamatan": props.get("KECAMATAN", ""),
                    "desa": props.get("DESA", ""),
                })
    _tree = STRtree(_points) if _points else STRtree([])


def _near(lon: float, lat: float, radius: int, role: str) -> list[dict]:
    _load()
    if not _points:
        return []
    origin = to_m(Point(lon, lat))
    idx = _tree.query(origin.buffer(radius))
    return [_props[i] for i in idx if role in _roles[i] and _points[i].distance(origin) <= radius]


def by_prefix(lon: float, lat: float, radius: int, prefix: str, subtype: str | None = None) -> list[dict]:
    """Points from exactly one MAPID category (e.g. "APOTEK") - not the broader role
    bucket _near() uses, for when the caller needs one specific business type, not a
    whole group of them (competitor search in U-UC1). `subtype` further filters to one
    TIPE_2 value (e.g. prefix="MAKANAN DAN MINUMAN", subtype="RESTORAN") - see subtypes()."""
    _load()
    if not _points or prefix not in ROLES:
        return []
    origin = to_m(Point(lon, lat))
    idx = _tree.query(origin.buffer(radius))
    return [
        _props[i] for i in idx
        if _prefixes[i] == prefix and (subtype is None or _props[i]["tipe_2"] == subtype)
        and _points[i].distance(origin) <= radius
    ]


def subtypes(prefix: str) -> list[str]:
    """Distinct TIPE_2 values MAPID recorded for one category (e.g. MAKANAN DAN MINUMAN
    -> RESTORAN/MINUMAN/ROTI DAN KUE/BAR) - populates U-UC1's business-subtype dropdown.
    Empty list if the category has no TIPE_2 data (most only have one level)."""
    _load()
    values = {_props[i]["tipe_2"] for i in range(len(_props)) if _prefixes[i] == prefix and _props[i]["tipe_2"]}
    return sorted(values)


def retail(lon: float, lat: float, radius: int) -> list[dict]:
    """PERDAGANGAN DAN RETAIL - shops and services, not offices."""
    return _near(lon, lat, radius, "retail")


def offices(lon: float, lat: float, radius: int) -> list[dict]:
    """KANTOR."""
    return _near(lon, lat, radius, "office")


def basic_needs(lon: float, lat: float, radius: int) -> list[dict]:
    """APOTEK, KLINIK, PUSKESMAS, RUMAH SAKIT, MAKANAN DAN MINUMAN, PUSAT PERBELANJAAN,
    PASAR, PASAR MODERN, BANK, ATM, PERDAGANGAN DAN RETAIL. Each item's `category` field
    is one of BASIC_NEED_CATEGORIES."""
    return _near(lon, lat, radius, "basic_need")
