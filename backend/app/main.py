import asyncio

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from . import ai, analysis, mapid, osm
from .config import MAPID_BASEMAP_KEY, MAPID_BASEMAP_URL, PUBLIC_BASE_URL, catalogue_layers
from .geo import buffer_deg

app = FastAPI(title="SuperMaps API")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


@app.exception_handler(httpx.TransportError)
async def overpass_down(request, exc):
    return Response('{"detail":"Overpass OSM API sedang tidak bisa diakses, coba lagi nanti."}',
                     status_code=502, media_type="application/json")

STYLES = ["street-v2.0", "satellite-v2.0", "dark-v2.0", "light-v2.0"]
_stations: dict[str, dict] = {}


async def get_station(station_id: str) -> dict:
    if not _stations:
        for s in await osm.stations():
            _stations[s["id"]] = s
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

@app.get("/api/stations")
async def list_stations():
    return await osm.stations()


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
async def walk_access(station_id: str, minutes: float = 10.0):
    return await analysis.walk_access(await get_station(station_id), minutes)


@app.get("/api/analysis/route")
async def route(station_id: str, lon: float, lat: float, preference: str = "comfort"):
    return await analysis.comfortable_route(await get_station(station_id), lon, lat, preference)


@app.get("/api/analysis/amenity-equity")
async def amenity_equity(station_id: str):
    return await analysis.amenity_equity(await get_station(station_id))


@app.get("/api/analysis/site-selection")
async def site_selection(station_id: str, category: str = "menugo", radius: int = 1000):
    station = await get_station(station_id)
    polygon = buffer_deg(station["lon"], station["lat"], radius).__geo_interface__
    features = await mapid.fetch_mission(category, polygon)
    competitors = [
        {"lon": f["geometry"]["coordinates"][0], "lat": f["geometry"]["coordinates"][1],
         "name": f["properties"].get("name", "")}
        for f in features if f["geometry"]["type"] == "Point"
    ]
    acts = await mapid.fetch_activities(polygon)
    demand = [
        {"lon": a["geometry"]["coordinates"][0], "lat": a["geometry"]["coordinates"][1]}
        for a in acts if a["geometry"]["type"] == "Point"
    ]
    return await analysis.site_selection(station, category, competitors, demand)


_dashboard: list[dict] = []  # last computed table; what-if and chat score against it


@app.get("/api/analysis/tod-dashboard")
async def tod_dashboard(modes: str = "KRL,MRT,LRT", limit: int = 25):
    """Ranked SCI table for the given comma-separated mode_labels (KRL/MRT/LRT/TJ).

    The index is relative, so every station in the table is standardised against the others.
    """
    wanted = [m for m in modes.split(",") if m]
    stations = [s for s in await osm.stations() if s["mode_label"] in wanted][:limit]
    if not stations:
        raise HTTPException(404, "no stations match those modes")

    # Public Overpass instances block IPs that send too many concurrent requests
    # (this project has been blocklisted before - see commit 336350c). One station
    # at a time keeps us well under that, at the cost of a slower first load.
    gate = asyncio.Semaphore(1)

    async def one(station):
        async with gate:
            return await analysis.station_indicators(station)

    indicators = await asyncio.gather(*(one(s) for s in stations))
    _dashboard[:] = analysis.tod_index(list(indicators))
    return {"rows": _dashboard, "metadata": analysis.metadata()}


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


@app.get("/api/analysis/resilience")
async def resilience(station_id: str):
    result = await analysis.resilience(await get_station(station_id))
    result.pop("graph")
    result.pop("origin")
    return result


@app.get("/api/analysis/detour")
async def detour(station_id: str, lon: float, lat: float):
    result = await analysis.resilience(await get_station(station_id))
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
