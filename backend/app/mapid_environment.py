"""MAPID Data Catalogue polygon layers - Urban Heat Island, ecology index, rainfall -
shown as raw context layers in M-UC1's "Kenyamanan" tab. These are government/MAPID
published values used as-is; no score or formula is derived from them here.

UHI and rainfall are coarse (one zone per kabupaten/kota or province) so a 500m walk
buffer usually sits inside a single zone - that's an honest reflection of the source
data's real resolution, not a bug. The ecology index is a finer per-grid dataset, so it
does show local variation within a buffer.
"""

import json
from pathlib import Path

from shapely.geometry import Point, mapping, shape
from shapely.strtree import STRtree

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

_layers: dict[str, tuple[list, list]] = {}


def _load(prefix: str, name: str):
    if name in _layers:
        return
    # fid/Id/ID_GRID are per-file local counters, not stable global IDs (checked: two
    # files can share the same fid on genuinely different geometries) - so files are
    # merged as-is, no dedup by id. A real duplicate would need a geometry-equality
    # check, which none of the current files have triggered.
    geoms, props = [], []
    for path in DATA_DIR.glob(f"{prefix}*.geojson"):
        data = json.loads(path.read_text(encoding="utf-8"))
        for f in data["features"]:
            geoms.append(shape(f["geometry"]))
            props.append(f["properties"])
    _layers[name] = (geoms, STRtree(geoms) if geoms else None, props)


def _query(name: str, buffer_deg) -> dict:
    geoms, tree, props = _layers[name]
    if tree is None:
        return {"type": "FeatureCollection", "features": []}
    features = []
    for i in tree.query(buffer_deg):
        if not geoms[i].intersects(buffer_deg):
            continue
        clipped = geoms[i].intersection(buffer_deg)
        if clipped.is_empty:
            continue
        features.append({"type": "Feature", "geometry": mapping(clipped), "properties": props[i]})
    return {"type": "FeatureCollection", "features": features}


def uhi(buffer_deg) -> dict:
    """URBAN HEAT ISLAND *.geojson - KELAS/CLASS/TEMPERATUR per kabupaten/kota."""
    _load("URBAN HEAT ISLAND", "uhi")
    return _query("uhi", buffer_deg)


def ecology_index(buffer_deg) -> dict:
    """INDEKS EKOLOGI DI *.geojson - INDEKS (0-1) + STATUS per grid cell."""
    _load("INDEKS EKOLOGI", "ecology_index")
    return _query("ecology_index", buffer_deg)


def rainfall(buffer_deg) -> dict:
    """Curah Hujan (Presipitasi) *.geojson - Kelas + intensity (mm/hari) per province zone."""
    _load("Curah Hujan", "rainfall")
    return _query("rainfall", buffer_deg)


def flood_risk(buffer_deg) -> dict:
    """WILAYAH BAHAYA ATAU TERANCAM BANJIR *.geojson - Kelas (Sangat Rendah..Tinggi) per
    zone. This is K-UC2's only hazard layer - it replaced BNPB InaRISK's live "banjir"
    raster (slow, ~4-5s/call, occasionally unreachable). Landslide (longsor), which
    InaRISK also covered, was dropped outright rather than kept live-only - Jabodetabek's
    landslide risk is concentrated in a small hilly slice of Kabupaten Bogor, not
    something this project's use cases need citywide."""
    _load("WILAYAH BAHAYA ATAU TERANCAM BANJIR", "flood_risk")
    return _query("flood_risk", buffer_deg)


def flood_class_at(lon: float, lat: float) -> str | None:
    """Exact point-in-polygon lookup (not a buffer clip) - which flood-risk zone Kelas
    contains this exact point, or None if it's outside every mapped zone. Used by
    analysis.py's resilience() to steer routing away from high-risk corridors, same
    "hard avoidance" role InaRISK's banjir index used to fill - static and instant instead
    of a live per-point HTTP call."""
    _load("WILAYAH BAHAYA ATAU TERANCAM BANJIR", "flood_risk")
    geoms, tree, props = _layers["flood_risk"]
    if tree is None:
        return None
    pt = Point(lon, lat)
    for i in tree.query(pt):
        if geoms[i].contains(pt):
            return props[i].get("Kelas")
    return None
