import { api } from "./api"
import { CLASS_COLORS } from "./tod"
import { CATEGORIES, CATEGORY_COLORS, CATEGORY_LABELS } from "./equity"

const ramp = (field, stops) => [
  "interpolate", ["linear"], ["get", field],
  ...stops.flat(),
]

const SCORE_STOPS = [[0, "#f7f7f7"], [0.25, "#c6dbef"], [0.5, "#6baed6"], [0.75, "#2171b5"], [1, "#08306b"]]

export const PERSONAS = [
  { id: "komuter", label: "Masyarakat" },
  { id: "usaha", label: "Pelaku Usaha" },
  { id: "kebijakan", label: "Pemangku Kebijakan" },
]

export const USE_CASES = [
  {
    id: "M-UC1",
    persona: "komuter",
    title: "Navigasi Transit & Akses Jalan Kaki",
    description: "Skor akses jalan kaki per grid 250 m dan isochrone jalan kaki dari stasiun.",
    run: (station) => api.walkAccess(station.id, 10),
    layers: [
      { source: "isochrone", type: "fill", paint: { "fill-color": "#f59e0b", "fill-opacity": 0.15 } },
      { source: "isochrone", type: "line", paint: { "line-color": "#f59e0b", "line-width": 2 } },
      { source: "grid", type: "fill", paint: { "fill-color": ramp("walk_score", SCORE_STOPS), "fill-opacity": 0.7 } },
    ],
    legend: { title: "Skor akses jalan kaki", stops: SCORE_STOPS },
    popup: ["walk_score", "road_network", "ped_shed", "intersection", "residential_mix"],
  },
  {
    id: "M-UC2",
    persona: "komuter",
    title: "Basic Needs untuk Komuter",
    description: "Ketersediaan pangan, pusat perbelanjaan/pasar, keuangan, retail, dan kesehatan dalam jangkauan jalan kaki dari stasiun (MAPID Data Catalogue).",
    extras: "equity",
    options: { radius: [100, 200, 300, 400, 500] },
    run: (station, opts) => api.amenityEquity(station.id, opts.radius || 500),
    // "mode" layers only render when App's map-mode toggle matches; layers without a
    // mode (POI dots, route, isochrone outline) always render regardless of which mode
    // is active - the outline in particular needs to stay visible in heatmap modes too,
    // so the coverage flag (green/red) doesn't disappear just because the fill is hidden.
    layers: [
      { source: "isochrone", type: "fill", mode: "isochrone", paint: { "fill-color": "#0f766e", "fill-opacity": 0.12 } },
      {
        source: "isochrone", type: "line",
        paint: {
          "line-color": ["case", ["get", "complete"], "#0f766e", "#ef4444"],
          "line-width": 2,
        },
      },
      {
        // Grid choropleth, not a blurred kernel heatmap - a 250m cell with 0 POI stays
        // untinted so empty cells read as empty, not as "low density".
        source: "grid", type: "fill", mode: "heatmap_poi",
        paint: {
          "fill-color": ["case", ["==", ["get", "poi_count"], 0], "rgba(0,0,0,0)",
            ramp("poi_count", [[0, "#eff3ff"], [5, "#c6dbef"], [15, "#6baed6"], [30, "#2171b5"], [50, "#08306b"]])],
          "fill-opacity": 0.65,
          "fill-outline-color": "rgba(255,255,255,0.4)",
        },
      },
      {
        source: "poi", type: "circle",
        paint: {
          "circle-radius": 5,
          "circle-color": ["match", ["get", "category"],
            ...CATEGORIES.flatMap((c) => [c, CATEGORY_COLORS[c]]),
            "#6b7280"],
          "circle-opacity": ["case", ["get", "reachable"], 1, 0.35],
          "circle-stroke-width": 1, "circle-stroke-color": "#fff",
        },
      },
      { source: "route", type: "line", paint: { "line-color": "#111827", "line-width": 4 } },
    ],
    // Legend switches with the map mode (see App.jsx) - each mode colors the map by a
    // different property, so a single fixed legend would be wrong two-thirds of the time.
    legends: {
      isochrone: {
        title: "Kategori POI (redup = di luar jangkauan jalan kaki)",
        stops: CATEGORIES.map((c) => [CATEGORY_LABELS[c], CATEGORY_COLORS[c]]),
      },
      heatmap_poi: {
        title: "Jumlah POI per grid 250 m",
        stops: [[0, "#eff3ff"], [5, "#c6dbef"], [15, "#6baed6"], [30, "#2171b5"], ["50+", "#08306b"]],
      },
    },
    popup: ["name", "category", "tipe_2", "status", "reachable", "length_m", "minutes"],
  },
  {
    id: "U-UC1",
    persona: "usaha",
    title: "Site Selection & Market Gap",
    description: "Catchment Voronoi kompetitor (Mapid Missions) dan skor kelayakan lokasi usaha.",
    options: { category: ["menugo", "propertigo", "struckgo"] },
    run: (station, opts) => api.siteSelection(station.id, opts.category || "menugo"),
    layers: [
      { source: "grid", type: "fill", paint: { "fill-color": ramp("suitability", SCORE_STOPS), "fill-opacity": 0.7 } },
      { source: "catchment", type: "line", paint: { "line-color": "#7c3aed", "line-width": 1 } },
      { source: "competitors", type: "circle", paint: { "circle-radius": 4, "circle-color": "#7c3aed" } },
    ],
    legend: { title: "Skor kelayakan lokasi", stops: SCORE_STOPS },
    popup: ["suitability", "accessibility", "demand", "market_gap", "competitors"],
  },
  {
    id: "K-UC1",
    persona: "kebijakan",
    title: "Indeks TOD & Prioritas Pengembangan",
    description: "Station Composite Index, ranking stasiun, dan tipologi rekomendasi pengembangan.",
    // Scores every station at once, so App drives it through the dashboard instead of `run`.
    dashboard: true,
    options: { modes: ["rail", "rail,bus"] },
    layers: [
      {
        source: "stations", type: "circle",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["get", "sci"], 0, 6, 1, 18],
          "circle-color": [
            "match", ["get", "classification"],
            "tinggi", CLASS_COLORS.tinggi,
            "sedang", CLASS_COLORS.sedang,
            CLASS_COLORS.rendah,
          ],
          // Filtered-out stations stay on the map, dimmed, so spatial context survives.
          "circle-opacity": ["case", ["get", "dimmed"], 0.15, 0.85],
          "circle-stroke-width": ["case", ["get", "selected"], 3, 1],
          "circle-stroke-color": ["case", ["get", "selected"], "#111827", "#fff"],
          "circle-stroke-opacity": ["case", ["get", "dimmed"], 0.2, 1],
        },
      },
    ],
    legend: {
      title: "Klasifikasi Indeks TOD",
      stops: [["tinggi", CLASS_COLORS.tinggi], ["sedang", CLASS_COLORS.sedang], ["rendah", CLASS_COLORS.rendah]],
    },
    popup: ["name", "rank", "sci", "classification", "typology"],
  },
  {
    id: "K-UC2",
    persona: "kebijakan",
    title: "Climate & Environmental Resilience",
    description: "Kerentanan koridor akses stasiun terhadap panas dan banjir, beserta peringkatnya.",
    run: (station) => api.resilience(station.id),
    layers: [
      {
        source: "corridors", type: "fill",
        paint: {
          "fill-color": ramp("vulnerability", [[0, "#eff3ff"], [0.4, "#fdd0a2"], [0.7, "#fd8d3c"], [1, "#a63603"]]),
          "fill-opacity": 0.7,
        },
      },
    ],
    legend: { title: "Indeks kerentanan koridor", stops: [[0, "#eff3ff"], [0.4, "#fdd0a2"], [0.7, "#fd8d3c"], [1, "#a63603"]] },
    popup: ["highway", "vulnerability", "heat_proxy", "flood_proxy", "rank"],
  },
]
