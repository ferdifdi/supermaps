"""Pure-OSM stand-ins for mapid_data.py's category roles - used only when a use case's
"Live OSM murni" data source is selected (see analysis.py's `data_source` param).

No MAPID Data Catalogue involved here at all - classifies POIs osm.pois() already fetched
(amenity/shop/office/building tags) into the same role vocabulary mapid_data.py uses, so
analysis.py doesn't need a third code path for what a POI "is". OSM's category tagging is
far sparser in Indonesia than MAPID's curated catalogue (checked empirically - a real
station in a dense area can show 5-10x fewer OSM-tagged basic-need POIs than MAPID), so
results here are usually much thinner - that's expected given the trade-off, not a bug.
"""

from .mapid_data import BASIC_NEED_CATEGORIES, BUSINESS_TYPES  # noqa: F401 - re-exported for callers

# One predicate per MAPID business-type prefix (site_selection's competitor search needs
# this granularity - "APOTEK" and "RUMAH SAKIT" must stay distinguishable even though both
# roll up into the same "kesehatan" basic-need category below).
PREFIX_PREDICATE = {
    "APOTEK": lambda p: p["amenity"] == "pharmacy",
    "KLINIK": lambda p: p["amenity"] == "clinic",
    "PUSKESMAS": lambda p: p["amenity"] == "doctors",
    "RUMAH SAKIT": lambda p: p["amenity"] == "hospital",
    "MAKANAN DAN MINUMAN": lambda p: p["amenity"] in ("restaurant", "cafe", "fast_food", "bar", "food_court"),
    "PUSAT PERBELANJAAN": lambda p: p["shop"] in ("mall", "department_store"),
    "PASAR": lambda p: p["amenity"] == "marketplace",
    "PASAR MODERN": lambda p: p["shop"] == "supermarket",
    "BANK": lambda p: p["amenity"] == "bank",
    "ATM": lambda p: p["amenity"] == "atm",
    "PERDAGANGAN DAN RETAIL": lambda p: bool(p["shop"]),
    "KANTOR": lambda p: bool(p["office"]) or p["building"] == "office",
}

# One predicate per BASIC_NEED_CATEGORIES bucket (M-UC2/K-UC1's coarser grouping) -
# checked in this order, first match wins, so a supermarket doesn't get double-counted
# under both "pusat_perbelanjaan_pasar" and "perdagangan_retail".
_CATEGORY_PREDICATE = [
    ("kesehatan", lambda p: p["amenity"] in ("pharmacy", "clinic", "hospital", "doctors")),
    ("pangan", lambda p: p["amenity"] in ("restaurant", "cafe", "fast_food", "bar", "food_court")),
    ("pusat_perbelanjaan_pasar", lambda p: p["shop"] in ("mall", "supermarket", "department_store")
        or p["amenity"] == "marketplace"),
    ("keuangan", lambda p: p["amenity"] in ("bank", "atm")),
    ("perdagangan_retail", lambda p: bool(p["shop"])),
]


def _with_mapid_shape(p: dict, category: str) -> dict:
    """Pads an osm.pois() dict with the fields mapid_data rows carry (alamat/telepon/etc)
    so callers built against mapid_data's row shape (analysis.py's feature builders) work
    unchanged - OSM just doesn't have most of these, so they come back empty."""
    return {
        **p, "category": category, "tipe_2": "", "tipe_3": "",
        "alamat": "", "telepon": "", "status": "", "kecamatan": "", "desa": "",
    }


def by_prefix(pois: list[dict], prefix: str, subtype: str | None = None) -> list[dict]:
    """OSM equivalent of mapid_data.by_prefix() - `subtype` is accepted for signature
    parity but always ignored, OSM has no equivalent of MAPID's TIPE_2 field."""
    pred = PREFIX_PREDICATE.get(prefix)
    if not pred:
        return []
    return [_with_mapid_shape(p, "") for p in pois if pred(p)]


def basic_needs(pois: list[dict]) -> list[dict]:
    """OSM equivalent of mapid_data.basic_needs() - each item's `category` is one of
    BASIC_NEED_CATEGORIES, same as the MAPID path."""
    out = []
    for p in pois:
        for category, pred in _CATEGORY_PREDICATE:
            if pred(p):
                out.append(_with_mapid_shape(p, category))
                break
    return out


def retail(pois: list[dict]) -> list[dict]:
    """OSM equivalent of mapid_data.retail() - PERDAGANGAN DAN RETAIL prefix only."""
    return by_prefix(pois, "PERDAGANGAN DAN RETAIL")


def offices(pois: list[dict]) -> list[dict]:
    """OSM equivalent of mapid_data.offices() - KANTOR prefix only."""
    return by_prefix(pois, "KANTOR")
