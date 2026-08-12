"""Pedestrian network: graph build, isochrone, routing with comfort impedance."""

import networkx as nx
from shapely.geometry import LineString, Point
from shapely.ops import unary_union

from .geo import to_m

# Comfort penalty per road class: lower is more pleasant to walk.
CLASS_PENALTY = {
    "footway": 1.0, "pedestrian": 1.0, "path": 1.1, "steps": 1.6, "living_street": 1.1,
    "residential": 1.2, "service": 1.3, "unclassified": 1.4, "tertiary": 1.6,
    "secondary": 1.9, "primary": 2.2,
}
WALK_SPEED = 1.3  # m/s


def build(roads: list[dict]) -> nx.Graph:
    """roads: [{"coords": [[lon,lat],...], "highway": str}]"""
    g = nx.Graph()
    for road in roads:
        pts = [to_m(Point(lon, lat)) for lon, lat in road["coords"]]
        penalty = CLASS_PENALTY.get(road["highway"], 1.5)
        for a, b in zip(pts, pts[1:]):
            na, nb = (round(a.x), round(a.y)), (round(b.x), round(b.y))
            length = a.distance(b)
            if length == 0:
                continue
            g.add_edge(na, nb, length=length, comfort=length * penalty, penalty=penalty)
    return g


def nearest_node(g: nx.Graph, point_m: Point):
    return min(g.nodes, key=lambda n: (n[0] - point_m.x) ** 2 + (n[1] - point_m.y) ** 2)


def isochrone(g: nx.Graph, origin_m: Point, minutes: float, weight: str = "comfort"):
    """Metric polygon reachable within `minutes` of walking."""
    max_cost = minutes * 60 * WALK_SPEED
    reached = nx.single_source_dijkstra_path_length(g, nearest_node(g, origin_m), cutoff=max_cost, weight=weight)
    if not reached:
        return origin_m.buffer(50)
    return unary_union([Point(n).buffer(60) for n in reached])


def route(g: nx.Graph, a_m: Point, b_m: Point, weight: str = "comfort"):
    """Metric LineString of the path from a to b."""
    path = nx.shortest_path(g, nearest_node(g, a_m), nearest_node(g, b_m), weight=weight)
    line = LineString(path)
    length = sum(g[u][v]["length"] for u, v in zip(path, path[1:]))
    penalty = sum(g[u][v]["comfort"] for u, v in zip(path, path[1:])) / length
    return line, {"length_m": round(length), "minutes": round(length / WALK_SPEED / 60, 1),
                  "comfort_penalty": round(penalty, 2)}
