import { api } from "./api"

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
    title: "Food & Amenity Equity",
    description: "Kepadatan layanan dasar per grid dan penandaan food/amenity desert.",
    run: (station) => api.amenityEquity(station.id),
    layers: [
      {
        source: "grid", type: "fill",
        paint: {
          "fill-color": ["case", ["get", "is_desert"], "#ef4444",
            ramp("basic_need_count", [[0, "#fee5d9"], [10, "#fc9272"], [30, "#de2d26"], [60, "#67000d"]])],
          "fill-opacity": 0.65,
        },
      },
      { source: "poi", type: "circle", paint: { "circle-radius": 3, "circle-color": "#111827" } },
    ],
    legend: { title: "Jumlah POI kebutuhan dasar dalam 500 m", stops: [[0, "#ef4444"], [10, "#fc9272"], [30, "#de2d26"], [60, "#67000d"]] },
    popup: ["basic_need_count", "is_desert"],
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
    multiStation: true,
    run: async (station, opts) => {
      const rows = await api.todIndex(opts.stationIds)
      return {
        stations: {
          type: "FeatureCollection",
          features: rows.map((r) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [r.lon, r.lat] },
            properties: { name: r.station, sci: r.sci, rank: r.rank, typology: r.typology, ...r.components },
          })),
        },
        summary: { ranking: rows.map((r) => ({ rank: r.rank, station: r.station, sci: r.sci, typology: r.typology })) },
      }
    },
    layers: [
      {
        source: "stations", type: "circle",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["get", "sci"], 0, 6, 1, 18],
          "circle-color": ramp("sci", SCORE_STOPS),
          "circle-stroke-width": 1, "circle-stroke-color": "#fff",
        },
      },
    ],
    legend: { title: "Station Composite Index", stops: SCORE_STOPS },
    popup: ["name", "rank", "sci", "typology", "density", "economy", "walk_access", "accessibility"],
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
