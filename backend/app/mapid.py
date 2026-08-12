"""MAPID API client. Contract: docs/mapid-api.md"""

import httpx

from .config import MAPID_CATALOGUE_KEY, MAPID_DATA_KEY, MAPID_SERVER_URL, catalogue_layers

MISSION_TYPES = ("propertigo", "menugo", "struckgo")
DATA_HEADERS = {"Content-Type": "application/json", "x-api-key": MAPID_DATA_KEY}


async def fetch_mission(mission_type: str, polygon: dict) -> list[dict]:
    """POST /web/competition/{mission-type}, follows pagination (limit is fixed at 100)."""
    features = []
    offset = 0
    async with httpx.AsyncClient(timeout=60) as client:
        while True:
            r = await client.post(
                f"{MAPID_SERVER_URL}/web/competition/{mission_type}",
                headers=DATA_HEADERS,
                json={"feature": polygon, "offset": offset},
            )
            r.raise_for_status()
            body = r.json()
            features.extend(body["features"])
            page = body["pagination"]
            if not page["hasMore"]:
                return features
            offset += page["limit"]


async def fetch_activities(polygon: dict, start_date=None, end_date=None, hashtag=None, author=None) -> list[dict]:
    """POST /web/competition/activities. start_date and end_date must be sent together."""
    payload = {"feature": polygon}
    if start_date and end_date:
        payload["start_date"] = start_date
        payload["end_date"] = end_date
    if hashtag:
        payload["hashtag"] = hashtag
    if author:
        payload["author"] = author
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(
            f"{MAPID_SERVER_URL}/web/competition/activities", headers=DATA_HEADERS, json=payload
        )
        r.raise_for_status()
        return r.json()["data"]["activities"]


async def fetch_catalogue_layer(name: str) -> dict:
    """GeoJSON from a MAPID Data Catalogue layer, merged across its per-kabupaten slices."""
    urls = catalogue_layers()[name]
    features = []
    async with httpx.AsyncClient(timeout=120) as client:
        for url in urls:
            r = await client.get(url, headers={"x-api-key": MAPID_CATALOGUE_KEY})
            r.raise_for_status()
            features.extend(r.json()["features"])
    return {"type": "FeatureCollection", "features": features}
