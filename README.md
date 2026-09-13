# SuperMaps

WebGIS implementation of the proposal *SuperMaps: Spatial Decision Support System untuk Kawasan Transportasi Massal Jabodetabek* (MAPID WebGIS Competition 2026).

- Backend: FastAPI + Shapely/NetworkX/SciPy
- Frontend: React + MapLibre GL, MAPID basemap
- Data: MAPID (basemap, Missions, Activities, Data Catalogue) + OpenStreetMap + BNPB InaRISK (banjir/longsor fallback) + Landsat LST rasters + TransJakarta GTFS + field-survey trotoar photos

## Use cases

| ID    | Persona           | Output                                                                                                                                          |
| ----- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| M-UC1 | Masyarakat        | Skor akses jalan kaki per grid 250 m (Siburian et al. 2020), rute tercepat/ramah kursi roda, transfer antar-moda, ruang hijau, kualitas udara, LST |
| M-UC2 | Masyarakat        | Fasilitas harian (pangan, pasar, keuangan, retail, kesehatan) yang terjangkau jalan kaki dari stasiun                                             |
| U-UC1 | Pelaku usaha      | Kompetitor sejenis (MAPID Data Catalogue), anchor demand, walk score, Voronoi catchment                                                           |
| K-UC1 | Pemangku kebijakan| Station Composite Index (Siburian et al. 2020), ranking stasiun, badge sumber data per indikator                                                  |
| K-UC2 | Pemangku kebijakan| Bahaya banjir/longsor per koridor (MAPID, fallback otomatis BNPB InaRISK), LST & AST, UHI, indeks ekologi, curah hujan, rute detour aman           |

MRT/KRL/LRT geometri jalur rel penuh (`/api/rail-lines`) dan checklist visibilitas per moda tampil di semua use case sebagai layer peta, terlepas dari use case yang dipilih.

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
GET  /api/stations?mode=                      MRT/KRL/LRT/TJ, flagged has_survey (field-survey match)
GET  /api/rail-lines                          full-line MRT/KRL/LRT track geometry
GET  /api/survey/station/{station_id}         field-survey photos + AI trotoar overlay for one station
GET  /api/basemap/styles
GET  /api/basemap/{path}                      proxy to v2.basemap.mapid.io
POST /api/mapid/missions/{propertigo|menugo|struckgo}
POST /api/mapid/activities
GET  /api/mapid/catalogue, /api/mapid/catalogue/{name}
GET  /api/analysis/walk-access?station_id=&radius_m=
GET  /api/analysis/route?station_id=&lon=&lat=&preference=fast|wheelchair
GET  /api/analysis/amenity-equity?station_id=&radius=
GET  /api/analysis/site-selection?station_id=&business_type=&subtype=&subtype2=
GET  /api/analysis/business-types, /business-subtypes, /business-subtypes2
GET  /api/analysis/tod-dashboard?modes=
POST /api/analysis/tod-whatif
GET  /api/analysis/tod-metadata
GET  /api/analysis/resilience?station_id=
GET  /api/analysis/detour?station_id=&lon=&lat=
POST /api/ai/insight, /api/ai/chat, /api/ai/ask
```

## Scoring

Weights follow the proposal:

- Walk access = 0.40 jaringan jalan + 0.30 jangkauan pejalan kaki + 0.20 persimpangan + 0.10 keragaman residensial
- SCI/TOD = kepadatan 15, keragaman lahan 3, akses pejalan kaki 6, ekonomi 22, kapasitas stasiun 19, fasilitas 11, aksesibilitas 15, parkir 8 (min-max standardised across the compared stations; ridership is dropped and weights renormalised when not supplied)

## Real data replacing earlier proxies

Landsat LST (`backend/app/lst.py`, musim hujan & kemarau rasters classified per "panduan klasifikasi LST dan AST.pdf") and BNPB InaRISK (`backend/app/inarisk.py`, live raster query, automatic fallback when MAPID has no flood-zone coverage) now back M-UC1's suhu permukaan and K-UC2's banjir/longsor respectively - these used to be a green-cover-ratio proxy and an OSM-waterway-distance proxy in earlier versions. K-UC2 also derives AST per grid cell from LST via a published linear estimate (Arridha et al. 2023), classified separately from LST rather than treated as the same number.

## Proxies still in use

Marked `PROXY` in `backend/app/analysis.py` (K-UC1's Station Composite Index) or `is_proxy` on individual features (M-UC1/M-UC2 transfer points):

- Population/commercial density -> OSM building/POI counts (replace with BPS per-grid population)
- Passenger volume (peak/off-peak) -> activity density from OSM/MAPID (no free public ridership feed)
- KRL/MRT/LRT transfer walking time -> distance from the static station list, not a live schedule (TransJakarta uses real GTFS headway instead, flagged `is_proxy: false`)
- Station capacity -> 0 unless ridership is supplied
- Security/information boards/alt-transport (K-UC1) -> constant 1.0 for every station - OSM tagging for these is too sparse/inconsistent to be a real signal

Street-level AI (IndoBERT, YOLOv8, DeepLabV3) from the proposal now runs on real field-survey photos for a handful of stations (`backend/analyze_sidewalk_quality.py`, matched one-to-one by station name - see `backend/app/survey.py`), not yet for every station; walking impedance elsewhere is still rule-based on OSM road class in `backend/app/network.py`.
