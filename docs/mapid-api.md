# MAPID API Reference (extracted 2026-08-12)

Source: `https://maps.mapid.io/docs` (SPA; content extracted from `assets/index-*.js`).
Requires an **active GEO MAPID license**. Key is created at `geo.mapid.io` -> Dashboard -> **MAP SERVICES** -> API Keys -> Create New Key.

## 1. Basemap (vector tiles, Mapbox Style spec)

```
https://v2.basemap.mapid.io/styles/{style-name}/style.json?key=API_KEY
```

| style-name | label |
|---|---|
| `street-v2.0` | Street |
| `satellite-v2.0` | Satellite |
| `dark-v2.0` | Dark |
| `light-v2.0` | Light |

Raster thumbnail: `https://v2.basemap.mapid.io/styles/{style}/tiles/256/{z}/{x}/{y}.png?key=API_KEY`

MapLibre usage:

```js
new maplibregl.Map({
  container: "map",
  style: "https://v2.basemap.mapid.io/styles/street-v2.0/style.json?key=API_KEY",
  center: [106.8271129, -6.1754398],
  zoom: 15.5,
})
```

## 2. Missions (Properti Go / Menu Go / Struck Go)

```
POST https://server.mapid.io/web/competition/{mission-type}
mission-type: propertigo | menugo | struckgo
```

Headers:
```
Content-Type: application/json
x-api-key: API_KEY
```

Body:
```json
{
  "feature": { "type": "Polygon", "coordinates": [[[106.7,-6.3],[107.0,-6.3],[107.0,-6.1],[106.7,-6.1],[106.7,-6.3]]] },
  "offset": 0
}
```

- `feature` (GeoJSON Polygon, required) — search area
- `offset` (Number, optional, default 0) — pagination

Limit is fixed at **100** per request. Response:

```json
{
  "success": true,
  "message": "Data retrieved successfully",
  "features": [
    { "_id": "...", "mission": "mission-type", "type": "Feature",
      "geometry": {"type":"Point","coordinates":[106.75,-6.2]},
      "key": "...", "properties": { } }
  ],
  "pagination": { "total": 100, "limit": 100, "offset": 0, "hasMore": false }
}
```

Paging: keep requesting with `offset += 100` while `hasMore: true`.
Offset beyond `total` returns HTTP 400.

## 3. Activities (Community Maps / Pin Activities)

```
POST https://server.mapid.io/web/competition/activities
```

Headers: same, `x-api-key`.

Body:
```json
{
  "feature": { "type": "Polygon", "coordinates": [[ ... ]] },
  "start_date": "2024-01-01",
  "end_date": "2024-12-31",
  "hashtag": ["kuliner"],
  "author": "budi"
}
```

- `feature` required. `start_date`/`end_date` must be sent **together** (else HTTP 500).
- `hashtag` matches `description` (case-insensitive, partial).
- `author` matches `name` or `full_name`.
- No `offset`/`limit` on this endpoint.

Response `data.activities[]` fields: `_id, title, description, geometry, medias[], user_name, user_full_name, user_profile_picture, community_name, community_picture, community_description, created_at, likes[], total_comment`; plus `meta.filters` and `meta.total`.

## 4. Data Catalogue (Premium Data) — no public REST endpoint

MAPID Data Catalogue is **not** exposed through the competition API. The documented path is:

1. `geo.mapid.io` -> open project -> **Import Data** -> tab **Premium Data**
2. Search keyword (`population`, `POI`, `transportation`), click **Import / Add to Project**
3. Map Editor -> **Edit Layer** (pencil icon) -> field **OPEN API** -> copy the layer API URL
4. That URL is a normal GeoJSON REST endpoint; consume it from the backend

So catalogue data enters SuperMaps as **per-layer OPEN API URLs**, configured in `MAPID_LAYER_URLS` (see `.env.example`). Premium data access depends on the license plan.

## 5. Number of API keys

One key is enough. The docs use two placeholder names (`{{API_KEY}}` for missions, `{{API_KEY_MISSION}}` for activities) but both are plain `x-api-key` values from the same Map Services key manager, and the basemap uses the same key as `?key=`. If `geo.mapid.io` only lets you create one key on your plan, use that single key for basemap + missions + activities. Splitting keys is only useful to separate usage analytics per key (Map Services -> Analytics filters by API Key).
