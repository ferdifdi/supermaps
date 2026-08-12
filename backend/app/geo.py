"""Geometry helpers. Metric work is done in UTM 48S (EPSG:32748), output is WGS84."""

import numpy as np
from pyproj import Transformer
from shapely.geometry import Point, box, mapping, shape
from shapely.ops import transform, unary_union
from shapely.strtree import STRtree

_to_m = Transformer.from_crs("EPSG:4326", "EPSG:32748", always_xy=True).transform
_to_deg = Transformer.from_crs("EPSG:32748", "EPSG:4326", always_xy=True).transform


def to_m(geom):
    return transform(_to_m, geom)


def to_deg(geom):
    return transform(_to_deg, geom)


def buffer_deg(lon: float, lat: float, meters: float):
    """Circular buffer of `meters` around a lon/lat, returned in WGS84."""
    return to_deg(to_m(Point(lon, lat)).buffer(meters))


def grid(poly_m, cell: float = 250.0):
    """Square grid cells (in metric CRS) covering a metric polygon."""
    minx, miny, maxx, maxy = poly_m.bounds
    cells = []
    for x in np.arange(minx, maxx, cell):
        for y in np.arange(miny, maxy, cell):
            c = box(x, y, x + cell, y + cell)
            if c.intersects(poly_m):
                cells.append(c)
    return cells


def normalize(values):
    """Min-max to 0..1. Flat input -> zeros."""
    a = np.asarray(values, dtype=float)
    lo, hi = a.min(), a.max()
    if hi - lo < 1e-9:
        return np.zeros_like(a)
    return (a - lo) / (hi - lo)


def feature(geom_m, props: dict) -> dict:
    return {"type": "Feature", "geometry": mapping(to_deg(geom_m)), "properties": props}


def fc(features: list[dict]) -> dict:
    return {"type": "FeatureCollection", "features": features}


def points_m(coords) -> list:
    """[[lon, lat], ...] -> metric Points."""
    return [to_m(Point(lon, lat)) for lon, lat in coords]


def intersections(lines_m) -> list:
    """Approximate street intersections: crossings of road lines, found via spatial index."""
    merged = unary_union(lines_m)
    if merged.is_empty:
        return []
    geoms = list(merged.geoms) if merged.geom_type == "MultiLineString" else [merged]
    tree = STRtree(geoms)
    nodes = {}
    for i, a in enumerate(geoms):
        for j in tree.query(a):
            if j <= i:
                continue
            b = geoms[j]
            if not a.intersects(b):
                continue
            inter = a.intersection(b)
            for p in getattr(inter, "geoms", [inter]):
                if p.geom_type == "Point":
                    nodes[(round(p.x), round(p.y))] = p
    return list(nodes.values())


def geojson_to_m(geojson: dict) -> list:
    return [to_m(shape(f["geometry"])) for f in geojson["features"]]
