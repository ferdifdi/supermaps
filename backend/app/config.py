import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

MAPID_BASEMAP_KEY = os.environ["MAPID_BASEMAP_KEY"]
MAPID_DATA_KEY = os.environ["MAPID_DATA_KEY"]
MAPID_CATALOGUE_KEY = os.environ["MAPID_CATALOGUE_KEY"]
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
OPENAQ_API_KEY = os.getenv("OPENAQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "http://localhost:8000")

MAPID_BASEMAP_URL = "https://v2.basemap.mapid.io"
MAPID_SERVER_URL = "https://server.mapid.io"
# Public Overpass instances (wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances)
# - tried in order, first one that responds wins (see osm.py's overpass()). More mirrors
# = fewer "all mirrors unreachable/rate-limited" failures when one or two happen to be
# down/rate-limiting at the same time (which does happen - the original 3-mirror list
# went 0-for-many during a bulk TJ run).
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

CACHE_DIR = BASE_DIR / "cache"
CACHE_DIR.mkdir(exist_ok=True)

# Jabodetabek bounding box (west, south, east, north)
JABODETABEK_BBOX = (106.35, -6.60, 107.15, -5.95)


def catalogue_layers():
    """MAPID Data Catalogue layers, imported to a project and exposed via OPEN API URL.

    Premium Data is sliced per kabupaten/kota, so one dataset name maps to several
    URLs (one per slice), joined with "|". They get merged into one FeatureCollection.
    """
    raw = os.getenv("MAPID_LAYER_URLS", "").strip()
    if not raw:
        return {}
    layers = {}
    for pair in raw.split(","):
        name, urls = pair.split("=", 1)
        layers[name] = urls.split("|")
    return layers
