"""OpenAQ v3 (api.openaq.org) - free public air-quality API. Requires OPENAQ_API_KEY
(config.py); without a key set, every function returns None/empty so the rest of the
pipeline degrades gracefully instead of erroring.

Shown as its own raw layer in M-UC1's "Kenyamanan" tab (see analysis.py) - not fed into
routing or any composite score. AQI here is a neighborhood-level reading from the nearest
monitoring station(s), not a per-segment value - Jabodetabek's station density is too
sparse for that.
"""

import hashlib
import json

import httpx

from .config import CACHE_DIR, OPENAQ_API_KEY

BASE_URL = "https://api.openaq.org/v3"
SEARCH_RADIUS_M = 25000  # OpenAQ v3 max radius per request

# US EPA PM2.5 category breakpoints (ug/m3) - a published standard, not an invented scale.
PM25_BREAKPOINTS = [
    (12.0, "baik"),
    (35.4, "sedang"),
    (55.4, "tidak sehat bagi kelompok sensitif"),
    (150.4, "tidak sehat"),
    (float("inf"), "berbahaya"),
]


def _category(pm25: float) -> str:
    for limit, label in PM25_BREAKPOINTS:
        if pm25 <= limit:
            return label
    return PM25_BREAKPOINTS[-1][1]


async def _get(path: str, params: dict) -> dict | None:
    if not OPENAQ_API_KEY:
        return None
    key = hashlib.sha1(f"{path}{params}".encode()).hexdigest()
    cache_path = CACHE_DIR / f"openaq_{key}.json"
    if cache_path.exists():
        return json.loads(cache_path.read_text(encoding="utf-8"))
    async with httpx.AsyncClient(timeout=10, headers={"X-API-Key": OPENAQ_API_KEY}) as client:
        try:
            r = await client.get(f"{BASE_URL}{path}", params=params)
            r.raise_for_status()
            data = r.json()
        except httpx.HTTPError:
            return None
    cache_path.write_text(json.dumps(data), encoding="utf-8")
    return data


async def _reading(loc: dict) -> dict | None:
    """Latest PM2.5 value for one OpenAQ location, or None if it has no PM2.5 sensor or
    no recent reading (the /locations list includes long-dead stations - e.g. sensors
    with datetimeLast back in 2016 - so a location showing up nearby doesn't mean it's
    still reporting)."""
    sensor = next((s for s in loc.get("sensors", []) if s["parameter"]["name"] == "pm25"), None)
    if not sensor:
        return None
    latest = await _get(f"/locations/{loc['id']}/latest", {})
    if not latest or not latest.get("results"):
        return None
    result = next((r for r in latest["results"] if r["sensorsId"] == sensor["id"]), None)
    if not result:
        return None
    pm25 = result["value"]
    if pm25 < 0:  # OpenAQ uses negative sentinels (e.g. -999) for missing/invalid readings
        return None
    coords = loc.get("coordinates", {})
    return {
        "pm25": pm25, "category": _category(pm25),
        "station": loc.get("name", ""),
        "station_lon": coords.get("longitude"), "station_lat": coords.get("latitude"),
        "distance_m": round(loc["distance"]),
    }


async def _nearby_locations(lon: float, lat: float) -> list[dict]:
    """OpenAQ /locations doesn't support order_by=distance (only 'id' is valid there,
    confirmed against a live 422) - it returns results in an arbitrary order, so sort by
    the `distance` field the API does include in each result."""
    locations = await _get("/locations", {
        "coordinates": f"{lat},{lon}", "radius": SEARCH_RADIUS_M, "limit": 25,
    })
    if not locations or not locations.get("results"):
        return []
    return sorted(locations["results"], key=lambda loc: loc["distance"])


async def nearby_pm25(lon: float, lat: float) -> dict | None:
    """Latest PM2.5 reading from the nearest reporting OpenAQ station within
    SEARCH_RADIUS_M. None if OPENAQ_API_KEY isn't set or no station nearby reports PM2.5.
    """
    for loc in await _nearby_locations(lon, lat):
        reading = await _reading(loc)
        if reading:
            return reading
    return None


async def nearby_stations(lon: float, lat: float, limit: int = 8) -> list[dict]:
    """Up to `limit` reporting PM2.5 stations near a point, for the air-quality heatmap
    layer - unlike nearby_pm25 (nearest one, used as the routing comfort factor) this
    surfaces every nearby station so the map can show local variation, sparse as it is.
    """
    out = []
    for loc in await _nearby_locations(lon, lat):
        reading = await _reading(loc)
        if reading:
            out.append(reading)
        if len(out) >= limit:
            break
    return out
