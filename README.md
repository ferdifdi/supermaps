# SuperMaps

WebGIS implementation of the proposal *SuperMaps: Spatial Decision Support System untuk Kawasan Transportasi Massal Jabodetabek* (MAPID WebGIS Competition 2026).

- Backend: FastAPI + Shapely/NetworkX/SciPy
- Frontend: React + MapLibre GL, MAPID basemap
- Data: MAPID (basemap, Missions, Activities, Data Catalogue) + OpenStreetMap

## Use cases

| ID    | Persona      | Output                                                                     |
| ----- | ------------ | -------------------------------------------------------------------------- |
| M-UC1 | Masyarakat   | Skor akses jalan kaki per grid 250 m, isochrone tercepat vs ternyaman      |
| M-UC2 | Masyarakat   | Kepadatan POI kebutuhan dasar per grid, flag food/amenity desert           |
| U-UC1 | Pelaku usaha | Voronoi catchment kompetitor (Mapid Missions), skor kelayakan + market gap |
| K-UC1 | Kebijakan    | Station Composite Index, ranking stasiun, tipologi pengembangan            |
| K-UC2 | Kebijakan    | Kerentanan koridor (panas + banjir), peringkat koridor, detour             |

## Setup

Backend:

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate.bat
# Windows
pip install -r requirements.txt
copy .env.example .env                                # isi MAPID_API_KEY dan GROQ_API_KEY
uvicorn app.main:app --reload
```

Frontend:

```bash
cd frontend
npm install
copy .env.example .env
npm run dev
```

Open http://localhost:5173.

## API keys

Three MAPID keys, one per concern (`MAPID_BASEMAP_KEY`, `MAPID_DATA_KEY`, `MAPID_CATALOGUE_KEY`):

- `MAPID_BASEMAP_KEY` — `v2.basemap.mapid.io/styles/*/style.json?key=`
- `MAPID_DATA_KEY` — Missions + Activities `x-api-key` header
- `MAPID_CATALOGUE_KEY` — `x-api-key` header on each catalogue layer's OPEN API URL

Requires an active GEO MAPID license. Full contract: [docs/mapid-api.md](docs/mapid-api.md).

Keys never reach the browser: the backend proxies `v2.basemap.mapid.io` at `/api/basemap/*` and rewrites the style JSON so tiles, sprites and glyphs go through the proxy. The Groq key is backend-only as well.

## MAPID Data Catalogue

The catalogue has no public REST endpoint you import data from with just a key. Import a catalogue layer into your GEO MAPID project first (Import Data -> Premium Data), copy the layer's **OPEN API** URL from Edit Layer, and register it.

Premium Data is sliced per kabupaten/kota — there is no single "all Jabodetabek" layer. Import one slice per kabupaten and list all their URLs under the same name, separated by `|`; the backend fetches every slice and merges them into one FeatureCollection:

```
MAPID_LAYER_URLS=populasi=https://.../jakarta-selatan|https://.../depok|https://.../bekasi,rdtr=https://...
```

`MAPID_CATALOGUE_KEY` authenticates each request. Merged result is served at `GET /api/mapid/catalogue/{name}`.

## Endpoints

```
GET  /api/stations
GET  /api/basemap/styles
GET  /api/basemap/{path}                      proxy to v2.basemap.mapid.io
POST /api/mapid/missions/{propertigo|menugo|struckgo}
POST /api/mapid/activities
GET  /api/mapid/catalogue, /api/mapid/catalogue/{name}
GET  /api/analysis/walk-access?station_id=&minutes=
GET  /api/analysis/route?station_id=&lon=&lat=&preference=comfort|fast
GET  /api/analysis/amenity-equity?station_id=
GET  /api/analysis/site-selection?station_id=&category=&radius=
GET  /api/analysis/tod-index?station_ids=a,b,c
GET  /api/analysis/resilience?station_id=
GET  /api/analysis/detour?station_id=&lon=&lat=
POST /api/ai/insight
```

## Scoring

Weights follow the proposal:

- Walk access = 0.40 jaringan jalan + 0.30 jangkauan pejalan kaki + 0.20 persimpangan + 0.10 keragaman residensial
- SCI/TOD = kepadatan 15, keragaman lahan 3, akses pejalan kaki 6, ekonomi 22, kapasitas stasiun 19, fasilitas 11, aksesibilitas 15, parkir 8 (min-max standardised across the compared stations; ridership is dropped and weights renormalised when not supplied)

## Proxies currently in use

These substitute for datasets not yet loaded, and are marked `PROXY` in `backend/app/analysis.py`:

- Population/commercial density -> OSM building counts (replace with BPS per-grid population)
- Ped-shed -> 100 m buffer of the walkable road network (network service area exists in `network.isochrone`)
- Urban heat -> green cover ratio (replace with Landsat LST zonal statistics)
- Flood risk -> distance to OSM waterway (replace with InaRISK)
- Station capacity -> 0 unless ridership is supplied

Street-level AI (IndoBERT, YOLOv8, DeepLabV3) from the proposal is not wired yet; the walking impedance is currently rule-based on OSM road class in `backend/app/network.py`.
