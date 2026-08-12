"""Spatial analysis for the five SuperMaps use cases.

Weights follow the proposal (Siburian et al., 2020).
Proxies used where a free national dataset is not available are marked PROXY.
"""

import asyncio

import numpy as np
from scipy.spatial import Voronoi
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

from . import network, osm
from .geo import fc, feature, grid, intersections, normalize, to_deg, to_m

WALK_BUFFER = 500
TOD_BUFFER = 400
CORRIDOR_BUFFER = 40
CELL = 250

WALK_WEIGHTS = {"road_network": 0.40, "ped_shed": 0.30, "intersection": 0.20, "residential_mix": 0.10}
TOD_WEIGHTS = {
    "density": 0.15, "land_use_diversity": 0.03, "walk_access": 0.06, "economy": 0.22,
    "station_capacity": 0.19, "station_facility": 0.11, "accessibility": 0.15, "parking": 0.08,
}


async def _context(station: dict, radius: int):
    """Road graph, POIs and the station buffer, all in metric CRS."""
    roads, pois = await asyncio.gather(
        osm.roads(station["lon"], station["lat"], radius),
        osm.pois(station["lon"], station["lat"], radius),
    )
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

async def walk_access(station: dict, minutes: float = 10.0):
    roads, pois, graph, origin, buffer_m, lines = await _context(station, WALK_BUFFER)
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
    iso_comfort = network.isochrone(graph, origin, minutes, "comfort")
    iso_fast = network.isochrone(graph, origin, minutes, "length")
    return {
        "grid": fc(features),
        "isochrone": fc([
            feature(iso_fast, {"kind": "fastest", "minutes": minutes}),
            feature(iso_comfort, {"kind": "most_comfortable", "minutes": minutes}),
        ]),
        "summary": {
            "station": station["name"],
            "mean_walk_score": round(float(score.mean()), 3),
            "cells": len(cells),
            "isochrone_area_ha": round(iso_comfort.area / 10000, 1),
        },
    }


async def comfortable_route(station: dict, dest_lon: float, dest_lat: float, preference: str = "comfort"):
    roads, _, graph, origin, _, _ = await _context(station, WALK_BUFFER * 3)
    dest = to_m(Point(dest_lon, dest_lat))
    weight = "comfort" if preference == "comfort" else "length"
    line, stats = network.route(graph, origin, dest, weight)
    return {"route": fc([feature(line, {"preference": preference, **stats})]), "summary": stats}


# --- M-UC2: food & amenity equity -------------------------------------------

async def amenity_equity(station: dict):
    _, pois, _, _, buffer_m, _ = await _context(station, WALK_BUFFER)
    cells = grid(buffer_m, CELL)
    basic = _poi_points(pois, osm.is_basic_need)
    features, deserts = [], 0
    for c in cells:
        reach = c.centroid.buffer(WALK_BUFFER)
        count = sum(1 for p in basic if reach.contains(p))
        desert = count == 0
        deserts += desert
        features.append(feature(c, {"basic_need_count": count, "is_desert": desert}))
    return {
        "grid": fc(features),
        "poi": fc([feature(p, {}) for p in basic]),
        "summary": {
            "station": station["name"],
            "basic_need_poi": len(basic),
            "cells": len(cells),
            "desert_cells": deserts,
            "desert_ratio": round(deserts / len(cells), 3) if cells else 0,
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


async def site_selection(station: dict, category: str, competitors: list[dict], demand_points: list[dict]):
    """competitors/demand_points: [{"lon":..,"lat":..}] from MAPID missions/activities."""
    _, pois, _, _, buffer_m, lines = await _context(station, WALK_BUFFER * 2)
    cells = grid(buffer_m, CELL)
    comp = [to_m(Point(c["lon"], c["lat"])) for c in competitors]
    demand = [to_m(Point(d["lon"], d["lat"])) for d in demand_points]
    parts = _walk_score_grid(
        cells, lines, intersections(lines),
        _poi_points(pois, osm.is_residential), _poi_points(pois, osm.is_commercial),
    )
    access = sum(parts[k] * w for k, w in WALK_WEIGHTS.items())

    demand_count = [sum(1 for d in demand if c.buffer(250).contains(d)) for c in cells]
    comp_count = [sum(1 for p in comp if c.buffer(250).contains(p)) for c in cells]
    demand_n = normalize(demand_count)
    gap = demand_n - normalize(comp_count)
    suitability = 0.5 * access + 0.5 * demand_n

    features = [
        feature(c, {
            "suitability": round(float(suitability[i]), 3),
            "accessibility": round(float(access[i]), 3),
            "demand": round(float(demand_n[i]), 3),
            "market_gap": round(float(gap[i]), 3),
            "competitors": comp_count[i],
        })
        for i, c in enumerate(cells)
    ]
    catchment = [
        feature(poly, {"competitor_index": i, "name": competitors[i].get("name", ""), "category": category})
        for i, poly in _voronoi_polygons(comp, buffer_m)
    ]
    best = max(features, key=lambda f: f["properties"]["suitability"]) if features else None
    return {
        "grid": fc(features),
        "catchment": fc(catchment),
        "competitors": fc([feature(p, {"category": category}) for p in comp]),
        "summary": {
            "station": station["name"],
            "category": category,
            "competitors": len(comp),
            "demand_points": len(demand),
            "best_cell_suitability": best["properties"]["suitability"] if best else None,
        },
    }


# --- K-UC1: TOD readiness ----------------------------------------------------

async def station_indicators(station: dict, ridership: float | None = None):
    _, pois, _, _, buffer_m, lines = await _context(station, TOD_BUFFER)
    area_ha = buffer_m.area / 10000
    res = _poi_points(pois, osm.is_residential)
    com = _poi_points(pois, osm.is_commercial)
    parking = [p for p in pois if p["amenity"] == "parking"]
    facility = sum(1 for p in pois if p["amenity"] in ("shelter", "bench", "toilets", "police", "drinking_water"))
    nodes = intersections(lines)
    road_length = unary_union(lines).length

    total = len(res) + len(com)
    return {
        "station": station["name"],
        "station_id": station["id"],
        "lon": station["lon"],
        "lat": station["lat"],
        "raw": {
            # PROXY: building counts stand in for population/commercial density (no free per-grid census).
            "density": total / area_ha,
            "land_use_diversity": (len(com) / total) if total else 0.0,
            "walk_access": road_length / area_ha / 100 + len(nodes) / area_ha,
            "economy": len(com) / area_ha,
            "station_capacity": ridership or 0.0,
            "station_facility": facility,
            "accessibility": sum(1 for p in pois if p["amenity"] in ("bus_station", "taxi", "bicycle_parking")),
            "parking": len(parking),
        },
    }


def tod_index(indicators: list[dict]):
    """Min-max standardise every indicator across stations, then weighted sum."""
    keys = list(TOD_WEIGHTS)
    matrix = {k: normalize([ind["raw"][k] for ind in indicators]) for k in keys}
    weights = TOD_WEIGHTS.copy()
    if all(ind["raw"]["station_capacity"] == 0 for ind in indicators):
        weights.pop("station_capacity")  # no ridership supplied: renormalise over the rest
    total_w = sum(weights.values())

    rows = []
    for i, ind in enumerate(indicators):
        parts = {k: float(matrix[k][i]) for k in weights}
        sci = sum(parts[k] * w for k, w in weights.items()) / total_w
        rows.append({**ind, "sci": round(sci, 3), "components": {k: round(v, 3) for k, v in parts.items()}})

    rows.sort(key=lambda r: r["sci"], reverse=True)
    for rank, row in enumerate(rows, 1):
        row["rank"] = rank
        row["typology"] = _typology(row)
    return rows


def _typology(row: dict) -> str:
    c, sci = row["components"], row["sci"]
    if sci < 0.3 or c["walk_access"] < 0.25:
        return "perbaikan dasar"
    if c["economy"] >= 0.6 and c["density"] >= 0.5:
        return "mixed-use"
    if c["economy"] >= 0.5:
        return "retail cepat"
    return "housing-support"


# --- K-UC2: climate & environmental resilience -------------------------------

async def resilience(station: dict):
    roads, pois, graph, origin, buffer_m, lines = await _context(station, WALK_BUFFER)
    green = _poi_points(pois, osm.is_green)
    water = [to_m(Point(p["lon"], p["lat"])) for p in pois if p["waterway"]]

    corridors = []
    for i, line in enumerate(lines):
        poly = line.buffer(CORRIDOR_BUFFER)
        # PROXY: green cover stands in for Landsat LST, waterway proximity for InaRISK flood risk.
        heat = 1.0 - min(sum(1 for g in green if poly.contains(g)) / 3.0, 1.0)
        flood = 1.0 - min(min((w.distance(line) for w in water), default=500) / 500.0, 1.0)
        corridors.append({"poly": poly, "heat": heat, "flood": flood, "index": i,
                          "highway": roads[i]["highway"]})

    for c in corridors:
        c["vulnerability"] = round(0.5 * c["heat"] + 0.5 * c["flood"], 3)
    corridors.sort(key=lambda c: c["vulnerability"], reverse=True)

    features = [
        feature(c["poly"], {
            "corridor_id": c["index"], "highway": c["highway"],
            "heat_proxy": round(c["heat"], 3), "flood_proxy": round(c["flood"], 3),
            "vulnerability": c["vulnerability"], "rank": rank,
        })
        for rank, c in enumerate(corridors, 1)
    ]

    # Detour: route to the far edge of the buffer avoiding the worst corridors.
    risky = unary_union([c["poly"] for c in corridors if c["vulnerability"] > 0.6])
    for u, v, data in graph.edges(data=True):
        mid = Point((u[0] + v[0]) / 2, (u[1] + v[1]) / 2)
        data["safe"] = data["length"] * (3.0 if not risky.is_empty and risky.contains(mid) else 1.0)

    return {
        "corridors": fc(features),
        "summary": {
            "station": station["name"],
            "corridors": len(corridors),
            "mean_vulnerability": round(float(np.mean([c["vulnerability"] for c in corridors])), 3) if corridors else 0,
            "worst": [
                {"corridor_id": c["index"], "highway": c["highway"], "vulnerability": c["vulnerability"]}
                for c in corridors[:5]
            ],
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
