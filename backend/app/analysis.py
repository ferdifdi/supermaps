"""Spatial analysis for the five SuperMaps use cases.

Weights follow the proposal (Siburian et al., 2020).
Proxies used where a free national dataset is not available are marked PROXY.
"""

import numpy as np
from scipy.spatial import Voronoi
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

from . import mapid_data, network, osm
from .geo import fc, feature, grid, intersections, normalize, to_deg, to_m

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
    "alt_transport": "MAPID",  # HALTE + STASIUN
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


async def _context(station: dict, radius: int):
    """Road graph, POIs and the station buffer, all in metric CRS.

    Sequential, not gathered - public Overpass instances block IPs that fire too
    many concurrent requests (this project has been blocklisted before).
    """
    roads = await osm.roads(station["lon"], station["lat"], radius)
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
    # No Overpass call here at all: the grid only needs the buffer geometry (no roads
    # needed), and basic-need POIs now come entirely from MAPID.
    buffer_m = to_m(Point(station["lon"], station["lat"])).buffer(WALK_BUFFER)
    cells = grid(buffer_m, CELL)
    # MAPID's food/health categories are far better mapped in Indonesia than OSM's.
    raw_pois = mapid_data.basic_needs(station["lon"], station["lat"], WALK_BUFFER)
    basic = [to_m(Point(p["lon"], p["lat"])) for p in raw_pois]
    features, deserts = [], 0
    for c in cells:
        # 500m walkshed from the cell's centroid, not literal containment - the
        # indicator means "can someone here walk to a basic need", not "is there
        # one in this exact 250m box". Cells overlap their neighbours' catchments
        # on purpose.
        reach = c.centroid.buffer(WALK_BUFFER)
        count = sum(1 for p in basic if reach.contains(p))
        desert = count == 0
        deserts += desert
        features.append(feature(c, {"basic_need_count": count, "is_desert": desert}))
    return {
        "grid": fc(features),
        "poi": fc([feature(p, {"name": r["name"]}) for p, r in zip(basic, raw_pois)]),
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
    branching = await osm.routes(station["lon"], station["lat"], TOD_BUFFER)
    _, pois, graph, origin, buffer_m, lines = context
    area_ha = buffer_m.area / 10000

    # MAPID replaces OSM for categories it covers (see data/README.md); OSM stays the
    # only source for what MAPID hasn't got (residential, green, parking, road network).
    # Read directly from MAPID's own categories - no OSM classifier involved, so this
    # doesn't touch Overpass at all for retail/office/basic-need/transit.
    retail_pois = mapid_data.retail(station["lon"], station["lat"], TOD_BUFFER)
    office_pois = mapid_data.offices(station["lon"], station["lat"], TOD_BUFFER)
    basic_need_pois = mapid_data.basic_needs(station["lon"], station["lat"], TOD_BUFFER)
    transit_pois = mapid_data.transit_stops(station["lon"], station["lat"], TOD_BUFFER)

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
