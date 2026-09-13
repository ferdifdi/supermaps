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


def _nearest_station_ids(stations: list[dict], radius_m: float) -> dict[str, str]:
    """{activity_id: station_id} - each field-survey point assigned to its single, exact
    station, not every station within radius_m. Every activity's title names its station
    outright (surveyors wrote "Stasiun Bekasi", "Trotoar LRT Pancoran", etc), so that's
    matched first - the surveyor's own words beat a distance guess, and distance alone
    used to misfire whenever a dense TJ halte happened to sit geometrically closer than
    the actually-surveyed MRT/KRL/LRT station. Longest station-name match wins when a
    title contains more than one candidate name (e.g. "Bekasi" is a substring of "Bekasi
    Barat" too). Distance is only the fallback/tie-breaker: for a title with no name match
    at all, or several same-length name matches (e.g. a dozen "Pulo Gadung"-named TJ
    halte), whichever candidate is physically nearest wins. `stations` must be the FULL
    roster across every mode. Still capped at radius_m so a genuinely unrelated activity
    doesn't get force-assigned to whatever's nearest regardless of distance."""
    activities = _load()
    assignment: dict[str, str] = {}
    for a in activities:
        title = a.get("title", "").lower()
        name_matches = [s for s in stations if s["name"].lower() in title]
        if name_matches:
            best_len = max(len(s["name"]) for s in name_matches)
            candidates = [s for s in name_matches if len(s["name"]) == best_len]
        else:
            candidates = stations
        best_id, best_dist = None, None
        for s in candidates:
            d = to_m(Point(s["lon"], s["lat"])).distance(a["point_m"])
            if best_dist is None or d < best_dist:
                best_id, best_dist = s["id"], d
        # radius_m only gates the no-name-match fallback - a positive name match (the
        # surveyor's own words) is trusted regardless of distance; the photographed
        # street can legitimately be well past 400m from that station's own coordinates.
        if best_id is not None and (name_matches or best_dist <= radius_m):
            assignment[a["activity_id"]] = best_id
    return assignment


def stations_with_survey(stations: list[dict], radius_m: float = NEARBY_RADIUS_M) -> dict[str, list[dict]]:
    """{station_id: [matching activity summaries]}, one-to-one - each activity counted
    for its single nearest station only (see _nearest_station_ids). `stations` should be
    the full cross-mode roster, not a mode-filtered subset. Activity summaries drop the
    internal point_m key (not JSON-serializable)."""
    activities = _load()
    if not activities:
        return {}
    assignment = _nearest_station_ids(stations, radius_m)
    result: dict[str, list[dict]] = {}
    for a in activities:
        sid = assignment.get(a["activity_id"])
        if sid is None:
            continue
        result.setdefault(sid, []).append({k: v for k, v in a.items() if k != "point_m"})
    return result


def activities_for_station(station: dict, stations: list[dict], radius_m: float = NEARBY_RADIUS_M) -> list[dict]:
    """Full detail (title/score/label + each analyzed photo+AI overlay) for every
    field-survey activity whose single nearest station (across the full `stations`
    roster) is this one - for the station's result panel, not the picker's lightweight
    has_survey flag. Same one-to-one assignment as stations_with_survey, so this panel
    never shows a survey point that actually belongs to a neighboring interchange station."""
    activities = _load()
    if not activities:
        return []
    photos_by_activity = _load_photos()
    assignment = _nearest_station_ids(stations, radius_m)
    out = []
    for a in activities:
        if assignment.get(a["activity_id"]) != station["id"]:
            continue
        out.append({
            **{k: v for k, v in a.items() if k != "point_m"},
            "photos": photos_by_activity.get(a["activity_id"], []),
        })
    return out
