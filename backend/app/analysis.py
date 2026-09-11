"""Spatial analysis for the five SuperMaps use cases.

Weights follow the proposal (Siburian et al., 2020).
Proxies used where a free national dataset is not available are marked PROXY.
"""

import asyncio

import httpx
import numpy as np
from scipy.spatial import Voronoi
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

from . import airquality, gtfs, inarisk, lst, mapid_data, mapid_environment, network, osm, static_poi, static_transit, weather
from .geo import fc, feature, grid, hex_grid, intersections, normalize, to_deg, to_m, to_m_points

WALK_BUFFER = 500
TOD_BUFFER = 400
CORRIDOR_BUFFER = 40
CELL = 250

WALK_WEIGHTS = {"road_network": 0.40, "ped_shed": 0.30, "intersection": 0.20, "residential_mix": 0.10}

# Siburian et al. (2020) Table 1: 8 criteria, 18 indicators. Criterion weights sum to 0.99
# in the paper (rounding), so the roll-up divides by the actual total rather than assuming 1.0.
CRITERIA = {
    "density": {"weight": 0.15, "indicators": {
        "population_density": 0.67, "commercial_density": 0.33}},
    "land_use_diversity": {"weight": 0.03, "indicators": {
        "land_use_diversity": 1.00}},
    "walk_access": {"weight": 0.06, "indicators": {
        "residential_diversity": 0.10, "road_network": 0.40, "intersection": 0.20, "ped_shed": 0.30}},
    "economy": {"weight": 0.22, "indicators": {
        "business_density": 1.00}},
    "station_capacity": {"weight": 0.19, "indicators": {
        "passengers_peak": 0.67, "passengers_offpeak": 0.33}},
    "station_facility": {"weight": 0.11, "indicators": {
        "safety": 0.50, "information_display": 0.50}},
    "accessibility": {"weight": 0.15, "indicators": {
        "train_trips": 0.40, "branching": 0.30, "alt_transport": 0.20, "accessible_buildings": 0.10}},
    "parking": {"weight": 0.08, "indicators": {
        "car_parking": 0.67, "motorcycle_parking": 0.33}},
}

# Where each indicator's number actually comes from. Shown as a badge in the UI so a
# stand-in is never mistaken for measurement.
SOURCES = {
    "population_density": "OSM",
    "commercial_density": "MAPID",  # PERDAGANGAN DAN RETAIL
    "land_use_diversity": "MIXED",  # OSM residential/green + MAPID retail/office
    "residential_diversity": "MIXED",  # OSM residential/green + MAPID retail/office/basic-need
    "road_network": "OSM", "intersection": "OSM",
    "ped_shed": "OSM",
    "business_density": "MAPID",  # KANTOR
    "accessible_buildings": "OSM",
    "branching": "OSM",
    "alt_transport": "MIXED",  # OSM stations + GTFS TJ halte
    "car_parking": "OSM", "motorcycle_parking": "OSM",
    # No free ridership feed: MAPID office/all-day-activity density stands in for passenger load.
    "passengers_peak": "PROXY", "passengers_offpeak": "PROXY",
    # The paper measured these by field survey; OSM tagging is the closest automatable stand-in.
    "safety": "PROXY", "information_display": "PROXY",
    # The paper scored every station identically here (single MRT track).
    "train_trips": "CONSTANT",
}

LABELS = {
    "population_density": "Kepadatan penduduk", "commercial_density": "Kepadatan komersial",
    "land_use_diversity": "Keragaman guna lahan", "residential_diversity": "Keragaman permukiman",
    "road_network": "Jaringan jalan", "intersection": "Persimpangan",
    "ped_shed": "Jangkauan pejalan kaki", "business_density": "Kepadatan bisnis",
    "passengers_peak": "Penumpang jam sibuk", "passengers_offpeak": "Penumpang di luar jam sibuk",
    "safety": "Keamanan & keselamatan", "information_display": "Papan informasi",
    "train_trips": "Frekuensi perjalanan", "branching": "Percabangan jalur",
    "alt_transport": "Transportasi alternatif", "accessible_buildings": "Bangunan terjangkau jalan kaki",
    "car_parking": "Parkir mobil", "motorcycle_parking": "Parkir motor",
}

CRITERIA_LABELS = {
    "density": "Kepadatan", "land_use_diversity": "Keragaman guna lahan",
    "walk_access": "Akses jalan kaki", "economy": "Ekonomi",
    "station_capacity": "Kapasitas stasiun", "station_facility": "Fasilitas stasiun",
    "accessibility": "Aksesibilitas dari & ke stasiun", "parking": "Ketersediaan parkir",
}

INDICATOR_WEIGHT = {
    ind: crit["weight"] * w
    for crit in CRITERIA.values()
    for ind, w in crit["indicators"].items()
}
INDICATOR_CRITERION = {
    ind: name for name, crit in CRITERIA.items() for ind in crit["indicators"]
}
TOTAL_WEIGHT = sum(c["weight"] for c in CRITERIA.values())


async def _roads_for(station: dict, radius: int) -> list[dict]:
    """Live osm.roads() first. Falls back to the precomputed static network
    (output/isochrone_*.py) only if that live Overpass call itself fails (network error,
    timeout, bad/rate-limited response - see osm.py's overpass()), not merely because the
    station's mode/radius isn't covered by the static file (static_transit.MODE_RADIUS_M -
    800m for MRT/KRL/LRT, 400m for TJ). If the static file doesn't cover it either, the
    failure propagates."""
    try:
        return await osm.roads(station["lon"], station["lat"], radius)
    except httpx.TransportError:
        roads = static_transit.roads_near(station.get("mode_label", ""), station["lon"], station["lat"], radius)
        if roads is None:
            raise
        return roads


async def _context(station: dict, radius: int):
    """Road graph, residential-building POIs and the station buffer, all in metric CRS.

    Sequential, not gathered - public Overpass instances block IPs that fire too
    many concurrent requests (this project has been blocklisted before).

    residential comes from a live osm.residential_pois() call; `pois_ok` tells callers
    whether that call actually succeeded. Callers use the live `residential` list when
    pois_ok is True and only fall back to their static cache file when it's False - i.e.
    when the live fetch itself failed, not just because the static file doesn't cover
    this station/radius. Commercial/basic-need/office POIs never come through here -
    they're MAPID Data Catalogue only now, with no OSM fallback (MAPID's coverage of
    those categories is complete across Jabodetabek, see mapid_data.py).
    """
    roads = await _roads_for(station, radius)
    try:
        residential = await osm.residential_pois(station["lon"], station["lat"], radius)
        pois_ok = True
    except httpx.TransportError:
        residential = []
        pois_ok = False
    graph = network.build(roads)
    origin = to_m(Point(station["lon"], station["lat"]))
    buffer_m = origin.buffer(radius)
    lines = [LineString([to_m(Point(x, y)) for x, y in r["coords"]]) for r in roads]
    return roads, residential, graph, origin, buffer_m, lines, pois_ok


def _poi_count_grid(cells, points_m: list[Point]) -> list[int]:
    """Raw count of `points_m` per cell - same 250m grid as access_by_walking, so the
    green heatmap reads as a density choropleth (like M-UC2's POI heatmap) instead of a
    screen-pixel-radius blur that shifts with zoom."""
    return [sum(1 for p in points_m if c.contains(p)) for c in cells]


def _residential_points_for(station: dict, radius: int, residential: list[dict], pois_ok: bool) -> list[Point]:
    """Residential building points (metric CRS) for walk_score's residential_mix - the
    already-fetched live osm.residential_pois() list when that fetch succeeded (pois_ok),
    else falls back to the static cached file (output/poi_residential_*.py) for this
    mode/radius. Empty if neither is available. `residential` is already filtered to
    building=residential/apartments/house by the query itself, so no predicate needed."""
    if pois_ok:
        return [to_m(Point(p["lon"], p["lat"])) for p in residential]
    static = static_poi.residential_near(station.get("mode_label", ""), station["lon"], station["lat"], radius)
    return [to_m(Point(p["lon"], p["lat"])) for p in static] if static is not None else []


def _commercial_points_for(station: dict, radius: int) -> list[Point]:
    """Commercial points (metric CRS) for walk_score's residential_mix - MAPID Data
    Catalogue's PERDAGANGAN DAN RETAIL only (same source K-UC1's commercial_density
    uses). No OSM fallback anymore: MAPID's coverage of retail/commercial categories is
    complete across Jabodetabek, so an empty result here is a real "no retail nearby",
    not a coverage gap to patch with OSM."""
    mapid_retail = mapid_data.retail(station["lon"], station["lat"], radius)
    return [to_m(Point(p["lon"], p["lat"])) for p in mapid_retail]


def _ped_shed_ratio(cell, tree, lines, radius=100.0, grid_n=5):
    """Fraction of a sampled grid inside the cell that's within `radius` of any road.

    Avoids buffering the whole road network (expensive for many disjoint segments);
    point-to-nearest-line distance via the spatial index is much cheaper.
    """
    minx, miny, maxx, maxy = cell.bounds
    step_x, step_y = (maxx - minx) / grid_n, (maxy - miny) / grid_n
    hits = 0
    for i in range(grid_n):
        for j in range(grid_n):
            pt = Point(minx + (i + 0.5) * step_x, miny + (j + 0.5) * step_y)
            candidates = tree.query(pt.buffer(radius))
            if any(lines[k].distance(pt) <= radius for k in candidates):
                hits += 1
    return hits / (grid_n * grid_n)


def _walk_score_grid(cells, lines, nodes, residential, commercial):
    road_union = unary_union(lines)
    tree = STRtree(lines)
    road_len, shed, cross, mix = [], [], [], []
    for c in cells:
        road_len.append(road_union.intersection(c).length)
        shed.append(_ped_shed_ratio(c, tree, lines))
        cross.append(sum(1 for n in nodes if c.contains(n)))
        res = sum(1 for p in residential if c.contains(p))
        com = sum(1 for p in commercial if c.contains(p))
        mix.append(com / (res + com) if res + com else 0.0)
    return {
        "road_network": normalize(road_len),
        "ped_shed": np.asarray(shed),
        "intersection": normalize(cross),
        "residential_mix": np.asarray(mix),
    }


# --- M-UC1: comfortable navigation ------------------------------------------

# "comfort" stays an internal edge weight (network.py) - accessible = comfort * wheelchair
# factor - but isn't offered as its own route preference: it's a self-built formula
# (sidewalk/lit/surface/shade/AQI tag multipliers), not from Siburian et al. or any other
# validated source, so presenting it as "rute ternyaman" overstated what it actually is.
ROUTE_WEIGHTS = {"fast": "length", "accessible": "accessible"}


async def _walk_graph(station: dict, radius: int):
    """Like _context, but also fetches green POIs, trees and air quality for the
    "Kenyamanan" tab's display layers (green_grid, air_quality_grid, ecology_poi) - those
    aren't routing inputs (see network.py), just shown as-is, so this is the one place
    all three get pulled.

    Green: live osm.green_pois() first, falling back to the static green-space file
    (output/poi_green_*.py) only if that live call fails - MAPID has no POI-level green
    layer (see osm.green_pois()'s docstring). Trees: same live-first pattern via
    osm.trees(), falling back to the static file's "tree" kind. OpenAQ (air_quality) is
    always live either way - a real-time feed with no static snapshot concept."""
    roads, residential, graph, origin, buffer_m, lines, pois_ok = await _context(station, radius)
    try:
        green = await osm.green_pois(station["lon"], station["lat"], radius)
        green_ok = True
    except httpx.TransportError:
        green = []
        green_ok = False
    try:
        raw_trees = await osm.trees(station["lon"], station["lat"], radius)
    except httpx.TransportError:
        static_green = static_poi.green_near(station.get("mode_label", ""), station["lon"], station["lat"], radius)
        raw_trees = [{"lon": p["lon"], "lat": p["lat"]} for p in static_green if p["kind"] == "tree"] \
            if static_green is not None else []
    aq = await airquality.nearby_pm25(station["lon"], station["lat"])
    # graph already built once inside _context() above - rebuilding it here from the same
    # `roads` list was pure duplicate work (measured: this alone made M-UC1's walk_access
    # noticeably slower than U-UC1's site_selection, which only goes through _context()).
    return roads, residential, graph, origin, buffer_m, lines, aq, raw_trees, pois_ok, green, green_ok


def _accessibility_summary(roads: list[dict]) -> dict:
    """Share of road length with a usable sidewalk / explicit wheelchair access - the
    info layer for gap #4, independent of any single route."""
    total = sidewalk = wheelchair_ok = wheelchair_no = 0.0
    # Bulk-reproject every road's coordinates in one shot instead of to_m(Point(...)) per
    # point - same fix as network.build()/mapid_data.py, this loop runs over the exact
    # same `roads` list network.build() just processed.
    lons, lats, bounds = [], [], [0]
    for r in roads:
        for lon, lat in r["coords"]:
            lons.append(lon)
            lats.append(lat)
        bounds.append(len(lons))
    all_pts = to_m_points(lons, lats) if lons else []
    for i, r in enumerate(roads):
        pts = all_pts[bounds[i]:bounds[i + 1]]
        length = sum(a.distance(b) for a, b in zip(pts, pts[1:]))
        total += length
        if r.get("sidewalk") in ("both", "left", "right", "yes"):
            sidewalk += length
        if r.get("wheelchair") in ("yes", "limited"):
            wheelchair_ok += length
        elif r.get("wheelchair") == "no":
            wheelchair_no += length
    if total == 0:
        return {"sidewalk_ratio": None, "wheelchair_tagged_ratio": None, "wheelchair_no_ratio": None}
    return {
        "sidewalk_ratio": round(sidewalk / total, 3),
        "wheelchair_tagged_ratio": round(wheelchair_ok / total, 3),
        "wheelchair_no_ratio": round(wheelchair_no / total, 3),
    }


async def _transfer_points(station: dict, radius: int) -> dict:
    """Transfer-efficiency layer (gap #1). TransJakarta stops get a real average headway
    from GTFS frequencies.txt (is_proxy=False). KRL/MRT/LRT points only have station
    identity, no schedule data exists for them, so they carry walking distance only and
    is_proxy=True - the frontend must show that distinction, not present them as equal.

    Rail mode comes from a live osm.stations() call first - mode_label() there resolves
    from the full station=*/railway=*/operator tag set, not a bare `railway` tag, which
    used to mislabel MRT/LRT stations as "KRL" whenever they lacked a station=* subtag,
    e.g. Blok M BCA. Falls back to the static snapshot (static_transit.stations(),
    output/isochrone_*.py) only if that live call fails - same pattern as
    _transit_points_near.
    """
    origin_m = to_m(Point(station["lon"], station["lat"]))
    real = gtfs.nearby_stops(station["lon"], station["lat"], radius)
    points = [{
        "name": s["name"], "lon": s["lon"], "lat": s["lat"], "mode": "TJ",
        "distance_m": s["distance_m"], "headway_min_peak": s["headway_min_peak"],
        "wheelchair": s["wheelchair"] or None, "is_proxy": False,
    } for s in real]
    seen = {(round(s["lon"], 5), round(s["lat"], 5)) for s in real}

    try:
        rail = await osm.stations()
    except httpx.TransportError:
        rail = static_transit.stations()
        if rail is None:
            raise

    for st in rail:
        key = (round(st["lon"], 5), round(st["lat"], 5))
        if key in seen or not st.get("name"):
            continue
        dist = to_m(Point(st["lon"], st["lat"])).distance(origin_m)
        if dist > radius:
            continue
        seen.add(key)
        points.append({
            "name": st["name"], "lon": st["lon"], "lat": st["lat"], "mode": st.get("mode_label", "KRL"),
            "distance_m": round(dist), "headway_min_peak": None,
            "wheelchair": None, "is_proxy": True,
        })

    points.sort(key=lambda x: x["distance_m"])
    # lon/lat already WGS84 (from GTFS/OSM) - build the FeatureCollection directly
    # instead of via feature()/to_deg, which expect a metric geometry.
    return fc([
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]}, "properties": p}
        for p in points
    ])


AQ_HEX_SIZE = 35  # meters, center-to-vertex - fine enough to read as a spread across the
# walk buffer without being so small it looks noisy.


def _air_quality_grid(buffer_m, aq_stations: list[dict]) -> dict:
    """PM2.5 choropleth: a fine hex grid inside the walk buffer, each cell's value
    inverse-distance-weighted from nearby real OpenAQ stations. Polygons (not points) so
    the frontend can render a plain fill layer - a maplibre "heatmap" layer blurs by
    screen-space pixel radius, which visibly shifts color as you zoom; a fill choropleth
    doesn't have that problem. Hexagons (not squares) avoid the grid's directional bias,
    which reads better for a continuous interpolated field than the walk_score's square grid.
    """
    if not aq_stations:
        return fc([])
    station_pts = [to_m(Point(s["station_lon"], s["station_lat"])) for s in aq_stations]
    cells = hex_grid(buffer_m, AQ_HEX_SIZE)
    features = []
    for c in cells:
        centroid = c.centroid
        weights, values = [], []
        for pt, s in zip(station_pts, aq_stations):
            d = max(centroid.distance(pt), 1.0)
            weights.append(1.0 / d**2)
            values.append(s["pm25"])
        pm25 = sum(w * v for w, v in zip(weights, values)) / sum(weights)
        features.append(feature(c, {"pm25": round(pm25, 1), "category": airquality._category(pm25)}))
    return fc(features)


async def walk_access(station: dict, radius_m: int = 800):
    """radius_m: 400 or 800 - selects both how far roads/POIs are pulled (static network
    covers up to static_transit.MODE_RADIUS_M per mode - 800m for MRT/KRL/LRT, 400m for
    TJ) and the isochrone cutoff itself, so the two always agree - a bigger isochrone
    than the fetched network would just clip silently at the fetch edge.

    Road network/isochrone try live Overpass first, falling back to the static cache only
    if that live call fails (see _roads_for). OSM-derived residential/green POI and trees
    follow the same live-first pattern; commercial points come from MAPID Data Catalogue
    only, no OSM fallback. OpenAQ air quality is always live, no static snapshot exists
    for it (see _walk_graph)."""
    roads, residential, graph, origin, buffer_m, lines, aq, raw_trees, pois_ok, green, green_ok = \
        await _walk_graph(station, radius_m)
    minutes = radius_m / network.WALK_SPEED / 60

    # Access by Walking (Siburian et al. 2020, Table 1 weights: Road Network 40%,
    # Ped-Shed 30%, Intersection 20%, Residential Diversity 10%) as one heatmap, min-max
    # standardised per 250m cell within this buffer - a spatial stand-in for the paper's
    # own cross-station standardisation (formula 3), which needs a comparison set that
    # doesn't exist for a single commuter looking at one station. K-UC1's tod_index()
    # does the literal station-vs-station version.
    cells = grid(buffer_m, CELL)
    parts = _walk_score_grid(
        cells, lines, intersections(lines),
        _residential_points_for(station, radius_m, residential, pois_ok), _commercial_points_for(station, radius_m),
    )
    access_score = sum(parts[k] * w for k, w in WALK_WEIGHTS.items())
    # grid_id: stable 1-based index by scan order (not a score ranking) - lets the AI
    # insight/ask features and the map label the exact same cell consistently across the
    # grid/green_grid/lst layers, all of which iterate this same `cells` list.
    access_features = [
        feature(c, {
            "grid_id": i + 1,
            "access_by_walking": round(float(access_score[i]), 3),
            **{k: round(float(parts[k][i]), 3) for k in WALK_WEIGHTS},
        })
        for i, c in enumerate(cells)
    ]

    # Precomputed entrance-aware polygon first (output/isochrone_*.py walked from every
    # real OSM entrance/exit found for the station, not just its center point) - only a
    # hit when radius_m matches that mode's precomputed cutoff exactly. No static
    # equivalent exists for the wheelchair-aware variant, that's always computed live.
    static_station_id = station["id"].removeprefix("gtfs:")
    iso_fast_static = static_transit.isochrone_for(station.get("mode_label", ""), static_station_id, radius_m)
    iso_fast = iso_fast_static if iso_fast_static is not None else network.isochrone(graph, origin, minutes, "length")
    iso_accessible = network.isochrone(graph, origin, minutes, "accessible")
    transfer = await _transfer_points(station, radius_m)
    aq_stations = await airquality.nearby_stations(station["lon"], station["lat"])
    air_quality_grid = _air_quality_grid(buffer_m, aq_stations)
    # Real-time temp/feels-like context for the walk summary - None end-to-end when
    # OPENWEATHER_API_KEY isn't set (see weather.py), same degrade-gracefully pattern as aq.
    current_weather = await weather.current(station["lat"], station["lon"])

    # "Kenyamanan" tab (comfort context): raw environmental layers only, no composite
    # score - user explicitly rejected building a comfort index on top of these. Tree
    # points themselves aren't returned raw anymore (see green_grid below) - only their
    # count, folded into the 250m green density grid together with green_area/shelter.
    # `green` is the live osm.green_pois() list from _walk_graph ("green_area"/"shelter"
    # equivalent, trees already counted into green_grid above) when that fetch succeeded
    # (green_ok) - falls back to the static green-space file (output/poi_green_*.py) only
    # if it failed. Static rows only carry "kind"/"name" (not the original leisure/landuse
    # tag value the live path has), so the two paths' properties differ slightly.
    if green_ok:
        ecology_poi = fc([
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]},
             "properties": {"leisure": p["leisure"], "landuse": p["landuse"], "name": p["name"]}}
            for p in green
        ])
    else:
        static_green = static_poi.green_near(station.get("mode_label", ""), station["lon"], station["lat"], radius_m)
        green = [p for p in static_green if p["kind"] in ("green_area", "shelter")] if static_green is not None else []
        ecology_poi = fc([
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]},
             "properties": {"kind": p["kind"], "name": p["name"]}}
            for p in green
        ])
    # Green density per 250m cell (trees + green_area/shelter combined) - same grid as
    # access_by_walking, count-based choropleth instead of a blur-radius heatmap.
    green_points_m = [to_m(Point(t["lon"], t["lat"])) for t in raw_trees] + \
        [to_m(Point(p["lon"], p["lat"])) for p in green]
    green_counts = _poi_count_grid(cells, green_points_m)
    green_grid = fc([
        feature(c, {"grid_id": i + 1, "green_count": green_counts[i]})
        for i, c in enumerate(cells)
    ])

    # Raw per-segment wheelchair/sidewalk tags as their own map, not folded into any score.
    accessibility_roads = fc([
        {"type": "Feature", "geometry": {"type": "LineString", "coordinates": r["coords"]},
         "properties": {"wheelchair": r.get("wheelchair") or None, "sidewalk": r.get("sidewalk") or None,
                        "highway": r["highway"]}}
        for r in roads
    ])

    # MAPID Data Catalogue - published values shown as-is (see mapid_environment.py).
    buffer_deg = to_deg(buffer_m)
    ecology_index = mapid_environment.ecology_index(buffer_deg)
    rainfall = mapid_environment.rainfall(buffer_deg)
    # Real LST (Land Surface Temperature) raster, replacing MAPID's coarse UHI polygon for
    # M-UC1 only (K-UC2's resilience() keeps the old mapid_environment.uhi() untouched) -
    # same 250m grid cells as access_by_walking, one seasonal raster picked by current month.
    lst_season = lst.current_season()
    lst_grid = lst.sample_grid(cells, lst_season)

    return {
        "grid": fc(access_features),
        "isochrone": fc([
            feature(iso_fast, {"kind": "fastest", "minutes": minutes, "radius_m": radius_m}),
            feature(iso_accessible, {"kind": "accessible", "minutes": minutes, "radius_m": radius_m}),
        ]),
        "transfer_points": transfer,
        "air_quality_grid": air_quality_grid,
        "air_quality_stations": aq_stations,
        "weather": current_weather,
        "ecology_poi": ecology_poi,
        "green_grid": green_grid,
        "accessibility_roads": accessibility_roads,
        "lst": lst_grid,
        "lst_season": lst_season,
        "ecology_index": ecology_index,
        "rainfall": rainfall,
        "summary": {
            "transfer_points_real": sum(1 for t in transfer["features"] if not t["properties"]["is_proxy"]),
            "transfer_points_proxy": sum(1 for t in transfer["features"] if t["properties"]["is_proxy"]),
            "air_quality": aq,
            "station": station["name"],
            "cells": len(cells),
            "mean_access_by_walking": round(float(access_score.mean()), 3),
            "access_by_walking_components": {k: round(float(parts[k].mean()), 3) for k in WALK_WEIGHTS},
            "isochrone_area_ha": round(iso_fast.area / 10000, 1),
            "accessible_area_ha": round(iso_accessible.area / 10000, 1),
            "tree_count": len(raw_trees),
            "green_space_count": len(green),
            **_accessibility_summary(roads),
        },
    }


async def comfortable_route(station: dict, dest_lon: float, dest_lat: float, preference: str = "fast"):
    roads, _, graph, origin, _, _, _, _, _, _, _ = await _walk_graph(station, WALK_BUFFER * 3)
    dest = to_m(Point(dest_lon, dest_lat))
    weight = ROUTE_WEIGHTS.get(preference, "length")
    line, stats = network.route(graph, origin, dest, weight)
    return {"route": fc([feature(line, {"preference": preference, **stats})]), "summary": stats}


# --- M-UC2: food & amenity equity -------------------------------------------

EQUITY_CATEGORIES = mapid_data.BASIC_NEED_CATEGORIES


async def amenity_equity(station: dict, radius: int = WALK_BUFFER):
    """Real walk-network reach (isochrone), not a straight-line buffer - a river or a
    highway between the station and a POI means it isn't actually reachable on foot,
    even if it's geometrically within `radius`.

    Basic-need POIs come from MAPID Data Catalogue only - Indonesia's food/health
    categories are fully covered there for Jabodetabek, so there's no OSM fallback
    anymore - and roads come from the precomputed static network when available (see
    _roads_for). An empty MAPID result for a station/radius is a real "no basic-need POIs
    nearby" (a desert), not a coverage gap to patch with OSM's much sparser tagging.
    """
    roads = await _roads_for(station, radius)
    graph = network.build(roads)
    origin = to_m(Point(station["lon"], station["lat"]))
    minutes = radius / network.WALK_SPEED / 60
    reach = network.isochrone(graph, origin, minutes, "length")

    raw_pois = mapid_data.basic_needs(station["lon"], station["lat"], radius)
    all_basic = [to_m(Point(p["lon"], p["lat"])) for p in raw_pois]
    inside = [reach.contains(p) for p in all_basic]

    poi_features = [
        feature(p, {
            "name": r["name"], "category": r["category"], "reachable": ins,
            "tipe_2": r["tipe_2"], "tipe_3": r["tipe_3"], "alamat": r["alamat"],
            "telepon": r["telepon"], "status": r["status"],
            "kecamatan": r["kecamatan"], "desa": r["desa"],
        })
        for p, r, ins in zip(all_basic, raw_pois, inside)
    ]

    category_summary = {}
    for cat in EQUITY_CATEGORIES:
        cat_inside = sum(1 for r, ins in zip(raw_pois, inside) if r["category"] == cat and ins)
        cat_total = sum(1 for r in raw_pois if r["category"] == cat)
        category_summary[cat] = {
            "poi_total": cat_total, "poi_reachable": cat_inside, "is_desert": cat_inside == 0,
        }

    # Grid for the "heatmap POI" map-mode: a literal 250m choropleth over the straight-line
    # buffer, separate from the isochrone (which stays the real walk-network reach used for
    # the coverage flag). No price attribute exists anywhere in the MAPID Data Catalogue
    # download (checked: NAMA/TIPE_1-3/TELEPON/ALAMAT/location admin/STATUS/dates only),
    # so there's no "heatmap harga" - a price heatmap would have to be invented, not derived.
    buffer_m = to_m(Point(station["lon"], station["lat"])).buffer(radius)
    cells = grid(buffer_m, CELL)
    grid_features = [
        feature(c, {"grid_id": i + 1, "poi_count": sum(1 for p in all_basic if c.contains(p))})
        for i, c in enumerate(cells)
    ]

    return {
        "isochrone": fc([feature(reach, {"minutes": round(minutes, 1)})]),
        "poi": fc(poi_features),
        "grid": fc(grid_features),
        "summary": {
            "station": station["name"],
            "basic_need_poi_total": len(all_basic),
            "basic_need_poi_reachable": sum(inside),
            "categories": category_summary,
            "isochrone_area_ha": round(reach.area / 10000, 1),
        },
    }


# --- U-UC1: site selection & market gap -------------------------------------

def _voronoi_polygons(points: list[Point], clip: Polygon):
    if len(points) < 3:
        return []
    real = np.array([[p.x, p.y] for p in points])
    # Far corner points bound every real region, so no region comes back unbounded.
    cx, cy = clip.centroid.x, clip.centroid.y
    far = 10 * max(clip.bounds[2] - clip.bounds[0], clip.bounds[3] - clip.bounds[1])
    guards = np.array([[cx - far, cy - far], [cx + far, cy - far], [cx - far, cy + far], [cx + far, cy + far]])
    vor = Voronoi(np.vstack([real, guards]))
    polys = []
    for i, region_id in enumerate(vor.point_region[: len(points)]):
        region = vor.regions[region_id]
        if not region or -1 in region:
            continue
        poly = Polygon(vor.vertices[region]).intersection(clip)
        if not poly.is_empty:
            polys.append((i, poly))
    return polys


SITE_ANCHOR_RADIUS = WALK_BUFFER * 2


async def _transit_points_near(lon: float, lat: float, radius: int) -> list[dict]:
    """KRL/MRT/LRT stations + TJ halte (GTFS) within `radius` - replaces the old MAPID
    HALTE/STASIUN download, no longer pulled (superseded by OSM + GTFS, see osm.py's
    mode_label() fix and data/README.md). KRL/MRT/LRT come from a live osm.stations() call
    first, falling back to the static station snapshot (static_transit.stations()) only if
    that live call fails - TJ always comes from the local GTFS file either way, that was
    never live."""
    origin_m = to_m(Point(lon, lat))
    try:
        rail = await osm.stations()
    except httpx.TransportError:
        rail = static_transit.stations()
        if rail is None:
            raise
    near = [
        s for s in rail
        if to_m(Point(s["lon"], s["lat"])).distance(origin_m) <= radius
    ]
    near += gtfs.nearby_stops(lon, lat, radius)
    return near


async def _site_anchors(lon: float, lat: float, radius: int = SITE_ANCHOR_RADIUS) -> list[dict]:
    """Traffic generators near the station - office workers and daily-need POIs from
    MAPID Data Catalogue only (no OSM fallback: MAPID's coverage of offices/basic-need
    categories is complete across Jabodetabek), transit riders from the static station
    snapshot + GTFS (see _transit_points_near)."""
    offices = mapid_data.offices(lon, lat, radius)
    basic_needs = mapid_data.basic_needs(lon, lat, radius)
    return (
        [{**a, "anchor_type": "kantor"} for a in offices]
        + [{**a, "anchor_type": "kebutuhan_dasar"} for a in basic_needs]
        + [{**a, "anchor_type": "transit"} for a in await _transit_points_near(lon, lat, radius)]
    )


async def site_selection(station: dict, business_type: str, subtype: str | None = None,
                          subtype2: str | None = None, radius: int = SITE_ANCHOR_RADIUS):
    """business_type: one of mapid_data.BUSINESS_TYPES (e.g. "MAKANAN DAN MINUMAN").
    subtype/subtype2: optional TIPE_2/TIPE_3 narrowing (e.g. subtype="RESTORAN",
    subtype2="RESTORAN PADANG" - see mapid_data.subtypes()/subtypes2()). Competitors are
    the same-type MAPID Data Catalogue POIs already nearby - no OSM fallback anymore
    (MAPID's coverage of business-type categories is complete across Jabodetabek), so an
    empty MAPID result means genuinely no competitors here, not a coverage gap. Not MAPID
    Missions (StrukGo/MenuGo/PropertiGo) either, that data was dropped here, coverage was
    too sparse to be usable (checked: 0-2 results in a 1km radius against real stations,
    see docs/m-uc1-gaps.md for the equivalent M-UC1 finding).

    No composite "suitability" or "market gap" score - there's no validated formula for
    weighing accessibility against competition/anchor density, so this doesn't invent
    one. Every grid cell carries independent raw counts (walk_score is the one exception
    - it's the cited Siburian et al. formula, shown standalone, not fused with anything
    here) so the map shows several honest layers instead of one made-up number.
    """
    _, residential, _, _, buffer_m, lines, pois_ok = await _context(station, radius)
    cells = grid(buffer_m, CELL)
    competitors_raw = mapid_data.by_prefix(station["lon"], station["lat"], radius, business_type, subtype, subtype2)
    comp = [to_m(Point(c["lon"], c["lat"])) for c in competitors_raw]
    anchors_raw = await _site_anchors(station["lon"], station["lat"], radius)
    anchors = {
        t: [to_m(Point(a["lon"], a["lat"])) for a in anchors_raw if a["anchor_type"] == t]
        for t in ("kantor", "kebutuhan_dasar", "transit")
    }
    parts = _walk_score_grid(
        cells, lines, intersections(lines),
        _residential_points_for(station, radius, residential, pois_ok), _commercial_points_for(station, radius),
    )
    walk_score = sum(parts[k] * w for k, w in WALK_WEIGHTS.items())

    features = [
        feature(c, {
            "grid_id": i + 1,
            "walk_score": round(float(walk_score[i]), 3),
            "competitor_count": sum(1 for p in comp if c.buffer(250).contains(p)),
            "anchor_kantor": sum(1 for a in anchors["kantor"] if c.buffer(250).contains(a)),
            "anchor_kebutuhan_dasar": sum(1 for a in anchors["kebutuhan_dasar"] if c.buffer(250).contains(a)),
            "anchor_transit": sum(1 for a in anchors["transit"] if c.buffer(250).contains(a)),
        })
        for i, c in enumerate(cells)
    ]
    catchment = [
        feature(poly, {"competitor_index": i, "name": competitors_raw[i].get("name", ""), "business_type": business_type})
        for i, poly in _voronoi_polygons(comp, buffer_m)
    ]
    anchors_fc = fc([
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [a["lon"], a["lat"]]},
         "properties": {"name": a.get("name", ""), "anchor_type": a["anchor_type"], "category": a.get("category", "")}}
        for a in anchors_raw
    ])
    competitors_fc = fc([
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [c["lon"], c["lat"]]},
         "properties": {
             "name": c.get("name", ""), "business_type": business_type,
             "subtype": c.get("tipe_2", ""), "subtype2": c.get("tipe_3", ""), "alamat": c.get("alamat", ""),
         }}
        for c in competitors_raw
    ])
    return {
        "grid": fc(features),
        "catchment": fc(catchment),
        "competitors": competitors_fc,
        "anchors": anchors_fc,
        "summary": {
            "station": station["name"],
            "business_type": business_type,
            "subtype": subtype,
            "subtype2": subtype2,
            "competitors": len(competitors_raw),
            "anchor_count": len(anchors_raw),
            "anchor_kantor": len(anchors["kantor"]),
            "anchor_kebutuhan_dasar": len(anchors["kebutuhan_dasar"]),
            "anchor_transit": len(anchors["transit"]),
            "mean_walk_score": round(float(walk_score.mean()), 3) if len(walk_score) else None,
        },
    }


# --- K-UC1: TOD readiness ----------------------------------------------------

def metadata() -> dict:
    """Where every number comes from, for the provenance panel."""
    return {
        "method": "Siburian, Sumadio & Shidiq (2020), Jurnal Geografi Lingkungan Tropik 4(1), 46-58. "
                  "8 kriteria / 18 indikator, standardisasi min-max, buffer 400 m.",
        "buffer_m": TOD_BUFFER,
        "sources": {
            "OSM": "OpenStreetMap via Overpass API, ODbL. Diambil per stasiun dan disimpan di cache lokal.",
            "MAPID": "MAPID Data Catalogue, diunduh manual sebagai GeoJSON (lihat backend/data/README.md). Update tahunan.",
            "MIXED": "Gabungan OSM (sebagian kategori) dan MAPID (sebagian kategori lain).",
            "PROXY": "Tidak ada sumber data gratis. Angka diturunkan dari kepadatan aktivitas atau tag terkait.",
            "CONSTANT": "Nilai sama untuk semua stasiun, mengikuti perlakuan di paper aslinya.",
        },
        "indicators": [
            {
                "indicator": k,
                "label": LABELS[k],
                "criterion": name,
                "criterion_label": CRITERIA_LABELS[name],
                "criterion_weight": crit["weight"],
                "indicator_weight": w,
                "effective_weight": round(crit["weight"] * w / TOTAL_WEIGHT, 4),
                "source": SOURCES[k],
            }
            for name, crit in CRITERIA.items()
            for k, w in crit["indicators"].items()
        ],
        "no_data": [
            {"indicator": k, "label": LABELS[k], "reason": reason}
            for k, reason in {
                "passengers_peak": "Data penumpang jam sibuk per stasiun tidak tersedia gratis.",
                "passengers_offpeak": "Data penumpang di luar jam sibuk per stasiun tidak tersedia gratis.",
                "safety": "Paper mengukurnya lewat survei lapangan, tidak bisa diotomatiskan.",
                "information_display": "Paper mengukurnya lewat survei lapangan, tidak bisa diotomatiskan.",
            }.items()
        ],
    }


def _land_use_diversity(residential_count: int, retail_count: int, office_count: int, green_count: int) -> float:
    """Kamruzzaman & Baker: 1 - sum of squared category shares. Shares by POI count.

    Residential/green come from OSM (live osm.residential_pois()/osm.green_pois() fetch
    first, static poi_residential_*.py/poi_green_*.py file fallback only on failure -
    see station_indicators()). Retail/office come straight from MAPID's own categories,
    already filtered by mapid_data - no OSM classifier involved, so this doesn't touch
    Overpass for what MAPID covers.
    """
    counts = [residential_count, retail_count, office_count, green_count]
    total = sum(counts)
    if not total:
        return 0.0
    return 1 - sum((c / total) ** 2 for c in counts)


def _ped_shed(graph, origin, buffer_m) -> float:
    """Zhang-style ped-shed: 400 m network service area over the straight-line buffer area."""
    if not graph.number_of_nodes():
        return 0.0
    minutes = TOD_BUFFER / network.WALK_SPEED / 60
    reachable = network.isochrone(graph, origin, minutes, "length")
    return min(reachable.area / buffer_m.area, 1.0)


async def station_indicators(station: dict):
    """The paper's 18 raw indicators for one station, before cross-station standardisation.

    Overpass queries run one at a time (not gathered) - public instances block IPs
    that fire too many concurrent requests.

    Retail/office/basic-need POIs come from MAPID Data Catalogue (see data/README.md),
    with no OSM fallback anymore - MAPID's coverage of those categories is complete
    across Jabodetabek. OSM stays the source only for what MAPID genuinely hasn't got:
    residential buildings, green space, parking (MAPID has no parking category at all),
    a handful of safety/information proxy tags, and the road network itself. Each
    OSM-sourced indicator tries live Overpass first and only falls back to its static
    cache file if that live call fails - not when the cache lacks coverage. No
    data_source="live" override here on purpose (never was, even before the toggle was
    removed elsewhere) - this scans every station of a chosen mode at once (up to `limit`,
    see main.py's tod_dashboard), still gated one station at a time by that endpoint's
    semaphore regardless of which source (live or cache) ends up serving each indicator -
    that's what actually keeps this from getting the project's IP rate-limited or
    blocklisted again (has happened before, see commit 336350c).
    """
    context = await _context(station, TOD_BUFFER)
    _, residential_list, graph, origin, buffer_m, lines, pois_ok = context
    try:
        branching = await osm.routes(station["lon"], station["lat"], TOD_BUFFER)
    except httpx.TransportError:
        branching = static_transit.routes_near(station["lon"], station["lat"], TOD_BUFFER)
        if branching is None:
            raise
    area_ha = buffer_m.area / 10000

    # Read directly from MAPID's own categories - no OSM classifier involved, so this
    # doesn't touch Overpass at all for retail/office/basic-need.
    retail_pois = mapid_data.retail(station["lon"], station["lat"], TOD_BUFFER)
    office_pois = mapid_data.offices(station["lon"], station["lat"], TOD_BUFFER)
    basic_need_pois = mapid_data.basic_needs(station["lon"], station["lat"], TOD_BUFFER)
    transit_pois = await _transit_points_near(station["lon"], station["lat"], TOD_BUFFER)

    mode_label = station.get("mode_label", "")

    # Residential count comes from the live `residential_list` fetch above (via
    # _context -> osm.residential_pois()) when it succeeded (pois_ok) - only falls back
    # to the static cache file (output/poi_residential_*.py) if that fetch failed. Falls
    # back to 0 if the static file doesn't cover this station/radius either.
    if pois_ok:
        residential = len(residential_list)
    else:
        static_residential = static_poi.residential_near(mode_label, station["lon"], station["lat"], TOD_BUFFER)
        residential = len(static_residential) if static_residential is not None else 0

    # Green: live osm.green_pois() first, static poi_green_*.py file only on failure -
    # MAPID has no POI-level green layer (see osm.green_pois()'s docstring).
    try:
        green_count = len(await osm.green_pois(station["lon"], station["lat"], TOD_BUFFER))
    except httpx.TransportError:
        static_green = static_poi.green_near(mode_label, station["lon"], station["lat"], TOD_BUFFER)
        green_count = len(static_green) if static_green is not None else 0

    # Parking, safety and information-display all come from osm.facility_pois() - MAPID
    # has no parking category, and safety/information are PROXY indicators with no
    # static-cache equivalent (only parking has one: output/poi_parking_*.py).
    try:
        facility = await osm.facility_pois(station["lon"], station["lat"], TOD_BUFFER)
        facility_ok = True
    except httpx.TransportError:
        facility = []
        facility_ok = False

    if facility_ok:
        car_parking = sum(1 for p in facility if p["amenity"] == "parking")
        motorcycle_parking = sum(1 for p in facility if p["amenity"] == "motorcycle_parking")
    else:
        static_parking = static_poi.parking_near(mode_label, station["lon"], station["lat"], TOD_BUFFER)
        if static_parking is not None:
            car_parking = sum(1 for p in static_parking if p["kind"] == "car")
            motorcycle_parking = sum(1 for p in static_parking if p["kind"] == "motorcycle")
        else:
            car_parking = motorcycle_parking = 0

    # residential_diversity's "non-residential" side used to be a raw count of every
    # non-residential element from the old combined osm.pois() query (amenity, shop,
    # office, other buildings, ...). Now that MAPID carries retail/office/basic-need
    # (and OSM still carries green), those are a strictly better proxy for the same
    # concept than OSM's own sparse amenity/shop tagging ever was - so this sums those
    # instead of re-adding a broad OSM query just to re-derive what MAPID already gives.
    non_residential = len(retail_pois) + len(office_pois) + len(basic_need_pois) + green_count
    all_day = len(basic_need_pois) + green_count

    raw = {
        # The paper's own assumption: four occupants per residential building.
        "population_density": residential * 4 / area_ha,
        "commercial_density": len(retail_pois) / area_ha,
        "land_use_diversity": _land_use_diversity(residential, len(retail_pois), len(office_pois), green_count),
        "residential_diversity": non_residential / (non_residential + residential) if residential else 0.0,
        "road_network": unary_union(lines).length / 1000,
        "intersection": len(intersections(lines)),
        "ped_shed": _ped_shed(graph, origin, buffer_m),
        "business_density": len(office_pois) / area_ha,
        # Commuters surge where offices are; all-day trips track food, shops and parks.
        "passengers_peak": len(office_pois) / area_ha,
        "passengers_offpeak": all_day / area_ha,
        "safety": sum(1 for p in facility if p["lit"] == "yes" or p["surveillance"]
                      or p["amenity"] == "police" or p["highway"] == "crossing"),
        "information_display": sum(1 for p in facility if p["departures_board"] or p["information"]),
        "train_trips": 1.0,
        "branching": branching,
        "alt_transport": len(transit_pois),
        "accessible_buildings": sum(1 for p in facility if p["building"]),
        "car_parking": car_parking,
        "motorcycle_parking": motorcycle_parking,
    }
    return {
        "station": station["name"],
        "station_id": station["id"],
        "mode_label": station["mode_label"],
        "lon": station["lon"],
        "lat": station["lat"],
        "raw": raw,
    }


def tod_index(indicators: list[dict]):
    """Standardise each indicator across stations, roll up to criteria, then to SCI."""
    scores = {k: normalize([ind["raw"][k] for ind in indicators]) for k in INDICATOR_WEIGHT}

    rows = []
    for i, ind in enumerate(indicators):
        per_indicator = {k: round(float(scores[k][i]), 3) for k in INDICATOR_WEIGHT}
        criteria = {
            name: round(sum(per_indicator[k] * w for k, w in crit["indicators"].items()), 3)
            for name, crit in CRITERIA.items()
        }
        sci = sum(criteria[name] * crit["weight"] for name, crit in CRITERIA.items()) / TOTAL_WEIGHT
        rows.append({**ind, "sci": round(sci, 3), "criteria": criteria, "indicators": per_indicator})

    rows.sort(key=lambda r: r["sci"], reverse=True)
    breaks = _breaks([r["sci"] for r in rows])
    for rank, row in enumerate(rows, 1):
        row["rank"] = rank
        row["classification"] = _classify(row["sci"], breaks)
        row["typology"], row["typology_reason"] = _typology(row)
        row["priorities"] = priorities(row)
        row.update(impact_benefit(row))
    return quadrant(rows)


def _breaks(sorted_desc: list[float]) -> tuple[float, float]:
    """Two cut points splitting the stations into three equal-sized classes."""
    if not sorted_desc:
        return 0.0, 0.0
    values = sorted(sorted_desc)
    return values[len(values) // 3], values[2 * len(values) // 3]


def _classify(sci: float, breaks: tuple[float, float]) -> str:
    low, high = breaks
    if sci >= high:
        return "tinggi"
    if sci >= low:
        return "sedang"
    return "rendah"


def _typology(row: dict) -> tuple[str, str]:
    """Which kind of development the existing character of the area actually supports."""
    c = row["criteria"]
    if row["sci"] < 0.3 or c["walk_access"] < 0.25:
        return "pembenahan dasar", (
            f"SCI {row['sci']} dan akses jalan kaki {c['walk_access']} masih rendah, "
            "sehingga infrastruktur dasar perlu dibenahi sebelum pengembangan lain."
        )
    if c["economy"] >= 0.6 and c["density"] >= 0.5:
        return "mixed-use", (
            f"Ekonomi {c['economy']} dan kepadatan {c['density']} sama-sama kuat, "
            "kawasan sanggup menampung fungsi campuran."
        )
    if c["economy"] >= 0.5:
        return "retail cepat", (
            f"Ekonomi {c['economy']} kuat tetapi kepadatan {c['density']} belum tinggi, "
            "retail cepat paling cocok menyerap arus penumpang."
        )
    return "housing-support", (
        f"Ekonomi {c['economy']} masih rendah dengan kepadatan {c['density']}, "
        "kawasan lebih tepat diarahkan ke hunian dan layanan pendukungnya."
    )


def priorities(row: dict) -> list[dict]:
    """Indicators ranked by how much SCI each one could still add if brought to 1.0."""
    out = [
        {
            "indicator": k,
            "label": LABELS[k],
            "criterion": INDICATOR_CRITERION[k],
            "score": row["indicators"][k],
            "source": SOURCES[k],
            "potential_gain": round(w * (1 - row["indicators"][k]) / TOTAL_WEIGHT, 4),
        }
        for k, w in INDICATOR_WEIGHT.items()
    ]
    out.sort(key=lambda p: p["potential_gain"], reverse=True)
    return out


def impact_benefit(row: dict) -> dict:
    """Impact = how far from ideal. Benefit = how much usable foundation already exists.

    Placeholder definition, kept trivial on purpose so it is easy to replace once the
    real impact/benefit formula is agreed.
    """
    c = row["criteria"]
    impact = round(1 - row["sci"], 3)
    benefit = round((c["walk_access"] + c["accessibility"] + c["station_facility"]) / 3, 3)
    return {"impact": impact, "benefit": benefit}


def quadrant(rows: list[dict]) -> list[dict]:
    """Label each station against the median impact and median benefit."""
    if not rows:
        return rows
    mid_impact = float(np.median([r["impact"] for r in rows]))
    mid_benefit = float(np.median([r["benefit"] for r in rows]))
    for r in rows:
        high_impact = r["impact"] >= mid_impact
        high_benefit = r["benefit"] >= mid_benefit
        r["quadrant"] = (
            "quick win" if high_impact and high_benefit
            else "dampak tinggi, effort besar" if high_impact
            else "sudah baik, rawat saja" if high_benefit
            else "prioritas rendah"
        )
    return rows


def what_if(rows: list[dict], station_id: str, overrides: dict[str, float]) -> dict:
    """Projected SCI and rank if the named indicators were lifted to the given scores."""
    row = next(r for r in rows if r["station_id"] == station_id)
    projected = {**row["indicators"], **overrides}
    criteria = {
        name: sum(projected[k] * w for k, w in crit["indicators"].items())
        for name, crit in CRITERIA.items()
    }
    sci_after = sum(criteria[n] * c["weight"] for n, c in CRITERIA.items()) / TOTAL_WEIGHT
    others = [r["sci"] for r in rows if r["station_id"] != station_id]
    return {
        "station": row["station"],
        "sci_before": row["sci"],
        "sci_after": round(sci_after, 3),
        "delta": round(sci_after - row["sci"], 3),
        "rank_before": row["rank"],
        "rank_after": sum(1 for s in others if s > sci_after) + 1,
        "criteria_after": {k: round(v, 3) for k, v in criteria.items()},
    }


# --- K-UC2: climate & environmental resilience -------------------------------

BANJIR_BLOCK_KELAS = {"Tinggi", "Cukup Tinggi"}


HAZARD_SAMPLE_SIZE = 120  # meters, center-to-vertex - coarser than AQ_HEX_SIZE on purpose,
# each cell is a live InaRISK HTTP call (~4-5s), so this trades resolution for speed.


async def resilience(station: dict):
    """No composite "vulnerability" score - the old version blended a green-cover heat
    proxy with a waterway-distance flood proxy into one number (0.5/0.5), which was two
    stand-ins invented for this project multiplied together. Replaced with real published
    hazard data per corridor. Plus MAPID's UHI/rainfall/ecology-index layers for the
    buffer (already downloaded for M-UC1's Kenyamanan tab, shown as-is here too - see
    mapid_environment.py, no live equivalent exists for those). Every layer stands alone;
    nothing is fused.

    Banjir per corridor is tried first from MAPID's downloaded flood-risk zoning
    (mapid_environment.flood_class_at - exact point-in-polygon, no live call, no auth,
    never down; 5-level Kelas Sangat Rendah..Tinggi, MAPID's own scheme). If MAPID's
    zoning has literally no polygon covering any corridor in this station's buffer (no
    coverage for this area at all, not just "risk unclassified for some roads"), this
    automatically falls back to BNPB InaRISK (gis.bnpb.go.id, see inarisk.py) for BOTH
    banjir and longsor instead - real government hazard rasters, but a live external
    server this project doesn't control, ~4-5s per "identify" call. Sampled on a coarse
    hex grid (HAZARD_SAMPLE_SIZE) rather than once per corridor - a 500m buffer can have
    500+ road segments, querying every one individually took over 10 minutes end to end;
    each corridor just takes its nearest sample's value instead. 3-level class (rendah/
    sedang/tinggi), BNPB's own scheme - not the same scale as MAPID's 5-level Kelas, don't
    compare the two schemes' numbers directly. No landslide (longsor) layer at all when
    MAPID coverage is used - MAPID doesn't publish that; only InaRISK's automatic fallback
    ever populates it. No user-facing choice either way.
    """
    roads, _pois, graph, origin, buffer_m, lines, _pois_ok = await _context(station, WALK_BUFFER)

    def _banjir_kelas(point_m):
        lon, lat = to_deg(point_m).coords[0]
        return mapid_environment.flood_class_at(lon, lat)

    static_corridors = [
        {
            "poly": line.buffer(CORRIDOR_BUFFER), "index": i, "highway": road["highway"],
            "banjir_kelas": _banjir_kelas(line.centroid),
        }
        for i, (road, line) in enumerate(zip(roads, lines))
    ]
    static_coverage = any(c["banjir_kelas"] for c in static_corridors)

    if not static_coverage:
        sample_cells = hex_grid(buffer_m, HAZARD_SAMPLE_SIZE)
        sem = asyncio.Semaphore(8)
        errors = 0

        async def _sample_hazard(cell):
            nonlocal errors
            pt = to_deg(cell.centroid)
            try:
                async with sem:
                    return await inarisk.hazard(pt.x, pt.y)
            except inarisk.InaRiskUnavailable:
                errors += 1
                return {"banjir": None, "longsor": None}

        sample_hazards = await asyncio.gather(*(_sample_hazard(c) for c in sample_cells))
        # If every sample failed, BNPB's server itself is down/unreachable right now -
        # every corridor coming back with no data means "unknown", not "no hazard here".
        inarisk_unavailable = bool(sample_cells) and errors == len(sample_cells)
        sample_tree = STRtree([c.centroid for c in sample_cells]) if sample_cells else None

        def _hazard_near(point_m):
            if sample_tree is None:
                return {"banjir": None, "longsor": None}
            return sample_hazards[sample_tree.nearest(point_m)]

        corridors = [
            {
                "poly": line.buffer(CORRIDOR_BUFFER), "index": i, "highway": road["highway"],
                **_hazard_near(line.centroid),
            }
            for i, (road, line) in enumerate(zip(roads, lines))
        ]
        risky_polys = [
            c["poly"] for c in corridors
            if (c["banjir"] and c["banjir"]["class"] == "tinggi") or (c["longsor"] and c["longsor"]["class"] == "tinggi")
        ]
        features = [
            feature(c["poly"], {
                "corridor_id": c["index"], "highway": c["highway"],
                "banjir_class": c["banjir"]["class"] if c["banjir"] else None,
                "banjir_value": c["banjir"]["value"] if c["banjir"] else None,
                "longsor_class": c["longsor"]["class"] if c["longsor"] else None,
                "longsor_value": c["longsor"]["value"] if c["longsor"] else None,
            })
            for c in corridors
        ]
        hazard_summary = {
            "use_inarisk": True,
            "inarisk_unavailable": inarisk_unavailable,
            "banjir_known": sum(1 for c in corridors if c["banjir"]),
            "banjir_tinggi": sum(1 for c in corridors if c["banjir"] and c["banjir"]["class"] == "tinggi"),
            "longsor_known": sum(1 for c in corridors if c["longsor"]),
            "longsor_tinggi": sum(1 for c in corridors if c["longsor"] and c["longsor"]["class"] == "tinggi"),
        }
    else:
        corridors = static_corridors
        # Hard avoidance, not a blended score - same pattern as M-UC1's wheelchair=no
        # routing: a corridor MAPID classifies "Tinggi"/"Cukup Tinggi" banjir gets routing
        # steered around it.
        risky_polys = [c["poly"] for c in corridors if c["banjir_kelas"] in BANJIR_BLOCK_KELAS]
        features = [
            feature(c["poly"], {
                "corridor_id": c["index"], "highway": c["highway"], "banjir_kelas": c["banjir_kelas"],
            })
            for c in corridors
        ]
        hazard_summary = {
            "use_inarisk": False,
            "inarisk_unavailable": False,
            "banjir_known": sum(1 for c in corridors if c["banjir_kelas"]),
            "banjir_tinggi": sum(1 for c in corridors if c["banjir_kelas"] in BANJIR_BLOCK_KELAS),
            "longsor_known": 0,
            "longsor_tinggi": 0,
        }

    risky = unary_union(risky_polys) if risky_polys else None
    for u, v, data in graph.edges(data=True):
        mid = Point((u[0] + v[0]) / 2, (u[1] + v[1]) / 2)
        blocked = risky is not None and not risky.is_empty and risky.contains(mid)
        data["safe"] = data["length"] * (network.HAZARD_BLOCK_FACTOR if blocked else 1.0)

    buffer_wgs84 = to_deg(buffer_m)
    uhi = mapid_environment.uhi(buffer_wgs84)
    ecology_index = mapid_environment.ecology_index(buffer_wgs84)
    rainfall = mapid_environment.rainfall(buffer_wgs84)
    # Same MAPID flood data as the static-coverage corridors' banjir_kelas above, here as
    # the raw zone polygons (broader area context, like uhi/ecology_index/rainfall) rather
    # than clipped to road corridors - shown regardless of which banjir source the
    # corridors ended up using, for comparison against it.
    flood_risk_mapid = mapid_environment.flood_risk(buffer_wgs84)

    return {
        "corridors": fc(features),
        "uhi": uhi,
        "ecology_index": ecology_index,
        "rainfall": rainfall,
        "flood_risk_mapid": flood_risk_mapid,
        "summary": {
            "station": station["name"],
            "corridors": len(corridors),
            **hazard_summary,
        },
        "graph": graph,
        "origin": origin,
    }


def detour(graph, origin, dest_lon: float, dest_lat: float):
    dest = to_m(Point(dest_lon, dest_lat))
    safe_line, safe_stats = network.route(graph, origin, dest, "safe")
    direct_line, direct_stats = network.route(graph, origin, dest, "length")
    return fc([
        feature(direct_line, {"kind": "shortest", **direct_stats}),
        feature(safe_line, {"kind": "detour", **safe_stats}),
    ])
