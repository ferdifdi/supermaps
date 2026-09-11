"""Joins field-survey trotoar activities (fetch_survey_activities.py +
analyze_sidewalk_quality.py output) to stations/halte, so the UI can flag which ones
have real field-survey photos/scores nearby, and show those photos/AI overlays in the
station's result panel. Loaded once from the precomputed GeoJSON/JSON - no live
computation, this is a static one-off dataset until more surveys are run."""

import json
from pathlib import Path

from shapely.geometry import Point

from .geo import to_m

DATA_DIR = Path(__file__).parent.parent / "data" / "survey_lapangan"
DATA_PATH = DATA_DIR / "analysis" / "activity_scores.geojson"
PHOTOS_PATH = DATA_DIR / "analysis" / "photo_results.json"
NEARBY_RADIUS_M = 400

_activities: list[dict] | None = None
_photos_by_activity: dict[str, list[dict]] | None = None


def _load() -> list[dict]:
    global _activities
    if _activities is not None:
        return _activities
    if not DATA_PATH.exists():
        _activities = []
        return _activities
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    _activities = []
    for f in data["features"]:
        lon, lat = f["geometry"]["coordinates"]
        _activities.append({"point_m": to_m(Point(lon, lat)), **f["properties"]})
    return _activities


def _load_photos() -> dict[str, list[dict]]:
    global _photos_by_activity
    if _photos_by_activity is not None:
        return _photos_by_activity
    _photos_by_activity = {}
    if not PHOTOS_PATH.exists():
        return _photos_by_activity
    for p in json.loads(PHOTOS_PATH.read_text(encoding="utf-8")):
        _photos_by_activity.setdefault(p["activity_id"], []).append({
            "photo": p["photo"], "overlay": p.get("overlay"),
            "composite_score": p["composite_score"], "label": p["label"],
        })
    return _photos_by_activity


def stations_with_survey(stations: list[dict], radius_m: float = NEARBY_RADIUS_M) -> dict[str, list[dict]]:
    """{station_id: [matching activity summaries]} for stations within radius_m of at
    least one field-survey activity point. Activity summaries drop the internal
    point_m key (not JSON-serializable)."""
    activities = _load()
    if not activities:
        return {}
    result = {}
    for s in stations:
        sp = to_m(Point(s["lon"], s["lat"]))
        matches = [{k: v for k, v in a.items() if k != "point_m"} for a in activities if sp.distance(a["point_m"]) <= radius_m]
        if matches:
            result[s["id"]] = matches
    return result


def activities_for_station(station: dict, radius_m: float = NEARBY_RADIUS_M) -> list[dict]:
    """Full detail (title/score/label + each analyzed photo+AI overlay) for every
    field-survey activity within radius_m of this station - for the station's result
    panel, not the picker's lightweight has_survey flag."""
    activities = _load()
    if not activities:
        return []
    photos_by_activity = _load_photos()
    sp = to_m(Point(station["lon"], station["lat"]))
    out = []
    for a in activities:
        if sp.distance(a["point_m"]) > radius_m:
            continue
        out.append({
            **{k: v for k, v in a.items() if k != "point_m"},
            "photos": photos_by_activity.get(a["activity_id"], []),
        })
    return out
