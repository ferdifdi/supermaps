"""Spatial analysis for the five SuperMaps use cases.

Weights follow the proposal (Siburian et al., 2020).
Proxies used where a free national dataset is not available are marked PROXY.
"""

import numpy as np
from scipy.spatial import Voronoi
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

from . import airquality, gtfs, mapid_data, mapid_environment, network, osm, static_transit
from .geo import fc, feature, grid, hex_grid, intersections, normalize, to_deg, to_m

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
    "residential_diversity": "OSM", "road_network": "OSM", "intersection": "OSM",
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
    """Precomputed static network first (output/isochrone_*.py, no Overpass call at all)
    - falls back to a live osm.roads() fetch when the station's mode has no static file
    yet or radius exceeds what was precomputed for that mode (see
    static_transit.MODE_RADIUS_M - 800m for MRT/KRL/LRT, 400m for TJ)."""
    roads = static_transit.roads_near(station.get("mode_label", ""), station["lon"], station["lat"], radius)
    if roads is not None:
        return roads
    return await osm.roads(station["lon"], station["lat"], radius)


async def _context(station: dict, radius: int):
    """Road graph, POIs and the station buffer, all in metric CRS.

    Sequential, not gathered - public Overpass instances block IPs that fire too
    many concurrent requests (this project has been blocklisted before).
    """
    roads = await _roads_for(station, radius)
    pois = await osm.pois(station["lon"], station["lat"], radius)
    graph = network.build(roads)
    origin = to_m(Point(station["lon"], station["lat"]))
    buffer_m = origin.buffer(radius)
    lines = [LineString([to_m(Point(x, y)) for x, y in r["coords"]]) for r in roads]
    return roads, pois, graph, origin, buffer_m, lines


def _poi_points(pois: list[dict], predicate) -> list[Point]:
    return [to_m(Point(p["lon"], p["lat"])) for p in pois if predicate(p)]


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
    """Like _context, but also fetches trees and air quality for the "Kenyamanan" tab's
    raw display layers (canopy, air_quality_grid) - those aren't routing inputs (see
    network.py), just shown as-is, so this is the one place both get pulled."""
    roads, pois, graph, origin, buffer_m, lines = await _context(station, radius)
    raw_trees = await osm.trees(station["lon"], station["lat"], radius)
    aq = await airquality.nearby_pm25(station["lon"], station["lat"])
    graph = network.build(roads)
    return roads, pois, graph, origin, buffer_m, lines, aq, raw_trees


def _accessibility_summary(roads: list[dict]) -> dict:
    """Share of road length with a usable sidewalk / explicit wheelchair access - the
    info layer for gap #4, independent of any single route."""
    total = sidewalk = wheelchair_ok = wheelchair_no = 0.0
    for r in roads:
        pts = [to_m(Point(lon, lat)) for lon, lat in r["coords"]]
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


def _transfer_points(station: dict, pois: list[dict], radius: int) -> dict:
    """Transfer-efficiency layer (gap #1). TransJakarta stops get a real average headway
    from GTFS frequencies.txt (is_proxy=False). KRL/MRT/LRT/other-bus points only have OSM
    tags, no schedule data exists for them, so they carry walking distance only and
    is_proxy=True - the frontend must show that distinction, not present them as equal.
    """
    origin_m = to_m(Point(station["lon"], station["lat"]))
    real = gtfs.nearby_stops(station["lon"], station["lat"], radius)
    points = [{
        "name": s["name"], "lon": s["lon"], "lat": s["lat"], "mode": "TJ",
        "distance_m": s["distance_m"], "headway_min_peak": s["headway_min_peak"],
        "wheelchair": s["wheelchair"] or None, "is_proxy": False,
    } for s in real]
    seen = {(round(s["lon"], 5), round(s["lat"], 5)) for s in real}

    for p in pois:
        if not (p["railway"] or p["public_transport"] or p["highway"] == "bus_stop"):
            continue
        key = (round(p["lon"], 5), round(p["lat"], 5))
        if key in seen or not p["name"]:
            continue
        seen.add(key)
        mode = "KRL" if p["railway"] in ("station", "halt") else \
            "LRT" if p["railway"] == "tram_stop" else "Bus"
        dist = to_m(Point(p["lon"], p["lat"])).distance(origin_m)
        if dist > radius:
            continue
        points.append({
            "name": p["name"], "lon": p["lon"], "lat": p["lat"], "mode": mode,
            "distance_m": round(dist), "headway_min_peak": None,
            "wheelchair": p["wheelchair"] or None, "is_proxy": True,
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
    than the fetched network would just clip silently at the fetch edge."""
    roads, pois, graph, origin, buffer_m, lines, aq, raw_trees = await _walk_graph(station, radius_m)
    minutes = radius_m / network.WALK_SPEED / 60
    cells = grid(buffer_m, CELL)
    parts = _walk_score_grid(
        cells, lines, intersections(lines),
        _poi_points(pois, osm.is_residential), _poi_points(pois, osm.is_commercial),
    )
    score = sum(parts[k] * w for k, w in WALK_WEIGHTS.items())

    features = [
        feature(c, {
            "walk_score": round(float(score[i]), 3),
            **{k: round(float(parts[k][i]), 3) for k in WALK_WEIGHTS},
        })
        for i, c in enumerate(cells)
    ]
    iso_fast = network.isochrone(graph, origin, minutes, "length")
    iso_accessible = network.isochrone(graph, origin, minutes, "accessible")
    transfer = _transfer_points(station, pois, radius_m)
    aq_stations = await airquality.nearby_stations(station["lon"], station["lat"])
    air_quality_grid = _air_quality_grid(buffer_m, aq_stations)

    # "Kenyamanan" tab (comfort context): raw environmental layers only, no composite
    # score - user explicitly rejected building a comfort index on top of these.
    canopy = fc([
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [t["lon"], t["lat"]]}, "properties": {}}
        for t in raw_trees
    ])
    green = [p for p in pois if osm.is_green(p)]
    ecology_poi = fc([
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]},
         "properties": {"leisure": p["leisure"], "landuse": p["landuse"], "name": p["name"]}}
        for p in green
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
    uhi = mapid_environment.uhi(buffer_deg)
    ecology_index = mapid_environment.ecology_index(buffer_deg)
    rainfall = mapid_environment.rainfall(buffer_deg)

    return {
        "grid": fc(features),
        "isochrone": fc([
            feature(iso_fast, {"kind": "fastest", "minutes": minutes, "radius_m": radius_m}),
            feature(iso_accessible, {"kind": "accessible", "minutes": minutes, "radius_m": radius_m}),
        ]),
        "transfer_points": transfer,
        "air_quality_grid": air_quality_grid,
        "air_quality_stations": aq_stations,
        "canopy": canopy,
        "ecology_poi": ecology_poi,
        "accessibility_roads": accessibility_roads,
        "uhi": uhi,
        "ecology_index": ecology_index,
        "rainfall": rainfall,
        "summary": {
            "transfer_points_real": sum(1 for t in transfer["features"] if not t["properties"]["is_proxy"]),
            "transfer_points_proxy": sum(1 for t in transfer["features"] if t["properties"]["is_proxy"]),
            "air_quality": aq,
            "station": station["name"],
            "mean_walk_score": round(float(score.mean()), 3),
            "walk_score_components": {k: round(float(parts[k].mean()), 3) for k in WALK_WEIGHTS},
            "cells": len(cells),
            "isochrone_area_ha": round(iso_fast.area / 10000, 1),
            "accessible_area_ha": round(iso_accessible.area / 10000, 1),
            "tree_count": len(raw_trees),
            "green_space_count": len(green),
            **_accessibility_summary(roads),
        },
    }


async def comfortable_route(station: dict, dest_lon: float, dest_lat: float, preference: str = "fast"):
    roads, _, graph, origin, _, _, _, _ = await _walk_graph(station, WALK_BUFFER * 3)
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
    """
    roads = await _roads_for(station, radius)
    graph = network.build(roads)
    origin = to_m(Point(station["lon"], station["lat"]))
    minutes = radius / network.WALK_SPEED / 60
    reach = network.isochrone(graph, origin, minutes, "length")

    # MAPID's food/health categories are far better mapped in Indonesia than OSM's, so
    # basic-need POIs come entirely from MAPID - the only Overpass call above is for roads.
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
        feature(c, {"poi_count": sum(1 for p in all_basic if c.contains(p))})
        for c in cells
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
    """KRL/MRT/LRT stations (OSM) + TJ halte (GTFS) within `radius` - replaces the old
    MAPID HALTE/STASIUN download, no longer pulled (superseded by live OSM + GTFS, see
    osm.py's mode_label() fix and data/README.md)."""
    origin_m = to_m(Point(lon, lat))
    near = [
        s for s in await osm.stations()
        if to_m(Point(s["lon"], s["lat"])).distance(origin_m) <= radius
    ]
    near += gtfs.nearby_stops(lon, lat, radius)
    return near


async def _site_anchors(lon: float, lat: float) -> list[dict]:
    """Traffic generators near the station - office workers (MAPID), daily-need POIs
    (MAPID), transit riders (OSM + GTFS)."""
    return (
        [{**a, "anchor_type": "kantor"} for a in mapid_data.offices(lon, lat, SITE_ANCHOR_RADIUS)]
        + [{**a, "anchor_type": "kebutuhan_dasar"} for a in mapid_data.basic_needs(lon, lat, SITE_ANCHOR_RADIUS)]
        + [{**a, "anchor_type": "transit"} for a in await _transit_points_near(lon, lat, SITE_ANCHOR_RADIUS)]
    )


async def site_selection(station: dict, business_type: str, subtype: str | None = None, radius: int = SITE_ANCHOR_RADIUS):
    """business_type: one of mapid_data.BUSINESS_TYPES (e.g. "MAKANAN DAN MINUMAN").
    subtype: optional, one of mapid_data.subtypes(business_type) (e.g. "RESTORAN") to
    narrow further. Competitors are the same-type MAPID Data Catalogue POIs already
    nearby, not MAPID Missions (StrukGo/MenuGo/PropertiGo) - that data was dropped here,
    coverage was too sparse to be usable (checked: 0-2 results in a 1km radius against
    real stations, see docs/m-uc1-gaps.md for the equivalent M-UC1 finding).

    No composite "suitability" or "market gap" score - there's no validated formula for
    weighing accessibility against competition/anchor density, so this doesn't invent
    one. Every grid cell carries independent raw counts (walk_score is the one exception
    - it's the cited Siburian et al. formula, shown standalone, not fused with anything
    here) so the map shows several honest layers instead of one made-up number.
    """
    _, pois, _, _, buffer_m, lines = await _context(station, radius)
    cells = grid(buffer_m, CELL)
    competitors_raw = mapid_data.by_prefix(station["lon"], station["lat"], radius, business_type, subtype)
    comp = [to_m(Point(c["lon"], c["lat"])) for c in competitors_raw]
    anchors_raw = await _site_anchors(station["lon"], station["lat"])
    anchors = {
        t: [to_m(Point(a["lon"], a["lat"])) for a in anchors_raw if a["anchor_type"] == t]
        for t in ("kantor", "kebutuhan_dasar", "transit")
    }
    parts = _walk_score_grid(
        cells, lines, intersections(lines),
        _poi_points(pois, osm.is_residential), _poi_points(pois, osm.is_commercial),
    )
    walk_score = sum(parts[k] * w for k, w in WALK_WEIGHTS.items())

    features = [
        feature(c, {
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
             "subtype": c.get("tipe_2", ""), "alamat": c.get("alamat", ""),
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


def _land_use_diversity(osm_pois: list[dict], retail_pois: list[dict], office_pois: list[dict]) -> float:
    """Kamruzzaman & Baker: 1 - sum of squared category shares. Shares by POI count.

    Residential/green come from OSM (MAPID doesn't map those yet). Retail/office come
    straight from MAPID's own categories, already filtered by mapid_data - no OSM
    classifier involved, so this doesn't touch Overpass for what MAPID covers.
    """
    counts = [
        sum(1 for p in osm_pois if osm.is_residential(p)),
        len(retail_pois),
        len(office_pois),
        sum(1 for p in osm_pois if osm.is_green(p)),
    ]
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
    """
    context = await _context(station, TOD_BUFFER)
    branching = static_transit.routes_near(station["lon"], station["lat"], TOD_BUFFER)
    if branching is None:  # no static route file for any mode yet - fall back live
        branching = await osm.routes(station["lon"], station["lat"], TOD_BUFFER)
    _, pois, graph, origin, buffer_m, lines = context
    area_ha = buffer_m.area / 10000

    # MAPID replaces OSM for categories it covers (see data/README.md); OSM stays the
    # only source for what MAPID hasn't got (residential, green, parking, road network).
    # Read directly from MAPID's own categories - no OSM classifier involved, so this
    # doesn't touch Overpass at all for retail/office/basic-need.
    retail_pois = mapid_data.retail(station["lon"], station["lat"], TOD_BUFFER)
    office_pois = mapid_data.offices(station["lon"], station["lat"], TOD_BUFFER)
    basic_need_pois = mapid_data.basic_needs(station["lon"], station["lat"], TOD_BUFFER)
    transit_pois = await _transit_points_near(station["lon"], station["lat"], TOD_BUFFER)

    residential = sum(1 for p in pois if osm.is_residential(p))
    non_residential = sum(1 for p in pois if not osm.is_residential(p))
    all_day = len(basic_need_pois) + sum(1 for p in pois if osm.is_green(p))

    raw = {
        # The paper's own assumption: four occupants per residential building.
        "population_density": residential * 4 / area_ha,
        "commercial_density": len(retail_pois) / area_ha,
        "land_use_diversity": _land_use_diversity(pois, retail_pois, office_pois),
        "residential_diversity": non_residential / (non_residential + residential) if residential else 0.0,
        "road_network": unary_union(lines).length / 1000,
        "intersection": len(intersections(lines)),
        "ped_shed": _ped_shed(graph, origin, buffer_m),
        "business_density": len(office_pois) / area_ha,
        # Commuters surge where offices are; all-day trips track food, shops and parks.
        "passengers_peak": len(office_pois) / area_ha,
        "passengers_offpeak": all_day / area_ha,
        "safety": sum(1 for p in pois if p["lit"] == "yes" or p["surveillance"]
                      or p["amenity"] == "police" or p["highway"] == "crossing"),
        "information_display": sum(1 for p in pois if p["departures_board"] or p["information"]),
        "train_trips": 1.0,
        "branching": branching,
        "alt_transport": len(transit_pois),
        "accessible_buildings": sum(1 for p in pois if p["building"]),
        "car_parking": sum(1 for p in pois if p["amenity"] == "parking"),
        "motorcycle_parking": sum(1 for p in pois if p["amenity"] == "motorcycle_parking"),
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


async def resilience(station: dict):
    """No composite "vulnerability" score - the old version blended a green-cover heat
    proxy with a waterway-distance flood proxy into one number (0.5/0.5), which was two
    stand-ins invented for this project multiplied together. Replaced with real published
    hazard data per corridor: MAPID's static flood-risk zoning for banjir (see
    mapid_environment.flood_class_at - exact point-in-polygon, no live call, no auth,
    never down). Plus MAPID's UHI/rainfall/ecology-index layers for the buffer (already
    downloaded for M-UC1's Kenyamanan tab, shown as-is here too - see
    mapid_environment.py). Every layer stands alone; nothing is fused.

    Landslide (longsor) was dropped entirely - BNPB InaRISK covered it live, but that's
    a slow (~4-5s/call) external government server this project doesn't control, and
    landslide risk in Jabodetabek is concentrated in a small hilly slice of Kabupaten
    Bogor, not something this project's use cases need citywide. Only banjir remains.
    """
    roads, _pois, graph, origin, buffer_m, lines = await _context(station, WALK_BUFFER)

    def _banjir_kelas(point_m):
        lon, lat = to_deg(point_m).coords[0]
        return mapid_environment.flood_class_at(lon, lat)

    corridors = [
        {
            "poly": line.buffer(CORRIDOR_BUFFER), "index": i, "highway": road["highway"],
            "banjir_kelas": _banjir_kelas(line.centroid),
        }
        for i, (road, line) in enumerate(zip(roads, lines))
    ]

    # Hard avoidance, not a blended score - same pattern as M-UC1's wheelchair=no routing:
    # a corridor MAPID classifies "Tinggi"/"Cukup Tinggi" banjir gets routing steered
    # around it.
    risky_polys = [c["poly"] for c in corridors if c["banjir_kelas"] in BANJIR_BLOCK_KELAS]
    risky = unary_union(risky_polys) if risky_polys else None
    for u, v, data in graph.edges(data=True):
        mid = Point((u[0] + v[0]) / 2, (u[1] + v[1]) / 2)
        blocked = risky is not None and not risky.is_empty and risky.contains(mid)
        data["safe"] = data["length"] * (network.HAZARD_BLOCK_FACTOR if blocked else 1.0)

    features = [
        feature(c["poly"], {
            "corridor_id": c["index"], "highway": c["highway"], "banjir_kelas": c["banjir_kelas"],
        })
        for c in corridors
    ]

    buffer_wgs84 = to_deg(buffer_m)
    uhi = mapid_environment.uhi(buffer_wgs84)
    ecology_index = mapid_environment.ecology_index(buffer_wgs84)
    rainfall = mapid_environment.rainfall(buffer_wgs84)
    # Same MAPID flood data as corridors' banjir_kelas above, here as the raw zone
    # polygons (broader area context, like uhi/ecology_index/rainfall) rather than
    # clipped to road corridors.
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
            "banjir_known": sum(1 for c in corridors if c["banjir_kelas"]),
            "banjir_tinggi": sum(1 for c in corridors if c["banjir_kelas"] in BANJIR_BLOCK_KELAS),
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
