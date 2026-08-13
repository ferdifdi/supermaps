import { api } from "./api"
import { CLASS_COLORS } from "./tod"
import { CATEGORY_COLORS } from "./equity"

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
    description: "Ketersediaan pangan, minimarket, dan kesehatan dalam jangkauan jalan kaki dari stasiun (MAPID Data Catalogue).",
    extras: "equity",
    options: { radius: [100, 200, 300, 400, 500] },
    run: (station, opts) => api.amenityEquity(station.id, opts.radius || 500),
    layers: [
      { source: "isochrone", type: "fill", paint: { "fill-color": "#0f766e", "fill-opacity": 0.12 } },
      { source: "isochrone", type: "line", paint: { "line-color": "#0f766e", "line-width": 2 } },
      {
        source: "poi", type: "heatmap",
        paint: {
          "heatmap-weight": 1,
          "heatmap-intensity": 1,
          "heatmap-radius": 22,
          "heatmap-opacity": 0.55,
          "heatmap-color": [
            "interpolate", ["linear"], ["heatmap-density"],
            0, "rgba(0,0,0,0)", 0.2, "#c6dbef", 0.4, "#6baed6", 0.6, "#2171b5", 1, "#08306b",
          ],
        },
      },
      {
        source: "poi", type: "circle",
        paint: {
          "circle-radius": 5,
          "circle-color": ["match", ["get", "category"],
            "pangan", CATEGORY_COLORS.pangan, "minimarket", CATEGORY_COLORS.minimarket,
            CATEGORY_COLORS.kesehatan],
          "circle-opacity": ["case", ["get", "reachable"], 1, 0.35],
          "circle-stroke-width": 1, "circle-stroke-color": "#fff",
        },
      },
    ],
    legend: {
      title: "Kategori POI (redup = di luar jangkauan jalan kaki)",
      stops: [["Pangan & kuliner", CATEGORY_COLORS.pangan], ["Minimarket & toko", CATEGORY_COLORS.minimarket], ["Kesehatan", CATEGORY_COLORS.kesehatan]],
    },
    popup: ["name", "category", "reachable"],
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
