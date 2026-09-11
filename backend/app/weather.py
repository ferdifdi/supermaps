"""OpenWeatherMap Current Weather Data API - free tier. Requires OPENWEATHER_API_KEY
(config.py); without a key set, current() returns None immediately (no network call) so
the rest of the pipeline degrades gracefully, same pattern as airquality.py's OpenAQ
integration.

Shown as a small real-time context line in M-UC1's "Ringkasan" topic - not fed into
routing or any score, just a live temperature/feels-like reading for the station's area.
"""

import httpx

from .config import OPENWEATHER_API_KEY

BASE_URL = "https://api.openweathermap.org/data/2.5/weather"


async def current(lat: float, lon: float) -> dict | None:
    """Current temperature/feels-like/condition near (lat, lon), or None if
    OPENWEATHER_API_KEY isn't set or the request fails for any reason (timeout, non-2xx,
    malformed response) - mirrors airquality._get()'s graceful-degradation pattern."""
    if not OPENWEATHER_API_KEY:
        return None
    params = {"lat": lat, "lon": lon, "appid": OPENWEATHER_API_KEY, "units": "metric", "lang": "id"}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(BASE_URL, params=params)
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPError:
        return None
    try:
        main = data["main"]
        condition = data["weather"][0]["description"]
        return {
            "temp": round(main["temp"], 1),
            "feels_like": round(main["feels_like"], 1),
            "condition": condition,
        }
    except (KeyError, IndexError, TypeError):
        return None
