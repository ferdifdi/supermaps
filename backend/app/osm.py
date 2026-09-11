"""OpenStreetMap data via Overpass. Responses are cached on disk."""

import asyncio
import hashlib
import json

import httpx
from shapely.geometry import Point

from .config import CACHE_DIR, JABODETABEK_BBOX, OVERPASS_URLS
from .geo import to_m

# OSM tags KRL/MRT/LRT/Transjakarta stations actually carry in Jabodetabek.
MODE_LABELS = {"subway": "MRT", "light_rail": "LRT", "station": "KRL", "halt": "KRL"}

# Checked against live Overpass data: operator/network tags are inconsistent (missing,
# or the legal company name instead of the brand - e.g. "PT Transportasi Jakarta" has no
# "transjakarta" substring), so multiple known phrasings are matched per mode instead of
# one guess each. Order matters - more specific phrases first within a mode's tuple isn't
# needed since these don't overlap across modes.
OPERATOR_HINTS = [
    (("transjakarta", "transportasi jakarta", "tije"), "TJ"),
    (("mrt jakarta", "ratangga", " mrt", "mrt "), "MRT"),
    (("lrt jabodebek", " lrt", "lrt "), "LRT"),
    (("kai commuter", "commuter", "kereta commuter", "krl"), "KRL"),
]


def mode_label(tags: dict) -> str:
    """KRL / MRT / LRT / TJ from the raw OSM tagging.

    Priority: an explicit station=* subtag (most specific, contributor's direct intent)
    beats operator/network text-matching, which beats the bare railway=* fallback - the
    old version checked operator first and fell through to railway=*/"bus" as a single
    combined guess, which silently mislabeled stations whenever operator was missing or
    phrased differently than expected (the exact bug reports: LRT/MRT shown as KRL, or
    a bus stop not recognized as TJ).
    """
    station_tag = tags.get("station")
    if station_tag in MODE_LABELS:
        return MODE_LABELS[station_tag]

    # A network value listing several comma-separated places is a shuttle describing its
    # destinations (e.g. "Citraland Grogol, Blok M, ..., Stasiun KRL Cikarang"), not this
    # stop's own operator identity - keyword-matching it produces false positives (a
    # private housing shuttle terminal got labeled KRL because "krl" appeared mid-sentence
    # naming an unrelated destination it drives to).
    network = tags.get("network", "")
    if network.count(",") >= 2:
        network = ""
    haystack = f"{tags.get('operator', '')} {network}".lower()
    for keywords, label in OPERATOR_HINTS:
        if any(k in haystack for k in keywords):
            return label

    if tags.get("public_transport") == "station" and tags.get("bus") == "yes":
        return "TJ"

    railway = tags.get("railway")
    if railway in MODE_LABELS:
        return MODE_LABELS[railway]

    return "KRL"


async def _try_mirror(client: httpx.AsyncClient, url: str, query: str) -> dict | None:
    """One mirror attempt - None on any failure (unreachable, timeout, error status,
    truncated body), never raises, so the caller can just race/skip past it."""
    try:
        r = await client.post(url, data={"data": query})
    except httpx.TransportError:  # host unreachable or timed out
        return None
    if r.status_code >= 400:  # rate limit / load shedding / bad gateway / any server error
        return None
    try:
        return r.json()
    except json.JSONDecodeError:  # empty/truncated body
        return None


async def overpass(query: str) -> dict:
    key = hashlib.sha1(query.encode()).hexdigest()
    path = CACHE_DIR / f"osm_{key}.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    # Race every mirror concurrently instead of trying them one at a time - whichever
    # responds first (and actually succeeds) wins, the rest get cancelled. A query used
    # to pay each failing/slow mirror's full timeout in sequence before reaching a good
    # one; this way a single healthy-and-fast mirror answers immediately regardless of
    # its position in OVERPASS_URLS. The per-station semaphore elsewhere (K-UC1's
    # dashboard scan) still caps how many *stations* are in flight at once, so this only
    # ever fans out to N mirrors for the one query currently being resolved, not N times
    # however many stations are queued.
    timeout = httpx.Timeout(connect=5, read=12, write=5, pool=5)
    async with httpx.AsyncClient(timeout=timeout, headers={"User-Agent": "SuperMaps/1.0"}) as client:
        tasks = {asyncio.create_task(_try_mirror(client, url, query)): url for url in OVERPASS_URLS}
        data = None
        try:
            while tasks:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for t in done:
                    del tasks[t]
                    result = t.result()
                    if result is not None:
                        data = result
                if data is not None:
                    break
        finally:
            for t in tasks:
                t.cancel()
        if data is None:
            raise httpx.ConnectError("all Overpass mirrors unreachable, rate-limited, or returned empty responses")
    path.write_text(json.dumps(data), encoding="utf-8")
    return data


def _bbox(area_bbox=None) -> str:
    w, s, e, n = area_bbox or JABODETABEK_BBOX
    return f"{s},{w},{n},{e}"


def _dedupe_stations(stations: list[dict], radius_m: float = 120) -> list[dict]:
    """Collapse duplicate OSM nodes for the same physical station (a common mapping
    error: railway=station and a separate railway=halt added for the same platform, or
    two contributors both added it) - same normalized name AND same mode_label AND
    within radius_m. Deliberately does NOT merge across different mode_labels: a real
    interchange (e.g. KRL + LRT nodes both named "Dukuh Atas") is two genuine services
    at one place, not a duplicate, and collapsing them would lose that information.
    """
    kept: list[dict] = []
    kept_points: list[Point] = []
    for s in stations:
        key = s["name"].strip().lower()
        pt = to_m(Point(s["lon"], s["lat"]))
        if any(
            k["name"].strip().lower() == key and k["mode_label"] == s["mode_label"] and pt.distance(kp) <= radius_m
            for k, kp in zip(kept, kept_points)
        ):
            continue
        kept.append(s)
        kept_points.append(pt)
    return kept


FREIGHT_KEYWORDS = ("angkutan barang", "terminal barang", "cargo", "freight")

# railway=station also matches other rail systems that aren't KRL/MRT/LRT/TJ - the
# Jakarta-Bandung high-speed rail (Whoosh/KCIC) shares a station name with a real LRT
# stop (Halim), and falls through mode_label()'s railway=station fallback straight to
# "KRL" since neither its operator nor network match any of the 4 target modes.
EXCLUDED_OPERATORS = ("kcic", "whoosh")


async def stations() -> list[dict]:
    """Rail stations (KRL/MRT/LRT) and major bus stations in Jabodetabek."""
    q = f"""
    [out:json][timeout:10];
    (
      node["railway"="station"]({_bbox()});
      node["railway"="halt"]({_bbox()});
      node["public_transport"="station"]["bus"="yes"]({_bbox()});
    );
    out center;
    """
    data = await overpass(q)
    out = []
    for el in data["elements"]:
        tags = el.get("tags", {})
        name = tags.get("name")
        if not name:
            continue
        # railway=station also covers freight-only yards (e.g. Jakarta Gudang, tagged
        # "Terminal Angkutan Barang" in its own note) - no passenger service, so they
        # don't belong in a walk-to-catch-a-train station list.
        note = tags.get("note", "").lower()
        if any(k in note for k in FREIGHT_KEYWORDS):
            continue
        identity = f"{tags.get('operator', '')} {tags.get('network', '')}".lower()
        if any(k in identity for k in EXCLUDED_OPERATORS):
            continue
        out.append({
            "id": str(el["id"]),
            "name": name,
            "mode": tags.get("station") or tags.get("railway") or "bus",
            "mode_label": mode_label(tags),
            "operator": tags.get("operator", ""),
            "lon": el["lon"],
            "lat": el["lat"],
        })
    out = _dedupe_stations(out)
    out.sort(key=lambda s: s["name"])
    return out


async def roads(lon: float, lat: float, radius: int) -> list[dict]:
    """Walkable road centerlines around a point, with the tags routing comfort/accessible
    impedance is built from (see network.py): sidewalk presence, lighting, surface,
    wheelchair access. None of these feed walk_score (Siburian et al. formula, kept to its
    original 4 components) - they only ever affect route choice, not the area-level score."""
    q = f"""
    [out:json][timeout:10];
    way["highway"]["highway"!~"motorway|motorway_link|trunk|trunk_link"](around:{radius},{lat},{lon});
    out geom;
    """
    data = await overpass(q)
    return [
        {
            "coords": [[p["lon"], p["lat"]] for p in el["geometry"]],
            "highway": el["tags"]["highway"],
            "sidewalk": el["tags"].get("sidewalk", ""),
            "lit": el["tags"].get("lit", ""),
            "surface": el["tags"].get("surface", ""),
            "wheelchair": el["tags"].get("wheelchair", ""),
        }
        for el in data["elements"] if el.get("geometry")
    ]


async def trees(lon: float, lat: float, radius: int) -> list[dict]:
    """Individual street trees - a per-segment shade proxy, distinct from the park/garden
    POIs already in pois(). Phase 1 (OSM tags) only; street-level imagery (Mapillary/Street
    View) extraction is not wired in - no image pipeline exists in this project."""
    q = f"""
    [out:json][timeout:10];
    node["natural"="tree"](around:{radius},{lat},{lon});
    out;
    """
    data = await overpass(q)
    return [{"lon": el["lon"], "lat": el["lat"]} for el in data["elements"]]


async def residential_pois(lon: float, lat: float, radius: int) -> list[dict]:
    """Residential buildings only - feeds walk_score's residential_mix (M-UC1/U-UC1) and
    K-UC1's population_density/land_use_diversity. This used to be one filter inside a
    much bigger combined query that also pulled amenity/shop/office/other-building tags
    for a commercial-classification fallback - that fallback is gone now (MAPID Data
    Catalogue's PERDAGANGAN DAN RETAIL/KANTOR/basic-need categories fully cover what it
    was standing in for across Jabodetabek - the OSM-tag classifier that did this,
    osm_poi.py, was deleted outright), so this only ever
    asks Overpass for the one tag MAPID has no equivalent of: residential buildings.
    Measured live against Manggarai (a dense interchange, 800m radius): the old combined
    query took 32s: this one is a small fraction of that, see the timing note in the
    project history."""
    q = f"""
    [out:json][timeout:10];
    nwr["building"~"residential|apartments|house"](around:{radius},{lat},{lon});
    out center;
    """
    data = await overpass(q)
    out = []
    for el in data["elements"]:
        tags = el.get("tags", {})
        center = el.get("center") or el
        if "lon" not in center:
            continue
        out.append({
            "lon": center["lon"],
            "lat": center["lat"],
            "building": tags.get("building", ""),
            "name": tags.get("name", ""),
        })
    return out


async def green_pois(lon: float, lat: float, radius: int) -> list[dict]:
    """Parks/gardens/grass/forest/recreation ground - MAPID has no POI-level green-space
    layer (mapid_environment.py's ecology_index/rainfall/uhi are numeric index polygons,
    not point locations), so this stays a live OSM query, same tags the old combined
    pois() used for its green classification."""
    q = f"""
    [out:json][timeout:10];
    (
      nwr["leisure"~"park|garden"](around:{radius},{lat},{lon});
      nwr["landuse"~"grass|forest|recreation_ground"](around:{radius},{lat},{lon});
    );
    out center;
    """
    data = await overpass(q)
    out = []
    for el in data["elements"]:
        tags = el.get("tags", {})
        center = el.get("center") or el
        if "lon" not in center:
            continue
        out.append({
            "lon": center["lon"],
            "lat": center["lat"],
            "leisure": tags.get("leisure", ""),
            "landuse": tags.get("landuse", ""),
            "name": tags.get("name", ""),
        })
    return out


async def facility_pois(lon: float, lat: float, radius: int) -> list[dict]:
    """K-UC1 station-facility tags with no MAPID equivalent: parking (MAPID's Data
    Catalogue has no parking category at all), safety/information proxies, generic
    building presence (accessible_buildings), and pedestrian infrastructure nodes.

    `amenity` here is deliberately restricted to parking/motorcycle_parking/police -
    NOT the full amenity tag - the old combined pois() query's broad `nwr["amenity"]`
    sweep existed to feed a commercial-classification fallback that's gone now (MAPID
    covers those categories completely), so re-adding the full amenity tag would just
    resurrect the same slow, now-pointless query. Parking specifically has no MAPID
    stand-in and must keep coming from here.
    """
    q = f"""
    [out:json][timeout:10];
    (
      nwr["amenity"~"parking|motorcycle_parking|police"](around:{radius},{lat},{lon});
      nwr["building"](around:{radius},{lat},{lon});
      node["highway"="crossing"](around:{radius},{lat},{lon});
      node["highway"="bus_stop"](around:{radius},{lat},{lon});
      node["public_transport"="platform"](around:{radius},{lat},{lon});
      node["railway"~"station|halt|tram_stop"](around:{radius},{lat},{lon});
    );
    out center;
    """
    data = await overpass(q)
    out = []
    for el in data["elements"]:
        tags = el.get("tags", {})
        center = el.get("center") or el
        if "lon" not in center:
            continue
        out.append({
            "lon": center["lon"],
            "lat": center["lat"],
            "amenity": tags.get("amenity", ""),
            "building": tags.get("building", ""),
            "highway": tags.get("highway", ""),
            "railway": tags.get("railway", ""),
            "public_transport": tags.get("public_transport", ""),
            "lit": tags.get("lit", ""),
            "surveillance": tags.get("surveillance", ""),
            "departures_board": tags.get("departures_board", ""),
            "information": tags.get("information", ""),
            "name": tags.get("name", ""),
        })
    return out


async def routes(lon: float, lat: float, radius: int) -> int:
    """How many public-transport route relations pass within `radius` of a point."""
    q = f"""
    [out:json][timeout:10];
    relation["type"="route"]["route"~"train|subway|light_rail|tram|bus"](around:{radius},{lat},{lon});
    out ids;
    """
    data = await overpass(q)
    return len(data["elements"])


def is_residential(poi: dict) -> bool:
    return poi["building"] in ("residential", "apartments", "house")


def is_green(poi: dict) -> bool:
    return bool(poi["leisure"] or poi["landuse"])
