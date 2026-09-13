import asyncio
import json
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import ai, analysis, gtfs, lst, mapid, mapid_data, osm, static_transit, survey
from .config import MAPID_BASEMAP_KEY, MAPID_BASEMAP_URL, PUBLIC_BASE_URL, catalogue_layers
from .geo import buffer_deg

app = FastAPI(title="SuperMaps API")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

# Field-survey photos + AI overlay images (backend/data/survey_lapangan/{photos,analysis}/)
# served as plain static files - the frontend just needs a fetchable URL per photo, not
# an API response body.
_SURVEY_DIR = Path(__file__).parent.parent / "data" / "survey_lapangan"
if _SURVEY_DIR.exists():
    app.mount("/static/survey", StaticFiles(directory=str(_SURVEY_DIR)), name="survey-static")

# K-UC1 precomputed station indicators (see generate_kuc1_static.py) - one JSON per mode,
# {"generated_at": <ISO date>, "stations": [station_indicators() dicts]}. Read fresh each
# time (not cached in memory) since these are meant to be regenerated occasionally and
# the dashboard is requested rarely enough that re-reading a small JSON file costs nothing.
_KUC1_STATIC_DIR = Path(__file__).parent.parent / "data" / "k-uc1"

# Jakarta Airport Skytrain (APM) between the Soekarno-Hatta terminals - OSM tags it
# railway=light_rail same as LRT Jabodebek, but it's a separate airport people-mover
# system, not part of the LRT network the rest of K-UC1's LRT comparison represents.
# K-UC1-specific: other use cases' station picker still shows these under "LRT".
_KUC1_EXCLUDED_LRT_IDS = {"13257085881", "13257085882", "13257085883", "13257085884"}


def _load_kuc1_static(mode: str) -> dict | None:
    path = _KUC1_STATIC_DIR / f"{mode.lower()}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


@app.on_event("startup")
def _warm_caches():
    """Pay the one-time parse/reproject cost of the biggest MAPID categories (e.g.
    PERDAGANGAN DAN RETAIL, ~65MB, ~11s the slow way) at server boot instead of on
    whichever user's request happens to hit it first. Blocks startup briefly (once per
    deploy/restart) so every real request after that is warm."""
    mapid_data.warm_all()
    lst._load()


@app.exception_handler(httpx.TransportError)
async def overpass_down(request, exc):
    return Response('{"detail":"Overpass OSM API sedang tidak bisa diakses, coba lagi nanti."}',
                     status_code=502, media_type="application/json")

STYLES = ["street-v2.0", "satellite-v2.0", "dark-v2.0", "light-v2.0"]
_stations: dict[str, dict] = {}

# In-process result cache for the analysis endpoints - these recompute the same walk_score
# grid/road graph/isochrone from scratch on every call even when the inputs (station+
# radius+...) are identical to a request made moments ago, which is most repeat clicks
# (toggling a layer, reopening a station). Keyed on every query param that affects the
# result, values expire after _CACHE_TTL_S so any live-fallback data (PM2.5, InaRISK, etc.)
# still refreshes periodically and doesn't go stale for too long. First request for a given
# key is never faster - it still does the full computation - only repeats of that exact key
# get the shortcut. Process memory only: cleared on restart, not shared across workers if
# this ever runs with >1.
_CACHE_TTL_S = 300
_cache: dict[tuple, tuple[float, object]] = {}


async def _cached(key: tuple, factory):
    now = time.monotonic()
    hit = _cache.get(key)
    if hit is not None and now - hit[0] < _CACHE_TTL_S:
        return hit[1]
    result = await factory()
    _cache[key] = (now, result)
    return result


def _tj_stations() -> list[dict]:
    """TJ halte from GTFS (transjakarta.zip), not OSM - OSM's public_transport=station+
    bus=yes catch-all pulled in other operators' terminals mislabeled as TJ (see osm.py's
    mode_label() docstring), while GTFS is TransJakarta's own published stop list."""
    gtfs._load()
    return [
        {"id": f"gtfs:{sid}", "name": s["name"], "mode_label": "TJ",
         "operator": "TransJakarta", "lon": s["lon"], "lat": s["lat"]}
        for sid, s in gtfs._stops.items()
    ]


async def _rail_stations() -> list[dict]:
    """MRT/KRL/LRT only - TJ always comes from GTFS instead (see _tj_stations). Unlike the
    rest of this app's OSM data, the station dropdown stays static-only on purpose: it's a
    small, curated, manually-verified list (output/isochrone_*.py's *_stations.geojson),
    and live osm.stations() has previously mislabeled stations' modes (see osm.py's
    mode_label() docstring) - correctness matters more than freshness for a list this
    small and this rarely-changing. Live is only a last-resort fallback if the static file
    is missing entirely. Filters out any TJ-labeled entries the live fallback might
    return (OSM has some public_transport=station+bus=yes nodes tagged as TJ) - GTFS
    stays the one authority for TJ halte, not OSM."""
    cached = static_transit.stations()
    stations = cached if cached is not None else await osm.stations()
    return [s for s in stations if s["mode_label"] != "TJ"]


async def get_station(station_id: str) -> dict:
    await _full_roster()
    if station_id not in _stations:
        raise HTTPException(404, "station not found")
    return _stations[station_id]


# --- basemap proxy: keeps MAPID_API_KEY on the server ------------------------

@app.get("/api/basemap/styles")
def basemap_styles():
    return [{"name": s, "url": f"{PUBLIC_BASE_URL}/api/basemap/styles/{s}/style.json"} for s in STYLES]


@app.get("/api/basemap/{path:path}")
async def basemap_proxy(path: str):
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(f"{MAPID_BASEMAP_URL}/{path}", params={"key": MAPID_BASEMAP_KEY})
    if r.status_code != 200:
        raise HTTPException(r.status_code, "basemap upstream error")
    content_type = r.headers.get("content-type", "application/octet-stream")
    if "json" in content_type:
        body = r.text.replace(MAPID_BASEMAP_URL, f"{PUBLIC_BASE_URL}/api/basemap")
        return Response(body, media_type=content_type)
    return Response(r.content, media_type=content_type)


# --- stations ----------------------------------------------------------------

async def _full_roster() -> list[dict]:
    """Every station/halte across all 4 modes - one-to-one survey matching (survey.py)
    needs the full roster even when the caller only wants one mode back, otherwise it
    can't tell whether some OTHER mode's station is actually the nearest one to a given
    field-survey point. Reuses/populates the same _stations cache get_station() does."""
    if not _stations:
        for s in await _rail_stations():
            _stations[s["id"]] = s
        for s in _tj_stations():
            _stations[s["id"]] = s
    return list(_stations.values())


async def _with_survey_flags(stations: list[dict]) -> list[dict]:
    """Flags stations/halte with a one-to-one nearest field-survey activity match (see
    survey.stations_with_survey) - lets the picker surface "has real trotoar survey data"
    up front. Matches computed against the full cross-mode roster even when `stations`
    here is just one mode's subset, so the nearest-station assignment stays correct."""
    matches = survey.stations_with_survey(await _full_roster())
    return [
        {**s, "has_survey": s["id"] in matches, "survey_count": len(matches.get(s["id"], []))}
        for s in stations
    ]


@app.get("/api/stations")
async def list_stations(mode: str | None = None):
    if mode and mode.upper() == "TJ":
        return await _with_survey_flags(_tj_stations())
    stations = await _rail_stations()
    if mode:
        stations = [s for s in stations if s["mode_label"] == mode.upper()]
    return await _with_survey_flags(stations)


@app.get("/api/rail-lines")
async def rail_lines():
    """Full-line MRT/KRL/LRT track geometry (see static_transit.rail_lines_geojson) for
    an always-on map layer - not query-specific, so unlike every other /api/analysis/*
    endpoint this doesn't take a station_id."""
    return static_transit.rail_lines_geojson()


@app.get("/api/survey/station/{station_id}")
async def survey_for_station(station_id: str):
    """Full field-survey detail (title/score/label + every analyzed photo and its AI
    overlay image, as static URLs under /static/survey/) for a station's result panel."""
    station = await get_station(station_id)
    activities = survey.activities_for_station(station, await _full_roster())
    for a in activities:
        for p in a["photos"]:
            p["photo_url"] = f"{PUBLIC_BASE_URL}/static/survey/{p['photo']}"
            if p["overlay"]:
                p["overlay_url"] = f"{PUBLIC_BASE_URL}/static/survey/{p['overlay']}"
    return activities


# --- MAPID data --------------------------------------------------------------

class AreaBody(BaseModel):
    station_id: str
    radius: int = 1000


@app.post("/api/mapid/missions/{mission_type}")
async def missions(mission_type: str, body: AreaBody):
    if mission_type not in mapid.MISSION_TYPES:
        raise HTTPException(400, f"mission_type must be one of {mapid.MISSION_TYPES}")
    station = await get_station(body.station_id)
    polygon = buffer_deg(station["lon"], station["lat"], body.radius)
    return await mapid.fetch_mission(mission_type, polygon.__geo_interface__)


class ActivitiesBody(AreaBody):
    start_date: str | None = None
    end_date: str | None = None
    hashtag: list[str] | None = None
    author: str | None = None


@app.post("/api/mapid/activities")
async def activities(body: ActivitiesBody):
    station = await get_station(body.station_id)
    polygon = buffer_deg(station["lon"], station["lat"], body.radius)
    return await mapid.fetch_activities(
        polygon.__geo_interface__, body.start_date, body.end_date, body.hashtag, body.author
    )


@app.get("/api/mapid/catalogue")
def catalogue():
    return list(catalogue_layers())


@app.get("/api/mapid/catalogue/{name}")
async def catalogue_layer(name: str):
    if name not in catalogue_layers():
        raise HTTPException(404, "layer not configured in MAPID_LAYER_URLS")
    return await mapid.fetch_catalogue_layer(name)


# --- analysis ----------------------------------------------------------------

@app.get("/api/analysis/walk-access")
async def walk_access(station_id: str, radius_m: int = 800):
    async def factory():
        return await analysis.walk_access(await get_station(station_id), radius_m)
    return await _cached(("walk-access", station_id, radius_m), factory)


@app.get("/api/analysis/route")
async def route(station_id: str, lon: float, lat: float, preference: str = "fast"):
    async def factory():
        return await analysis.comfortable_route(await get_station(station_id), lon, lat, preference)
    return await _cached(("route", station_id, lon, lat, preference), factory)


@app.get("/api/analysis/amenity-equity")
async def amenity_equity(station_id: str, radius: int = 500):
    async def factory():
        return await analysis.amenity_equity(await get_station(station_id), radius)
    return await _cached(("amenity-equity", station_id, radius), factory)


@app.get("/api/analysis/site-selection")
async def site_selection(station_id: str, business_type: str = "APOTEK", subtype: str | None = None,
                          subtype2: str | None = None, radius: int | None = None):
    station = await get_station(station_id)
    if radius is None:
        radius = static_transit.MODE_RADIUS_M.get(station.get("mode_label", "").lower(), analysis.SITE_ANCHOR_RADIUS)

    async def factory():
        return await analysis.site_selection(station, business_type, subtype, subtype2, radius)
    return await _cached(
        ("site-selection", station_id, business_type, subtype, subtype2, radius), factory)


@app.get("/api/analysis/business-types")
def business_types():
    return mapid_data.BUSINESS_TYPES


@app.get("/api/analysis/business-subtypes")
def business_subtypes(prefix: str):
    """TIPE_2 - coarse subcategory (e.g. MAKANAN DAN MINUMAN -> RESTORAN/MINUMAN/dst)."""
    return mapid_data.subtypes(prefix)


@app.get("/api/analysis/business-subtypes2")
def business_subtypes2(prefix: str, subtype: str | None = None):
    """TIPE_3 - fine subcategory (e.g. RESTORAN -> RESTORAN PADANG/SEAFOOD/dst, or
    MINUMAN -> COFFEESHOP/MINUMAN BOBA DAN MILK TEA/dst), optionally narrowed to one
    TIPE_2 value first."""
    return mapid_data.subtypes2(prefix, subtype)


_dashboard: list[dict] = []  # last computed table; what-if and chat score against it


@app.get("/api/analysis/tod-dashboard")
async def tod_dashboard(modes: str = "KRL,MRT,LRT", limit: int = 200):
    """Ranked SCI table for the given comma-separated mode_labels (KRL/MRT/LRT).

    The index is relative, so every station in the table is standardised against the others -
    silently dropping stations past a low `limit` before ranking (the old default was 25,
    cutting KRL's 86 stations down to a fairly arbitrary first 25) meant "top station" and
    "bottom station" weren't actually the true top/bottom of the mode. 200 comfortably covers
    every included mode's real count (KRL is the largest at 86) - this is a safety ceiling now,
    not a practical cap. TJ is out of scope for K-UC1 entirely (see frontend/src/tod.js), so
    the thousands-of-halte case this used to guard against can't happen through this endpoint.

    No way to force this fully live (unlike every other use case, and there never was) -
    this scans EVERY station of the chosen mode(s) at once (up to `limit`), each one needing
    its own POI/road Overpass calls if forced live and not covered by the static cache
    (backend/data/k-uc1/, see generate_kuc1_static.py). Station enumeration itself
    (_rail_stations) is one live osm.stations() call, cached to disk by osm.py after the
    first hit - that part was never the problem; the semaphore below is what actually
    protects a live per-station scan from getting this project's IP rate-limited or
    blocklisted again (has happened before, see commit 336350c).
    """
    wanted = [m for m in modes.split(",") if m]
    all_stations = await _rail_stations() + (_tj_stations() if "TJ" in wanted else [])
    stations = [
        s for s in all_stations
        if s["mode_label"] in wanted and s["id"] not in _KUC1_EXCLUDED_LRT_IDS
    ][:limit]
    if not stations:
        raise HTTPException(404, "no stations match those modes")

    # Precomputed cache first (backend/data/k-uc1/{mode}.json, see
    # generate_kuc1_static.py) - a station whose mode has a cache skips the live Overpass
    # scan entirely. Per-mode, not per-station: if a mode's file exists it's trusted for
    # every station currently in that mode's list, missing individual stations just fall
    # through to live (e.g. one added since the cache was generated).
    cached_by_mode: dict[str, dict[str, dict]] = {}
    static_generated_at: dict[str, str] = {}
    for mode in set(wanted):
        data = _load_kuc1_static(mode)
        if data:
            cached_by_mode[mode] = {r["station_id"]: r for r in data["stations"]}
            static_generated_at[mode] = data.get("generated_at")

    # Public Overpass instances block IPs that send too many concurrent requests
    # (this project has been blocklisted before - see commit 336350c). One station
    # at a time keeps us well under that, at the cost of a slower first load. Only
    # stations actually missing from a cached mode ever reach this gate.
    gate = asyncio.Semaphore(1)

    async def one(station):
        cached = cached_by_mode.get(station["mode_label"], {}).get(station["id"])
        if cached is not None:
            return cached
        async with gate:
            return await analysis.station_indicators(station)

    indicators = await asyncio.gather(*(one(s) for s in stations))
    _dashboard[:] = analysis.tod_index(list(indicators))
    meta = analysis.metadata()
    meta["static_generated_at"] = static_generated_at
    return {"rows": _dashboard, "metadata": meta}


class WhatIfBody(BaseModel):
    station_id: str
    overrides: dict[str, float]


@app.post("/api/analysis/tod-whatif")
async def tod_whatif(body: WhatIfBody):
    if not _dashboard:
        raise HTTPException(409, "run /api/analysis/tod-dashboard first")
    return analysis.what_if(_dashboard, body.station_id, body.overrides)


@app.get("/api/analysis/tod-metadata")
def tod_metadata():
    return analysis.metadata()


async def _resilience_cached(station_id: str) -> dict:
    """Shared by /resilience and /detour - both used to call analysis.resilience()
    separately (scans/builds the graph for one station), so opening a station's detour tab
    right after its resilience tab redid the exact same work. Cached raw (graph/origin
    included, popped only in the /resilience response) so /detour can reuse it directly."""
    async def factory():
        return await analysis.resilience(await get_station(station_id))
    return await _cached(("resilience", station_id), factory)


@app.get("/api/analysis/resilience")
async def resilience(station_id: str):
    result = dict(await _resilience_cached(station_id))
    result.pop("graph")
    result.pop("origin")
    return result


@app.get("/api/analysis/detour")
async def detour(station_id: str, lon: float, lat: float):
    result = await _resilience_cached(station_id)
    return analysis.detour(result["graph"], result["origin"], lon, lat)


# --- AI ----------------------------------------------------------------------

class InsightBody(BaseModel):
    use_case: str
    audience: str
    summary: dict


@app.post("/api/ai/insight")
async def insight(body: InsightBody):
    return {"text": await ai.insight(body.use_case, body.audience, body.summary)}


class ChatBody(BaseModel):
    messages: list[dict]


@app.post("/api/ai/chat")
async def chat(body: ChatBody):
    if not _dashboard:
        raise HTTPException(409, "run /api/analysis/tod-dashboard first")
    return await ai.chat(body.messages, _dashboard)


class AskBody(BaseModel):
    use_case_id: str
    label: str
    messages: list[dict]
    result: dict
    model: str = "smart"


@app.post("/api/ai/ask")
async def ask(body: AskBody):
    try:
        answer = await ai.ask(body.use_case_id, body.label, body.messages, body.result, body.model)
    except ai.GroqRateLimited:
        other = "fast" if body.model == "smart" else "smart"
        raise HTTPException(429, f"Model sedang rate-limited. Coba ganti ke model \"{other}\".")
    return {"answer": answer}
