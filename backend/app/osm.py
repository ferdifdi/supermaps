"""OpenStreetMap data via Overpass. Responses are cached on disk."""

import asyncio
import hashlib
import json

import httpx

from .config import CACHE_DIR, JABODETABEK_BBOX, OVERPASS_URLS

BASIC_NEEDS = ["restaurant", "fast_food", "cafe", "food_court", "marketplace", "pharmacy", "clinic"]
BASIC_SHOPS = ["convenience", "supermarket", "greengrocer", "bakery"]


async def overpass(query: str) -> dict:
    key = hashlib.sha1(query.encode()).hexdigest()
    path = CACHE_DIR / f"osm_{key}.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    # Short per-attempt timeout so a hanging mirror fails fast instead of eating the whole budget.
    timeout = httpx.Timeout(connect=10, read=30, write=10, pool=10)
    async with httpx.AsyncClient(timeout=timeout, headers={"User-Agent": "SuperMaps/1.0"}) as client:
        r = None
        for attempt in range(len(OVERPASS_URLS)):
            url = OVERPASS_URLS[attempt]
            try:
                r = await client.post(url, data={"data": query})
            except httpx.TransportError:  # host unreachable or timed out, try the next mirror
                r = None
                continue
            if r.status_code in (429, 504):  # rate limit / load shedding
                r = None
                continue
            r.raise_for_status()
            try:
                data = r.json()
            except json.JSONDecodeError:  # empty/truncated body, try the next mirror
                r = None
                continue
            break
        if r is None:
            raise httpx.ConnectError("all Overpass mirrors unreachable, rate-limited, or returned empty responses")
    path.write_text(json.dumps(data), encoding="utf-8")
    return data


def _bbox(area_bbox=None) -> str:
    w, s, e, n = area_bbox or JABODETABEK_BBOX
    return f"{s},{w},{n},{e}"


async def stations() -> list[dict]:
    """Rail stations (KRL/MRT/LRT) and major bus stations in Jabodetabek."""
    q = f"""
    [out:json][timeout:25];
    (
      node["railway"="station"]({_bbox()});
      node["railway"="halt"]({_bbox()});
      node["public_transport"="station"]["bus"="yes"]({_bbox()});
    );
    out center;
    """
    data = await overpass(q)
    out = []
    for el in data["elements"]:
        tags = el.get("tags", {})
        name = tags.get("name")
        if not name:
            continue
        out.append({
            "id": str(el["id"]),
            "name": name,
            "mode": tags.get("station") or tags.get("railway") or "bus",
            "operator": tags.get("operator", ""),
            "lon": el["lon"],
            "lat": el["lat"],
        })
    out.sort(key=lambda s: s["name"])
    return out


async def roads(lon: float, lat: float, radius: int) -> list[dict]:
    """Walkable road centerlines around a point: [{"coords": [[lon,lat],...], "highway": str}]"""
    q = f"""
    [out:json][timeout:25];
    way["highway"]["highway"!~"motorway|motorway_link|trunk|trunk_link"](around:{radius},{lat},{lon});
    out geom;
    """
    data = await overpass(q)
    return [
        {"coords": [[p["lon"], p["lat"]] for p in el["geometry"]], "highway": el["tags"]["highway"]}
        for el in data["elements"] if el.get("geometry")
    ]


async def pois(lon: float, lat: float, radius: int) -> list[dict]:
    """Amenities, shops, offices and buildings around a point."""
    q = f"""
    [out:json][timeout:25];
    (
      nwr["amenity"](around:{radius},{lat},{lon});
      nwr["shop"](around:{radius},{lat},{lon});
      nwr["office"](around:{radius},{lat},{lon});
      nwr["building"~"residential|apartments|house|commercial|retail|office"](around:{radius},{lat},{lon});
      nwr["leisure"~"park|garden"](around:{radius},{lat},{lon});
      nwr["landuse"~"grass|forest|recreation_ground"](around:{radius},{lat},{lon});
      way["waterway"~"river|stream|canal|drain"](around:{radius},{lat},{lon});
    );
    out center;
    """
    data = await overpass(q)
    out = []
    for el in data["elements"]:
        tags = el.get("tags", {})
        center = el.get("center") or el
        if "lon" not in center:
            continue
        out.append({
            "lon": center["lon"],
            "lat": center["lat"],
            "amenity": tags.get("amenity", ""),
            "shop": tags.get("shop", ""),
            "office": tags.get("office", ""),
            "building": tags.get("building", ""),
            "leisure": tags.get("leisure", ""),
            "landuse": tags.get("landuse", ""),
            "waterway": tags.get("waterway", ""),
            "name": tags.get("name", ""),
        })
    return out


def is_basic_need(poi: dict) -> bool:
    return poi["amenity"] in BASIC_NEEDS or poi["shop"] in BASIC_SHOPS


def is_residential(poi: dict) -> bool:
    return poi["building"] in ("residential", "apartments", "house")


def is_commercial(poi: dict) -> bool:
    return bool(poi["shop"] or poi["office"]) or poi["building"] in ("commercial", "retail", "office")


def is_green(poi: dict) -> bool:
    return bool(poi["leisure"] or poi["landuse"])
