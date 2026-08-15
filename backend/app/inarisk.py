"""BNPB InaRISK (gis.bnpb.go.id) - official government hazard index rasters, free,
no auth. Used for K-UC2 flood/landslide hazard, replacing the earlier OSM-distance proxy
(green cover for heat, waterway distance for flood) with real published data.

Values are the raw hazard index (0-1) at a point, read via the ArcGIS "identify" raster
operation - not an aggregated or re-derived score. BNPB's own published classification
(see HAZARD_CLASS) is used as-is to label rendah/sedang/tinggi, nothing invented here.
"""

import hashlib
import json

import httpx

from .config import CACHE_DIR

BASE_URL = "https://gis.bnpb.go.id/server/rest/services/inarisk"

# Jabodetabek-Punjur-scoped layers ("_JBTBPJ") - BNPB also publishes national rasters,
# but these are the ones actually covering (and resolved for) this project's study area.
LAYERS = {
    "banjir": "INDEKS_BAHAYA_BANJIR_JBTBPJ",
    "longsor": "INDEKS_BAHAYA_TANAHLONGSOR_JBTBPJ",
}

# BNPB's own hazard index classification (used across InaRISK's public dashboards),
# not something this project invented.
def _classify(value: float) -> str:
    if value <= 0.33:
        return "rendah"
    if value <= 0.66:
        return "sedang"
    return "tinggi"


async def _identify(layer: str, lon: float, lat: float) -> float | None:
    key = hashlib.sha1(f"{layer}{lon:.5f}{lat:.5f}".encode()).hexdigest()
    path = CACHE_DIR / f"inarisk_{key}.json"
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
    else:
        params = {
            "geometry": f"{lon},{lat}", "geometryType": "esriGeometryPoint", "sr": 4326,
            "tolerance": 5, "mapExtent": f"{lon - 0.1},{lat - 0.1},{lon + 0.1},{lat + 0.1}",
            "imageDisplay": "400,400,96", "returnGeometry": "false", "f": "json",
        }
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.get(f"{BASE_URL}/{LAYERS[layer]}/MapServer/identify", params=params)
                r.raise_for_status()
                data = r.json()
        except httpx.HTTPError:
            return None
        path.write_text(json.dumps(data), encoding="utf-8")
    results = data.get("results", [])
    if not results:
        return None
    value = results[0]["attributes"].get("Stretch.Pixel Value")
    if value in (None, "NoData"):
        return None
    try:
        return float(value)
    except ValueError:
        return None


async def hazard(lon: float, lat: float) -> dict:
    """{"banjir": {"value": .., "class": ..} | None, "longsor": {...} | None} at a point.
    None per-layer where BNPB has no data for that spot (common - most of a city isn't
    inside any hazard zone, that's not a bug)."""
    out = {}
    for name in LAYERS:
        value = await _identify(name, lon, lat)
        out[name] = {"value": value, "class": _classify(value)} if value is not None else None
    return out
