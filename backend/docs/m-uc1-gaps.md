# M-UC1: Navigasi Transit Nyaman - gap closure notes

Referenced from `network.py` and `osm.py` docstrings. Covers gap #5 (redundancy) and
gap #6 (final output schema) from the M-UC1 gap-closure request. Gap #2 (Survival
Sehari-hari) was dropped - it duplicates M-UC2. Gap #3 (disability data) became gap #4
below (route + info layer), not a separate output.

## Gap #5: walk_score vs. routing impedance - no double counting

Two independent scoring systems exist in this use case, on purpose kept apart:

| | `walk_score` (grid) | routing impedance (`comfort`/`accessible` weight) |
|---|---|---|
| Unit of analysis | 250m grid cell | road segment (edge) |
| Formula | Siburian et al. (2020): `0.40*road_network + 0.30*ped_shed + 0.20*intersection + 0.10*residential_mix` | `class_penalty * sidewalk_factor * lit_factor * surface_factor * shade_factor * aqi_factor`, `* wheelchair_factor` for `accessible` |
| Purpose | Area-level walkability rating - "is this neighborhood walkable" | Route choice - "which path from A to B is most pleasant/accessible" |
| Inputs | road density, ped-shed ratio, intersection count, residential/commercial mix | sidewalk tag, lit tag, surface tag, tree shade, PM2.5, wheelchair tag |

Neither formula reads the other's inputs. `walk_score`'s 4 components are exactly the
paper's - nothing from the OSM tag work (sidewalk/lit/surface/wheelchair/shade/AQI) was
added to it, because that would silently change a cited, validated formula. Routing
impedance never touches population/POI/intersection data - it only reasons about the
physical segment being walked. A station can have a high walk_score (dense, walkable
area) and still have some low-comfort segments (e.g. no sidewalk on one block), and the
map shows both simultaneously without either number contaminating the other.

## Gap #6: final output schema

`GET /api/analysis/walk-access?station_id=...&minutes=10` returns:

```
{
  "grid": FeatureCollection<Polygon>        # 250m cells, one per Siburian walk_score
    properties: walk_score, road_network, ped_shed, intersection, residential_mix

  "isochrone": FeatureCollection<Polygon>   # 3 features, one per routing weight
    properties: kind ("fastest" | "most_comfortable" | "accessible"), minutes

  "transfer_points": FeatureCollection<Point>   # gap #1
    properties: name, mode ("TJ" | "KRL" | "LRT" | "Bus"), distance_m,
                headway_min_peak (minutes, TJ only, else null), wheelchair, is_proxy

  "summary": {
    station, mean_walk_score, cells,
    isochrone_area_ha, accessible_area_ha,
    sidewalk_ratio, wheelchair_tagged_ratio, wheelchair_no_ratio,   # gap #4
    transfer_points_real, transfer_points_proxy,                    # gap #1
    air_quality: null | { pm25, category, comfort_factor, station, station_lon, station_lat }
  }
}
```

`GET /api/analysis/route?station_id=...&lon=...&lat=...&preference=comfort|fast|accessible`:

```
{
  "route": FeatureCollection<LineString>   # 1 feature
    properties: preference, length_m, minutes, comfort_penalty
  "summary": { length_m, minutes, comfort_penalty }
}
```

### Data phase per field

- **Phase 1 (OSM, live)**: grid, isochrone, route, sidewalk/wheelchair ratios, transfer
  proxy points (KRL/MRT/LRT/Bus, `is_proxy: true`).
- **Real, not OSM**: TJ transfer points (`is_proxy: false`, TransJakarta GTFS
  `frequencies.txt`), air quality (OpenAQ, requires `OPENAQ_API_KEY` - null without one).
- **Phase 2 (MAPID, not wired)**: none of M-UC1's fields depend on MAPID; the Fase 2
  wishlist (LST, RSEI, UHI, nighttime light, curah hujan, emisi udara, risiko
  banjir/longsor/tsunami) belongs to K-UC2 (`resilience()`), which currently proxies
  heat with OSM green-cover and flood with OSM waterway distance - see the `PROXY:`
  comment in `analysis.py`'s `resilience()`.

### Assumptions

- KRL, MRT Jakarta, LRT Jabodebek, and Jaklingko have no public GTFS feed (checked
  before building `gtfs.py`) - only TransJakarta does, so only TJ gets real headway.
  Everything else is a walking-distance proxy from OSM `railway`/`public_transport`/
  `highway=bus_stop` tags, always flagged `is_proxy: true`.
- Air quality is one value per station (nearest OpenAQ station within 25km), applied as
  a uniform multiplier across the whole walk graph - Jabodetabek's station density
  doesn't support a per-segment reading.
- Disability service providers (list & contact) mentioned in the original brief were not
  turned into a layer - no such directory exists as open data; wheelchair accessibility
  is instead surfaced structurally (accessible route weight + sidewalk/wheelchair ratios
  + per-point wheelchair tag on transfer_points), which is what OSM can actually verify.
