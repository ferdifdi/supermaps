"""TransJakarta GTFS (backend/data/gtfs/transjakarta.zip), the only Jabodetabek operator
with a public feed - checked: KRL, MRT Jakarta, LRT Jabodebek, and Jaklingko have no free
GTFS. Loaded once and kept in memory, same pattern as mapid_data.py.

Gives real headway (frequencies.txt) at TJ stops, used for transfer-efficiency wait time.
For KRL/MRT/LRT interchanges there's no schedule data, so analysis.py falls back to a
walking-distance-only proxy there - always flagged as PROXY, never presented as a real wait
time (see docs/m-uc1-gaps.md).
"""

import csv
import io
import zipfile
from pathlib import Path

from shapely.geometry import Point
from shapely.strtree import STRtree

from .geo import to_m

GTFS_ZIP = Path(__file__).resolve().parent.parent / "data" / "gtfs" / "transjakarta.zip"

# routes.txt's route_desc splits TJ's 240 routes into 7 categories (checked 2026-08-19):
# Mikrotrans (98 routes/~5820 halte, JakLingko feeder minibus), Angkutan Umum Integrasi
# (63/~2250, other integrated public transport), BRT (31/~535, the actual busway
# corridors), Transjabodetabek (18/~511, intercity express), Rusun (17/~395, low-cost
# housing shuttle), Royaltrans (10/~102, premium/express), Bus Wisata (3/~26, tourism).
# Only these 3 are in scope for this project - Mikrotrans alone would dominate every
# station/POI list by sheer halte count without adding much to the "mass transit near an
# MRT/KRL/LRT station" picture this project is about.
INCLUDED_ROUTE_CATEGORIES = {"Angkutan Umum Integrasi", "BRT", "Transjabodetabek"}

_stops: dict[str, dict] = {}
_stop_trip_ids: dict[str, set[str]] = {}
_trip_headway: dict[str, list[tuple[str, str, int]]] = {}
_points: list[Point] = []
_stop_ids: list[str] = []
_tree: STRtree | None = None


def _read(z: zipfile.ZipFile, name: str):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def _load():
    global _tree
    if _tree is not None:
        return
    if not GTFS_ZIP.exists():
        _tree = STRtree([])
        return
    with zipfile.ZipFile(GTFS_ZIP) as z:
        route_desc_by_id = {row["route_id"]: row.get("route_desc", "") for row in _read(z, "routes.txt")}
        included_trip_ids = {
            row["trip_id"] for row in _read(z, "trips.txt")
            if route_desc_by_id.get(row["route_id"]) in INCLUDED_ROUTE_CATEGORIES
        }

        all_stops = {}
        for row in _read(z, "stops.txt"):
            all_stops[row["stop_id"]] = {
                "name": row["stop_name"],
                "lon": float(row["stop_lon"]),
                "lat": float(row["stop_lat"]),
                "wheelchair": row.get("wheelchair_boarding", ""),
            }
        for row in _read(z, "stop_times.txt"):
            if row["trip_id"] not in included_trip_ids:
                continue
            _stop_trip_ids.setdefault(row["stop_id"], set()).add(row["trip_id"])
        for row in _read(z, "frequencies.txt"):
            if row["trip_id"] not in included_trip_ids:
                continue
            _trip_headway.setdefault(row["trip_id"], []).append(
                (row["start_time"], row["end_time"], int(row["headway_secs"]))
            )

        # A halte only makes the cut if at least one of its trips belongs to
        # INCLUDED_ROUTE_CATEGORIES - _stop_trip_ids is already filtered to those trips.
        for stop_id in _stop_trip_ids:
            _stops[stop_id] = all_stops[stop_id]

    for stop_id, s in _stops.items():
        _points.append(to_m(Point(s["lon"], s["lat"])))
        _stop_ids.append(stop_id)
    _tree = STRtree(_points) if _points else STRtree([])


def nearby_stops(lon: float, lat: float, radius: int) -> list[dict]:
    """TJ stops within `radius`, each with the real average headway during `period`
    baked in (see headway_minutes) so callers don't need a second pass."""
    _load()
    if not _points:
        return []
    origin = to_m(Point(lon, lat))
    idx = _tree.query(origin.buffer(radius))
    out = []
    for i in idx:
        stop_id = _stop_ids[i]
        dist = _points[i].distance(origin)
        if dist > radius:
            continue
        s = _stops[stop_id]
        out.append({
            "stop_id": stop_id, "name": s["name"], "lon": s["lon"], "lat": s["lat"],
            "distance_m": round(dist), "wheelchair": s["wheelchair"],
            "headway_min_peak": headway_minutes(stop_id, "06:00:00", "09:00:00"),
        })
    return out


def headway_minutes(stop_id: str, start: str, end: str) -> float | None:
    """Average scheduled headway (minutes) across every trip serving this stop whose
    frequency window overlaps [start, end). None if the stop has no frequency data for
    that window - GTFS time strings are zero-padded HH:MM:SS (can exceed 24:00:00 for
    past-midnight trips), so plain string comparison already sorts correctly within a day.
    """
    _load()
    secs = [
        h for trip_id in _stop_trip_ids.get(stop_id, ())
        for w_start, w_end, h in _trip_headway.get(trip_id, ())
        if w_start < end and w_end > start
    ]
    return round(sum(secs) / len(secs) / 60, 1) if secs else None
