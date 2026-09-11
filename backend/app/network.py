"""Pedestrian network: graph build, isochrone, routing.

Two edge weights only: "length" (pure distance) and "accessible" (length, with segments
tagged wheelchair=no penalized so routing avoids them). No synthetic "comfort" score -
there is no validated formula for weighting sidewalk/lighting/surface/shade/air-quality
tags into a single walkability number, so this project doesn't invent one. Those signals
are shown as-is in M-UC1's "Kenyamanan" tab (raw layers, no composite index) instead -
see analysis.py.
"""

import networkx as nx
from shapely.geometry import LineString, Point
from shapely.ops import unary_union

from .geo import to_m_points

# wheelchair=no is a hard, OSM-authored fact about the segment - not an invented weight -
# so it's read directly and used to steer routing away from it. Missing/yes/limited all
# route at normal cost; there's no reliable way to rank those against each other from a
# single tag, so this doesn't try to.
WHEELCHAIR_BLOCK_FACTOR = 1000.0

# Same hard-avoidance pattern for K-UC2: MAPID's own flood-risk Kelas classification
# (not a score this project derived) marks a corridor, resilience() sets edge["safe"] to
# this multiple of length on it. See analysis.py resilience().
HAZARD_BLOCK_FACTOR = 1000.0

WALK_SPEED = 1.3  # m/s


def build(roads: list[dict]) -> nx.Graph:
    """roads: [{"coords", "highway", "wheelchair", ...}].

    Produces two edge weights: "length" (pure distance) and "accessible" (length, times
    WHEELCHAIR_BLOCK_FACTOR wherever wheelchair=no).
    """
    g = nx.Graph()
    # One vectorized reprojection for every coordinate across all roads, instead of
    # to_m(Point(...)) per point (each call pays its own pyproj+shapely.ops.transform
    # wrapper overhead - profiled at ~1-1.5s of walk_access's warm-cache runtime for a
    # station with ~780 roads, same root cause as mapid_data.py's earlier fix).
    lons, lats, bounds = [], [], [0]
    for road in roads:
        for lon, lat in road["coords"]:
            lons.append(lon)
            lats.append(lat)
        bounds.append(len(lons))
    all_pts = to_m_points(lons, lats) if lons else []

    for i, road in enumerate(roads):
        pts = all_pts[bounds[i]:bounds[i + 1]]
        blocked = road.get("wheelchair") == "no"
        for a, b in zip(pts, pts[1:]):
            na, nb = (round(a.x), round(a.y)), (round(b.x), round(b.y))
            length = a.distance(b)
            if length == 0:
                continue
            g.add_edge(
                na, nb, length=length,
                accessible=length * (WHEELCHAIR_BLOCK_FACTOR if blocked else 1.0),
            )
    return g


def nearest_node(g: nx.Graph, point_m: Point):
    return min(g.nodes, key=lambda n: (n[0] - point_m.x) ** 2 + (n[1] - point_m.y) ** 2)


def isochrone(g: nx.Graph, origin_m: Point, minutes: float, weight: str = "length"):
    """Metric polygon reachable within `minutes` of walking."""
    max_cost = minutes * 60 * WALK_SPEED
    reached = nx.single_source_dijkstra_path_length(g, nearest_node(g, origin_m), cutoff=max_cost, weight=weight)
    if not reached:
        return origin_m.buffer(50)
    return unary_union([Point(n).buffer(60) for n in reached])


def route(g: nx.Graph, a_m: Point, b_m: Point, weight: str = "length"):
    """Metric LineString of the path from a to b."""
    path = nx.shortest_path(g, nearest_node(g, a_m), nearest_node(g, b_m), weight=weight)
    line = LineString(path)
    length = sum(g[u][v]["length"] for u, v in zip(path, path[1:]))
    # Segments the route still had to cross despite being blocked on `weight` - only
    # happens if no unblocked path exists at all, since blocked edges cost far more.
    # Generic over whichever weight was actually routed on (accessible, safe, ...).
    blocked_segments = (
        sum(1 for u, v in zip(path, path[1:]) if g[u][v][weight] > g[u][v]["length"])
        if weight != "length" else 0
    )
    return line, {"length_m": round(length), "minutes": round(length / WALK_SPEED / 60, 1),
                  "blocked_segments_crossed": blocked_segments}
