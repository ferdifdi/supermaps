import { api } from "./api"
import { CLASS_COLORS } from "./tod"
import { CATEGORIES, CATEGORY_COLORS, CATEGORY_ICONS, CATEGORY_LABELS } from "./equity"
import {
  accessByWalkingField, siteGridField, transferPointField, routeField, isochroneMinutesField,
  pm25Field, greenGridField, greenPoiField, roadAccessField, lstField, astField, uhiField,
  ecologyIndexField, rainfallField, floodRiskMapidField, corridorHazardField, sciField,
  anchorPinField, competitorPinField, basicNeedPoiField,
} from "./popupFields"

const ramp = (field, stops) => [
  "interpolate", ["linear"], ["get", field],
  ...stops.flat(),
]

const SCORE_STOPS = [[0, "#f7f7f7"], [0.25, "#c6dbef"], [0.5, "#6baed6"], [0.75, "#2171b5"], [1, "#08306b"]]

export const PERSONAS = [
  {
    id: "komuter", label: "Masyarakat",
    tagline: "Navigasi jalan kaki, transfer, dan kenyamanan dari stasiun",
    icon: "walker",
  },
  {
    id: "usaha", label: "Pelaku Usaha",
    tagline: "Site selection, kompetitor, dan anchor demand sekitar stasiun",
    icon: "storefront",
  },
  {
    id: "kebijakan", label: "Pemangku Kebijakan",
    tagline: "Indeks TOD dan ketahanan iklim kawasan stasiun",
    icon: "landmark",
  },
]

// U-UC1's anchor/competitor icon legend - always-on (App.jsx renders it whenever a
// site-selection result is loaded, not gated by mapMode like the grid-fill legends
// below) since these pins draw independently of whichever grid heatmap is toggled.
export const ANCHOR_LEGEND_ITEMS = [
  { label: "Kantor", icon: "🏢", color: "#4a90e2" },
  { label: "Transit", icon: "🚌", color: "#f59e0b" },
  { label: "Kompetitor", icon: "🏪", color: "#7c3aed" },
  ...CATEGORIES.map((c) => ({ label: CATEGORY_LABELS[c], icon: CATEGORY_ICONS[c], color: CATEGORY_COLORS[c] })),
]

export const USE_CASES = [
  {
    id: "M-UC1",
    persona: "komuter",
    title: "Navigasi Transit & Akses Jalan Kaki",
    description: "Analisis kemudahan jalan kaki dari stasiun/halte, rute navigasi (tercepat & inklusif), kemudahan transfer antar-moda, hingga kondisi lingkungan sekitar (ruang hijau, suhu, & kualitas udara).",
    expectedWait: 6,
    extras: "walk",
    methodology: {
      data: [
        { source: "OSM (Jaringan Jalan & Isochrone)", detail: "Live Overpass, fallback ke cache statis (backend/data/static/) jika gagal. MAPID tidak menyediakan jaringan jalan." },
        { source: "OSM (POI Hunian & Ruang Hijau)", detail: "Untuk residential_mix, canopy, dan ecology_poi. Menggunakan live API (osm.residential_pois(), osm.green_pois(), osm.trees()), fallback ke cache statis (poi_residential_*.py, poi_green_*.py) jika gagal." },
        { source: "MAPID Data Catalogue (POI Komersial)", detail: "Data Perdagangan dan Retail Jabodetabek untuk residential_mix (tanpa fallback OSM)." },
        { source: "OSM (Daftar Stasiun MRT/KRL/LRT)", detail: "Menggunakan daftar terkurasi manual (output/isochrone_*.py). Live Overpass hanya aktif jika file hilang. Data TransJakarta (TJ) bersumber dari GTFS lokal." },
        { source: "TransJakarta GTFS", year: 2026, detail: "Menggunakan file lokal frequencies.txt dan stops.txt." },
        { source: "OpenAQ v3", detail: "Data PM2.5 real-time dari stasiun terdekat (memerlukan API key)." },
        { source: "LST MAPID (Raster GeoTIFF)", detail: "Data musim hujan dan kemarau disampel per grid 250 m dan diklasifikasikan ke dalam 5 kelas. Musim terpilih otomatis berdasarkan bulan berjalan (AST tidak digunakan)." },
        { source: "MAPID Data Catalogue (Indeks Ekologi 2024 & Curah Hujan 2020)", detail: "Indeks ekologi berbasis grid; data curah hujan mencakup kelas dan intensitas per provinsi." },
      ],
      processing: [
        {
          step: "Access by Walking", detail:
            "Weighted sum (Siburian et al., 2020): 40% Road Network + 30% Ped-Shed + 20% Intersection + 10% Residential Diversity per grid 250 m. Standardisasi min-max diterapkan antar-sel dalam buffer lokal (bukan antar-stasiun).",
        },
        { step: "Isochrone & Rute", detail: "Algoritma Dijkstra untuk opsi \"tercepat\" (jarak murni) dan \"ramah kursi roda\" (penalti berat pada ruas wheelchair=no)." },
        { step: "Transfer Efisien", detail: "TransJakarta menggunakan headway asli GTFS. Moda KRL/MRT/LRT menggunakan proxy jarak jalan kaki berdasarkan daftar stasiun statis (output/isochrone_*.py) dan ditandai sebagai is_proxy pada peta." },
        { step: "Kualitas Udara", detail: "Interpolasi Inverse Distance Weighting (IDW) ke hex grid dari stasiun OpenAQ terdekat (sebagai layer konteks, tidak memengaruhi skor)." },
        { step: "LST (Suhu Permukaan)", detail: "Nilai LST disampel per grid 250 m dari raster musim berjalan (Kemarau: April-September; Hujan: Oktober-Maret) dan diklasifikasikan ke dalam 5 kelas." },
        { step: "Indeks Ekologi & Curah Hujan", detail: "Visualisasi langsung dari MAPID Data Catalogue tanpa penghitungan ulang atau penggabungan skor." },
      ],
    },
    options: {
      radius: [400, 800],
    },
    run: (station, opts) => api.walkAccess(station.id, opts.radius || 800),
    // Draw order (MapView adds each layer just below "stations-tj" - or, for the route
    // line specifically, just below "stations-main" so it lands between TJ and MRT/LRT/
    // KRL - so LATER entries here end up ON TOP of earlier ones - this array is bottom-to-
    // top). Requested stacking, topmost first: point pins (transfer/hijau markers are
    // separate DOM Markers, always above the GL canvas regardless of array position) >
    // kerangka jalan (accessibility_roads) > isochrone/route > heatmap (whichever topic is
    // active, at the very bottom so it never hides the road skeleton or isochrone outline
    // above it).
    layers: [
      {
        // Access by Walking (Siburian et al. 2020, Table 1 weights) as one heatmap,
        // standardised per 250m grid cell within this buffer - see analysis.py's
        // walk_access() docstring for why per-cell (not per-station like K-UC1).
        source: "grid", type: "fill", mode: "isochrone", toggle: "heatmap",
        paint: { "fill-opacity": 0.7, "fill-color": ramp("access_by_walking", SCORE_STOPS) },
      },
      {
        // Hex-grid choropleth, IDW-interpolated from real OpenAQ stations - a maplibre
        // "heatmap" layer blurs by screen-pixel radius (visibly shifts color on zoom),
        // this doesn't since it's a plain data-driven fill like uhi/ecology_index/rainfall.
        source: "air_quality_grid", type: "fill", mode: "udara", toggle: "heatmap",
        paint: {
          "fill-opacity": 0.65,
          "fill-color": ramp("pm25", [[0, "#22c55e"], [12, "#84cc16"], [35.4, "#f59e0b"], [55.4, "#f97316"], [150.4, "#ef4444"]]),
        },
      },
      {
        // Trees + green_area/shelter combined, counted per 250m cell (same grid as
        // access_by_walking) - a count-based choropleth like M-UC2's POI heatmap, not a
        // blur-radius kernel that shifts density with zoom. Empty cells stay untinted so
        // "0 hijau" reads as empty, not as "low but present".
        source: "green_grid", type: "fill", mode: "vegetasi", toggle: "heatmap",
        paint: {
          "fill-color": ["case", ["==", ["get", "green_count"], 0], "rgba(0,0,0,0)",
            ramp("green_count", [[0, "#f0fdf4"], [3, "#bbf7d0"], [8, "#4ade80"], [15, "#16a34a"], [25, "#14532d"]])],
          "fill-opacity": 0.7,
          "fill-outline-color": "rgba(255,255,255,0.4)",
        },
      },
      {
        // Real LST (Land Surface Temperature) raster, sampled per 250m grid cell -
        // replaces the old coarse MAPID UHI polygon for M-UC1 (K-UC2 still uses that).
        source: "lst", type: "fill", mode: "lst", toggle: "heatmap",
        paint: {
          "fill-opacity": 0.6,
          "fill-color": ["match", ["get", "CLASS"],
            "Sangat Sejuk", "#0000FF", "Sejuk", "#00FFFF", "Sedang", "#FFFF00",
            "Panas", "#FFA500", "Sangat Panas", "#FF0000", "#9ca3af"],
        },
      },
      {
        // MAPID Data Catalogue - INDEKS (0-1) per grid cell, published value, no rescoring.
        source: "ecology_index", type: "fill", mode: "ekologi_index", toggle: "heatmap",
        paint: {
          "fill-opacity": 0.65,
          "fill-color": ramp("INDEKS", [[0, "#ef4444"], [0.3, "#f59e0b"], [0.6, "#a3e635"], [1, "#15803d"]]),
        },
      },
      {
        // MAPID Data Catalogue - rainfall zone per province (coarse), published as-is.
        source: "rainfall", type: "fill", mode: "hujan", toggle: "heatmap",
        paint: {
          "fill-opacity": 0.5,
          "fill-color": ["match", ["get", "Kelas"],
            "Hujan normal", "#eff3ff", "Hujan deras", "#6baed6", "Hujan sangat deras", "#08306b", "#9ca3af"],
        },
      },
      // Four overlays below (road skeleton, isochrone outline, route, plus the two point-
      // pin layers) aren't mode-gated - each has its own "toggle" key instead, so all can
      // stay visible together regardless of which "Tampilan peta" topic pill is picked.
      // Stacking follows the checkbox order in WalkDock's layer-toggle list top-to-bottom
      // (Isochrone, Titik transfer, Titik hijau, Kerangka jalan, Heatmap): isochrone above
      // road skeleton above heatmap. Titik transfer/hijau are maplibregl.Marker DOM
      // elements, not GL layers - they always float above the whole map canvas regardless
      // of array position, so they can't actually be placed "under" isochrone on screen;
      // that part of the requested order isn't achievable without turning them into GL
      // circle layers, which isn't happening here.
      {
        // Raw wheelchair tag per road segment - no invented weighting, just the OSM fact.
        // Not mode-gated - merged into the base map via its own "jalan" toggle.
        source: "accessibility_roads", type: "line", toggle: "jalan",
        paint: {
          "line-width": 4,
          "line-color": [
            "match", ["get", "wheelchair"],
            "yes", "#22c55e", "limited", "#f59e0b", "no", "#ef4444",
            "#9ca3af",
          ],
        },
      },
      // noPopup: "minutes"/"radius_m"/"kind" are constant across the whole polygon (same
      // number everywhere inside it), not location-specific - a click popup for it just
      // showed the same value no matter where you clicked, which read as a bug.
      { source: "isochrone", type: "fill", toggle: "isochrone", noPopup: true, paint: { "fill-color": "#f59e0b", "fill-opacity": 0.15 } },
      { source: "isochrone", type: "line", toggle: "isochrone", noPopup: true, paint: { "line-color": "#f59e0b", "line-width": 2 } },
      { source: "route", type: "line", paint: { "line-color": "#111827", "line-width": 4 } },
      {
        // TJ stops (real GTFS headway) vs KRL/MRT/LRT points (mode from the static
        // station list, see analysis._transfer_points) - is_proxy drives a visibly
        // different style so the map itself signals which numbers are real.
        // transfer_points already pins every MRT/KRL/LRT/TJ point in range (with
        // headway/proxy info) - stationsLike tells MapView to hide the base all-stations
        // picker dots while this is showing real data, so a station in range doesn't get
        // two markers stacked on it. Before a query runs (no result yet) the base dots
        // stay on, so the first map load still shows every station/halte. Rendered as a
        // maplibregl.Marker (DOM element), so it always floats above every GL layer above
        // regardless of array position - listed last here to match that visually.
        source: "transfer_points", type: "circle", toggle: "poi_transfer", stationsLike: true,
        pin: {
          icon: (p) => (p.mode === "TJ" ? "🚌" : "🚆"),
          color: (p) => (p.is_proxy ? "#9ca3af" : "#22c55e"),
          label: (p) => p.name || p.mode || "Transfer",
        },
      },
      {
        // Individual markers (trees excluded - too dense to click one by one, they only
        // feed green_grid's count below) - click targets for GreenSearch's "Rute"/focus
        // buttons. Also a DOM Marker, always topmost.
        source: "ecology_poi", type: "circle", toggle: "poi_hijau",
        pin: {
          icon: () => "🌳",
          color: () => "#ffffff",
          label: (p) => p.name || p.leisure || p.landuse || p.kind || "Hijau",
        },
      },
      // grid_id label (1, 2, 3... scan-order index set in analysis.py/lst.py, shared
      // across grid/green_grid/lst) - so a cell can be pointed at by number, e.g. the AI
      // insight/ask feature saying "sel #12". Listed last (topmost) on purpose - stacked
      // with the fills earlier these numbers ended up hidden under the isochrone fill/
      // road lines/route drawn on top of them.
      ...["isochrone", "vegetasi", "lst"].map((mode) => ({
        source: mode === "isochrone" ? "grid" : mode === "vegetasi" ? "green_grid" : "lst",
        type: "symbol", mode, toggle: "heatmap", noPopup: true,
        layout: {
          "text-field": ["to-string", ["get", "grid_id"]], "text-size": 9,
          "text-allow-overlap": true, "text-ignore-placement": true,
        },
        paint: { "text-color": "#111827", "text-halo-color": "#ffffff", "text-halo-width": 1 },
      })),
    ],
    legends: {
      isochrone: {
        title: "Access by Walking per grid 250m (Siburian et al. 2020)",
        stops: SCORE_STOPS,
      },
      udara: {
        title: "Kualitas Udara - PM2.5 (µg/m³), interpolasi dari stasiun OpenAQ terdekat",
        stops: [
          ["Baik: 0 – 12 µg/m³", "#22c55e"],
          ["Sedang: 12,1 – 35 µg/m³", "#f59e0b"],
          ["Tidak Sehat: 35,1 – 150 µg/m³", "#ef4444"],
          ["Berbahaya: > 150 µg/m³", "#7f1d1d"],
        ],
      },
      vegetasi: {
        title: "Kepadatan hijau per grid 250m (pohon + taman/RTH)",
        stops: [[0, "#f0fdf4"], [3, "#bbf7d0"], [8, "#4ade80"], [15, "#16a34a"], ["25+", "#14532d"]],
      },
      lst: {
        title: "LST (Suhu Permukaan) per grid 250m",
        stops: [["sangat sejuk", "#0000FF"], ["sejuk", "#00FFFF"], ["sedang", "#FFFF00"], ["panas", "#FFA500"], ["sangat panas", "#FF0000"]],
      },
      ekologi_index: {
        title: "Indeks Ekologi per grid (MAPID, 2024)",
        stops: [["buruk (0)", "#ef4444"], ["sedang (0.3)", "#f59e0b"], ["cukup (0.6)", "#a3e635"], ["baik (1)", "#15803d"]],
      },
      hujan: {
        title: "Curah Hujan (MAPID, 2020)",
        stops: [["normal", "#eff3ff"], ["deras", "#6baed6"], ["sangat deras", "#08306b"]],
      },
    },
    popup: [
      accessByWalkingField, transferPointField, routeField, pm25Field,
      greenGridField, greenPoiField, roadAccessField, lstField, ecologyIndexField, rainfallField,
    ],
  },
  {
    id: "M-UC2",
    persona: "komuter",
    title: "Kebutuhan Pokok Komuter",
    description: "Pemetaan fasilitas harian di sekitar stasiun yang dapat dijangkau dengan jalan kaki, seperti tempat makan, pasar, retail, layanan keuangan, dan kesehatan.",
    expectedWait: 15,
    extras: "equity",
    methodology: {
      data: [
        {
          source: "MAPID Data Catalogue (POI Kebutuhan Pokok)",
          year: 2025, detail: "Apotek, Klinik, Puskesmas, Rumah Sakit, Makanan dan Minuman, Pusat Perbelanjaan, Pasar, Pasar Modern, Bank, ATM, dan Perdagangan dan Retail per kabupaten/kota Jabodetabek (tanpa fallback OSM).",
        },
        { source: "OSM (Jaringan Jalan untuk Isochrone & Rute)", detail: "Live Overpass, fallback ke cache statis (backend/data/static/) jika gagal. MAPID tidak menyediakan jaringan jalan." },
        { source: "OSM (Daftar Stasiun MRT/KRL/LRT)", detail: "Menggunakan daftar terkurasi manual. Live Overpass hanya aktif jika file hilang. Data TransJakarta (TJ) bersumber dari GTFS lokal." },
      ],
      processing: [
        { step: "Isochrone", detail: "Buffer jalan kaki dari stasiun dengan radius pilihan 400 atau 800 m." },
        { step: "Overlay POI", detail: "Setiap POI kebutuhan pokok diperiksa keterjangkauannya dalam isochrone, per kategori." },
        { step: "Heatmap POI", detail: "Grid choropleth 250 m menampilkan jumlah POI per sel." },
        { step: "Skor", detail: "Tidak ada skor komposit; hanya jumlah/rasio mentah per kategori, karena belum ada dasar pembobotan antar-kategori yang tervalidasi." },
      ],
    },
    options: {
      radius: [400, 800],
    },
    run: (station, opts) => api.amenityEquity(station.id, opts.radius || 800),
    // Single unified view - no more separate "Isochrone" mode to switch to, isochrone
    // fill/outline, POI pins, and the heatmap_poi grid all show together (each still
    // independently toggleable via LayerToggles). "heatmap_poi" stays as the one
    // remaining `mode` tag purely so App.jsx's use-case-switch effect still has a mode to
    // auto-select (and usecases.js's legend lookup has a key to resolve) - there's no
    // second mode left to switch away from it to.
    layers: [
      { source: "isochrone", type: "fill", toggle: "poi_isochrone", paint: { "fill-color": "#5b4bdb", "fill-opacity": 0.12 } },
      {
        source: "isochrone", type: "line", toggle: "poi_isochrone",
        paint: {
          "line-color": ["case", ["get", "complete"], "#22c55e", "#ef4444"],
          "line-width": 2,
        },
      },
      {
        // Grid choropleth, not a blurred kernel heatmap - a 250m cell with 0 POI stays
        // untinted so empty cells read as empty, not as "low density".
        source: "grid", type: "fill", mode: "heatmap_poi", toggle: "poi_heatmap",
        paint: {
          "fill-color": ["case", ["==", ["get", "poi_count"], 0], "rgba(0,0,0,0)",
            ramp("poi_count", [[0, "#eff3ff"], [5, "#c6dbef"], [15, "#6baed6"], [30, "#2171b5"], [50, "#08306b"]])],
          "fill-opacity": 0.65,
          "fill-outline-color": "rgba(255,255,255,0.4)",
        },
      },
      {
        source: "poi", type: "circle", toggle: "poi_pins",
        pin: {
          icon: (p) => CATEGORY_ICONS[p.category] || "📍",
          color: (p) => CATEGORY_COLORS[p.category] || "#6b7280",
          label: (p) => p.name || CATEGORY_LABELS[p.category] || "POI",
          opacity: (p) => (p.reachable ? 1 : 0.4),
        },
      },
      { source: "route", type: "line", paint: { "line-color": "#111827", "line-width": 4 } },
      // grid_id label (same scan-order index set in analysis.py's amenity_equity) -
      // listed last (topmost) so it isn't hidden under the fill/route drawn on top of it.
      // Shares the "poi_heatmap" toggle with the grid fill above - hiding the heatmap
      // should hide its cell numbers too, not leave them floating with no fill under them.
      {
        source: "grid", type: "symbol", mode: "heatmap_poi", toggle: "poi_heatmap", noPopup: true,
        layout: {
          "text-field": ["to-string", ["get", "grid_id"]], "text-size": 9,
          "text-allow-overlap": true, "text-ignore-placement": true,
        },
        paint: { "text-color": "#111827", "text-halo-color": "#ffffff", "text-halo-width": 1 },
      },
    ],
    // One legend now that isochrone/POI/heatmap all show together (no more mode switch)
    // - the POI pin category colors are what's genuinely hard to guess without a legend,
    // so they're primary; the heatmap fill's blue shade (light=few, dark=many POI per
    // cell) just gets a one-line explanation instead of its own full stop list, since
    // two different color scales in one legend box reads as two legends stapled together.
    legends: {
      heatmap_poi: {
        title: "Kategori POI (redup = di luar jangkauan jalan kaki)",
        stops: CATEGORIES.map((c) => [CATEGORY_LABELS[c], CATEGORY_COLORS[c]]),
      },
    },
    popup: [basicNeedPoiField(CATEGORY_LABELS), routeField, isochroneMinutesField],
  },
  {
    id: "U-UC1",
    persona: "usaha",
    title: "Site Selection & Market Gap",
    description: "Pemetaan lokasi bisnis strategis di sekitar stasiun melalui analisis keberadaan kompetitor sejenis dan sebaran pusat keramaian (anchor demand).",
    expectedWait: 15,
    extras: "site",
    methodology: {
      data: [
        { source: "MAPID Data Catalogue (Kompetitor 2025)", detail: "Titik lokasi kompetitor berdasarkan tipe bisnis pilihan pengguna (tanpa fallback OSM)." },
        { source: "MAPID Data Catalogue & OSM/GTFS (Anchor Demand 2025)", detail: "Data perkantoran dan fasilitas dasar bersumber dari MAPID (tanpa fallback OSM). Data titik transit (stasiun/halte) bersumber dari kombinasi OSM dan GTFS." },
        { source: "OSM (Jaringan Jalan & POI Hunian untuk Walk Score)", detail: "Live Overpass dengan fallback ke cache statis jika gagal. Radius analisis disesuaikan dengan moda transportasi (800 m untuk MRT/KRL/LRT; 400 m untuk TJ)." },
        { source: "MAPID Data Catalogue (POI Komersial untuk Walk Score)", detail: "Data komersial Jabodetabek tanpa gap radius dan tanpa fallback OSM." },
        { source: "OSM (Daftar Stasiun MRT/KRL/LRT)", detail: "Menggunakan daftar terkurasi manual. Live Overpass hanya diakses jika file tidak ditemukan. Data TransJakarta bersumber dari GTFS lokal." },
      ],
      processing: [
        { step: "Walk Score", detail: "Dihitung per grid 250 m mengacu pada Siburian et al. (2020) dan ditampilkan secara mandiri (tidak digabung dengan metrik lain)." },
        { step: "Kompetitor", detail: "Titik lokasi dari MAPID Data Catalogue berdasarkan kategori yang dipilih, dengan opsi penyaringan hingga 3 tingkat hirarki (Tipe Bisnis → Sub-tipe 2 → Sub-tipe Detail 3). Hitungan berupa nilai mentah per grid (tanpa normalisasi)." },
        { step: "Anchor Demand", detail: "Hitungan mentah per grid untuk jumlah perkantoran, fasilitas dasar, dan titik transit." },
        { step: "Catchment Area", detail: "Pembentukan polygon Voronoi berdasarkan titik-titik kompetitor di dalam radius analisis." },
        { step: "Penyajian Metrik (Tanpa Skor Gabungan)", detail: "Seluruh metrik (aksesibilitas, kompetitor, dan anchor) ditampilkan terpisah sesuai data asli tanpa pembobotan gabungan." },
      ],
    },
    // Real MAPID Data Catalogue categories only (see backend/app/mapid_data.py
    // BUSINESS_TYPES) - MAPID Missions (StrukGo/MenuGo/PropertiGo) was dropped here,
    // coverage was too sparse to be usable (0-2 hits in a 1km radius).
    options: {
      businessType: [
        "APOTEK", "KLINIK", "PUSKESMAS", "RUMAH SAKIT", "MAKANAN DAN MINUMAN",
        "PUSAT PERBELANJAAN", "PASAR", "PASAR MODERN", "BANK", "ATM",
        "PERDAGANGAN DAN RETAIL", "KANTOR",
      ],
    },
    run: (station, opts) => api.siteSelection(station.id, opts.businessType || "APOTEK", opts.subtype, opts.subtype2),
    layers: [
      { source: "grid", type: "fill", mode: "walk_score", toggle: "site_heatmap", paint: { "fill-color": ramp("walk_score", SCORE_STOPS), "fill-opacity": 0.7 } },
      {
        source: "grid", type: "fill", mode: "kompetitor", toggle: "site_heatmap",
        paint: { "fill-color": ramp("competitor_count", [[0, "#f7f7f7"], [1, "#e9d5ff"], [2, "#c084fc"], [4, "#9333ea"], [6, "#581c87"]]), "fill-opacity": 0.7 },
      },
      {
        source: "grid", type: "fill", mode: "anchor", toggle: "site_heatmap",
        paint: {
          "fill-opacity": 0.7,
          "fill-color": [
            "interpolate", ["linear"],
            ["+", ["get", "anchor_kantor"], ["get", "anchor_kebutuhan_dasar"], ["get", "anchor_transit"]],
            0, "#f7f7f7", 3, "#bbf7d0", 8, "#4ade80", 15, "#16a34a", 25, "#14532d",
          ],
        },
      },
      { source: "catchment", type: "line", toggle: "site_catchment", paint: { "line-color": "#7c3aed", "line-width": 1 } },
      {
        // kebutuhan_dasar anchors carry the same 5-bucket `category` (pangan/kesehatan/dll)
        // as M-UC2's basic-need POIs (mapid_data.basic_needs) - reusing CATEGORY_ICONS/
        // CATEGORY_COLORS keeps "klinik/RS/apotek/puskesmas" (all bucketed under
        // "kesehatan") visually distinct from kantor/transit instead of one flat 🛒 icon.
        source: "anchors", type: "circle", toggle: "site_anchor",
        pin: {
          icon: (p) => p.anchor_type === "kebutuhan_dasar"
            ? (CATEGORY_ICONS[p.category] || "🛒")
            : ({ kantor: "🏢", transit: "🚌" }[p.anchor_type] || "📍"),
          color: (p) => p.anchor_type === "kebutuhan_dasar"
            ? (CATEGORY_COLORS[p.category] || "#22c55e")
            : ({ kantor: "#4a90e2", transit: "#f59e0b" }[p.anchor_type] || "#9ca3af"),
          label: (p) => p.name || (p.anchor_type === "kebutuhan_dasar" ? CATEGORY_LABELS[p.category] : p.anchor_type) || "Anchor",
          opacity: () => 0.85,
        },
      },
      // One business type per query, so every competitor pin is the same solid color -
      // no rainbow mixing, gampang dibedain dari anchor.
      {
        source: "competitors", type: "circle", toggle: "site_competitor",
        pin: { icon: () => "🏪", color: () => "#7c3aed", label: (p) => p.name || "Kompetitor" },
      },
      // grid_id label (same scan-order index set in analysis.py's site_selection) - one
      // per mode since all three grid fills above share this "grid" source/grid_id.
      // Listed last (topmost) so it isn't hidden under the fill/catchment lines above it.
      ...["walk_score", "kompetitor", "anchor"].map((mode) => ({
        source: "grid", type: "symbol", mode, toggle: "site_heatmap", noPopup: true,
        layout: {
          "text-field": ["to-string", ["get", "grid_id"]], "text-size": 9,
          "text-allow-overlap": true, "text-ignore-placement": true,
        },
        paint: { "text-color": "#111827", "text-halo-color": "#ffffff", "text-halo-width": 1 },
      })),
    ],
    legends: {
      walk_score: { title: "Walk score (Siburian et al. 2020)", stops: SCORE_STOPS },
      kompetitor: {
        title: "Jumlah kompetitor per grid",
        stops: [[0, "#f7f7f7"], [1, "#e9d5ff"], [2, "#c084fc"], [4, "#9333ea"], ["6+", "#581c87"]],
      },
      anchor: {
        title: "Anchor MAPID per grid (kantor+kebutuhan dasar+transit)",
        stops: [[0, "#f7f7f7"], [3, "#bbf7d0"], [8, "#4ade80"], [15, "#16a34a"], ["25+", "#14532d"]],
      },
    },
    popup: [siteGridField, anchorPinField, competitorPinField],
  },
  {
    id: "K-UC1",
    persona: "kebijakan",
    title: "Indeks TOD & Prioritas Pengembangan",
    description: "Penilaian performa kawasan transit melalui Station Composite Index, peringkat antar-stasiun, serta arahan tipologi rekomendasi pengembangan TOD.",
    expectedWait: 30,
    // Scores every station at once, so App drives it through the dashboard instead of `run`.
    dashboard: true,
    methodology: {
      data: [
        { source: "OSM (Daftar Stasiun Scanned)", detail: "Menggunakan daftar terkurasi manual (output/isochrone_*.py) khusus moda KRL, MRT, dan LRT (live Overpass hanya aktif jika file hilang). TransJakarta tidak dimasukkan dalam cakupan K-UC1." },
        { source: "OSM (Jaringan Jalan & POI Kawasan Transit)", detail: "Jaringan jalan diakses via live Overpass (fallback ke cache statis jika gagal). POI hunian, ruang hijau, dan area parkir diakses via live query terpisah (fallback ke cache statis poi_*.py jika gagal) untuk perhitungan kepadatan penduduk, keberagaman tata guna lahan, parkir mobil/motor, dan aksesibilitas bangunan. MAPID tidak menyediakan jaringan jalan, layer hijau berbasis titik, dan kategori parkir." },
        { source: "MAPID Data Catalogue (Komersial & Bisnis 2025)", detail: "Data perdagangan, retail, perkantoran, dan transit langsung dari kategori MAPID tanpa fallback OSM." },
        { source: "Indikator Konstan (Keamanan, Informasi, Transpos Alt.)", detail: "Nilai diasumsikan seragam (1,0) untuk seluruh stasiun karena tag OSM yang nyaris kosong/tidak konsisten, sehingga tidak dijadikan faktor pembeda pemeringkatan." },
        { source: "Cache Statis Per Moda (backend/data/k-uc1/)", detail: "Hasil precompute station_indicators() diprioritaskan untuk pemrosesan. Live query hanya dijalankan untuk stasiun di luar jangkauan cache. Tanggal generate ditampilkan pada panel metadata." },
      ],
      processing: [
        { step: "Station Composite Index (SCI)", detail: "Dihitung berdasarkan 8 kriteria dan 18 indikator mengacu pada Siburian et al. (2020) Tabel 1. Skor kriteria dijumlahkan secara terbobot dan dibagi total bobot." },
        {
          step: "Kategori Sumber Indikator", detail:
            "OSM / MAPID: indikator dengan pengukuran langsung. PROXY: kepadatan aktivitas (OSM/MAPID) digunakan sebagai proxy data penumpang yang tidak memiliki feed publik gratis. CONSTANT: frekuensi perjalanan, keamanan, papan informasi, dan transportasi alternatif diberikan nilai seragam.",
        },
        { step: "Transparansi Metadata", detail: "Setiap indikator dilengkapi badge penanda sumber (OSM, MAPID, PROXY, atau CONSTANT)." },
        {
          step: "Pembatasan Pemrosesan TransJakarta & Rate Limiting", detail:
            "TransJakarta dieliminasi dari K-UC1 karena volume ribuan halte yang dapat mengganggu kestabilan scan masal kawasan. Pemrosesan berjalan secara sekuensial (mekanisme semaphore) untuk mencegah rate-limit atau blocklisting pada Overpass API.",
        },
      ],
    },
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
      {
        // Mode glyph on top of the SCI-sized bubble, same per-mode icon treatment as the
        // base station picker dots (station-icon-* images registered by MapView).
        source: "stations", type: "symbol", noPopup: true,
        layout: {
          "icon-image": ["match", ["get", "mode"],
            "MRT", "station-icon-MRT", "LRT", "station-icon-LRT",
            "KRL", "station-icon-KRL", "TJ", "station-icon-TJ",
            "station-icon-default"],
          "icon-size": ["interpolate", ["linear"], ["get", "sci"], 0, 0.12, 1, 0.20],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-opacity": ["case", ["get", "dimmed"], 0.2, 1] },
      },
      {
        source: "stations", type: "symbol", noPopup: true, label: true,
        layout: {
          "text-field": ["get", "name"],
          "text-size": 10,
          "text-offset": [0, 1.3],
          "text-anchor": "top",
        },
        paint: {
          "text-color": "#111827",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.4,
          "text-opacity": ["case", ["get", "dimmed"], 0.15, 1],
        },
      },
    ],
    legend: {
      title: "Klasifikasi Indeks TOD",
      stops: [["tinggi", CLASS_COLORS.tinggi], ["sedang", CLASS_COLORS.sedang], ["rendah", CLASS_COLORS.rendah]],
    },
    popup: [sciField],
  },
  {
    id: "K-UC2",
    persona: "kebijakan",
    title: "Climate & Environmental Resilience",
    description: "Pemetaan risiko banjir per koridor stasiun yang dipadukan dengan analisis mikroiklim kawasan, mencakup efek pulau panas (Urban Heat Island), kondisi ekologi, dan curah hujan.",
    expectedWait: 6,
    methodology: {
      data: [
        { source: "MAPID Data Catalogue (Bahaya Banjir)", detail: "Data utama berupa klasifikasi 5 tingkat (Sangat Rendah hingga Tinggi) per zona. Digunakan jika minimal terdapat satu koridor dalam buffer stasiun yang tercakup zona MAPID." },
        { source: "BNPB InaRISK (Bahaya Banjir & Longsor)", detail: "Live raster query resmi pemerintah dengan indeks 0–1 (klasifikasi Rendah/Sedang/Tinggi). Digunakan sebagai fallback untuk seluruh buffer stasiun jika MAPID tidak mencakup zona banjir di area tersebut. Data longsor bersumber sepenuhnya dari InaRISK." },
        { source: "MAPID Data Catalogue (UHI 2022, Indeks Ekologi 2024, & Curah Hujan 2020)", detail: "Zona panas UHI per kabupaten/kota, Indeks Ekologi (turunan RSEI) berbasis grid, serta kelas dan intensitas curah hujan per provinsi (tanpa fallback)." },
        { source: "LST Musim Hujan (1 Des 2025 – 31 Jan 2026)", detail: "Pengolahan mengombinasikan citra Landsat 8 dan Landsat 9 untuk reduksi tutupan awan, pembersihan nilai ekstrem (< 0°C), serta penambalan piksel kosong (gap-filling) menggunakan focal mean 100 m." },
        { source: "LST Musim Kemarau (1 Jul – 30 Sep 2025)", detail: "Pemetaan diproses menggunakan citra Landsat 9." },
        { source: "OSM (Jaringan Jalan & Daftar Stasiun)", detail: "Jaringan jalan diakses via live Overpass (fallback ke cache statis jika gagal). Daftar stasiun MRT/KRL/LRT menggunakan data terkurasi manual (live Overpass hanya aktif jika file hilang), sedangkan TransJakarta bersumber dari GTFS lokal." },
      ],
      processing: [
        { step: "Analisis Banjir Utama (MAPID)", detail: "Pemrosesan point-in-polygon berbasis zona MAPID per koridor secara instan tanpa panggilan live, mempertahankan klasifikasi asli 5 tingkat." },
        { step: "Analisis Banjir & Longsor Fallback (BNPB InaRISK)", detail: "Jika data MAPID tidak menyentuh buffer stasiun, sistem melakukan raster identify call dari InaRISK pada hexagon grid (~120 m). Nilai sampel terdekat dialokasikan ke setiap koridor menggunakan skema klasifikasi 3 tingkat resmi InaRISK." },
        { step: "Estimasi Air Surface Temperature (AST)", detail: "Diaplikasikan pada kedua musim dari nilai LST menggunakan persamaan linier mengacu pada model Arridha et al. (2023): AST = 0,9756 × LST + 1,7311." },
        { step: "Rute Detour Aman", detail: "Ruas jalan berstatus risiko \"Tinggi\"/\"Cukup Tinggi\" (MAPID) atau \"Tinggi\" (InaRISK banjir/longsor) diberikan penalti berat (hard avoidance) dalam penentuan rute, tanpa pembobotan skor gabungan." },
        { step: "UHI, Ekologi, & Curah Hujan", detail: "Visualisasi data ditampilkan apa adanya sesuai data asli MAPID Data Catalogue tanpa penghitungan ulang." },
        { step: "Penyajian Metrik (Tanpa Skor Gabungan)", detail: "Seluruh metrik lingkungan dan risiko bencana ditampilkan secara terpisah. Model komposit terdahulu (blending tutupan hijau dan jarak sungai) telah dihapus sepenuhnya." },
      ],
    },
    extras: "resilience",
    run: (station) => api.resilience(station.id),
    layers: [
      {
        // Static mode fills "banjir_kelas" (MAPID's 5-level Kelas), live mode fills
        // "banjir_class" (BNPB InaRISK's 3-level rendah/sedang/tinggi) instead - coalesce
        // reads whichever one this run actually populated (see analysis.py's resilience()).
        source: "corridors", type: "fill", mode: "banjir", toggle: "resilience_heatmap",
        paint: {
          "fill-opacity": 0.65,
          "fill-color": ["match", ["coalesce", ["get", "banjir_kelas"], ["get", "banjir_class"]],
            "Sangat Rendah", "#22c55e", "Cukup Rendah", "#84cc16", "Sedang", "#f59e0b",
            "Cukup Tinggi", "#f97316", "Tinggi", "#ef4444",
            "rendah", "#22c55e", "sedang", "#f59e0b", "tinggi", "#ef4444",
            "#e5e7eb"],
        },
      },
      {
        // Longsor only ever has data in live mode (InaRISK) - static mode's corridors
        // carry no longsor_class at all, so this renders flat gray, which is correct
        // (not "no risk", just "no live InaRISK data in this run").
        source: "corridors", type: "fill", mode: "longsor", toggle: "resilience_heatmap",
        paint: {
          "fill-opacity": 0.65,
          "fill-color": ["match", ["get", "longsor_class"],
            "rendah", "#22c55e", "sedang", "#f59e0b", "tinggi", "#ef4444", "#e5e7eb"],
        },
      },
      {
        source: "uhi", type: "fill", mode: "uhi", toggle: "resilience_heatmap",
        paint: {
          "fill-opacity": 0.5,
          "fill-color": ["match", ["get", "CLASS"],
            "HOT ZONE", "#ef4444", "VERY WARM ZONE", "#f97316", "NORMAL ZONE", "#22c55e", "#9ca3af"],
        },
      },
      {
        source: "ecology_index", type: "fill", mode: "ekologi_index", toggle: "resilience_heatmap",
        paint: { "fill-opacity": 0.65, "fill-color": ramp("INDEKS", [[0, "#ef4444"], [0.3, "#f59e0b"], [0.6, "#a3e635"], [1, "#15803d"]]) },
      },
      {
        source: "rainfall", type: "fill", mode: "hujan", toggle: "resilience_heatmap",
        paint: {
          "fill-opacity": 0.5,
          "fill-color": ["match", ["get", "Kelas"],
            "Hujan normal", "#eff3ff", "Hujan deras", "#6baed6", "Hujan sangat deras", "#08306b", "#9ca3af"],
        },
      },
      {
        source: "flood_risk_mapid", type: "fill", mode: "banjir_mapid", toggle: "resilience_heatmap",
        paint: {
          "fill-opacity": 0.6,
          "fill-color": ["match", ["get", "Kelas"],
            "Sangat Rendah", "#22c55e", "Cukup Rendah", "#84cc16", "Sedang", "#f59e0b",
            "Cukup Tinggi", "#f97316", "Tinggi", "#ef4444", "#9ca3af"],
        },
      },
      {
        // Same raster/palette as M-UC1's LST layer (lst.py's sample_grid).
        source: "lst", type: "fill", mode: "lst", toggle: "resilience_heatmap",
        paint: {
          "fill-opacity": 0.65,
          "fill-color": ["match", ["get", "CLASS"],
            "Sangat Sejuk", "#0000FF", "Sejuk", "#00FFFF", "Sedang", "#FFFF00",
            "Panas", "#FFA500", "Sangat Panas", "#FF0000", "#9ca3af"],
        },
      },
      {
        // AST estimate (Arridha et al. 2023), classified on its own CLASS_AST (see
        // lst.py's classify_ast - same bins as LST, just evaluated on the AST-to-LST
        // inverse) - a separate layer/topic from LST above, not folded into it.
        source: "lst", type: "fill", mode: "ast", toggle: "resilience_heatmap",
        paint: {
          "fill-opacity": 0.65,
          "fill-color": ["match", ["get", "CLASS_AST"],
            "Sangat Sejuk", "#0000FF", "Sejuk", "#00FFFF", "Sedang", "#FFFF00",
            "Panas", "#FFA500", "Sangat Panas", "#FF0000", "#9ca3af"],
        },
      },
    ],
    legends: {
      banjir: {
        title: "Indeks bahaya banjir per koridor",
        stops: [["rendah / sangat-cukup rendah", "#22c55e"], ["sedang", "#f59e0b"], ["tinggi / cukup tinggi", "#ef4444"], ["tidak ada data", "#e5e7eb"]],
      },
      longsor: {
        title: "Indeks bahaya longsor per koridor (BNPB InaRISK)",
        stops: [["rendah", "#22c55e"], ["sedang", "#f59e0b"], ["tinggi", "#ef4444"], ["tidak ada data", "#e5e7eb"]],
      },
      uhi: { title: "Urban Heat Island (MAPID, 2022)", stops: [["zona normal", "#22c55e"], ["zona hangat", "#f97316"], ["zona panas", "#ef4444"]] },
      ekologi_index: { title: "Indeks Ekologi per grid (MAPID, 2024)", stops: [["buruk (0)", "#ef4444"], ["sedang (0.3)", "#f59e0b"], ["cukup (0.6)", "#a3e635"], ["baik (1)", "#15803d"]] },
      hujan: { title: "Curah Hujan (MAPID, 2020)", stops: [["normal", "#eff3ff"], ["deras", "#6baed6"], ["sangat deras", "#08306b"]] },
      banjir_mapid: {
        title: "Wilayah Bahaya/Terancam Banjir (MAPID)",
        stops: [["sangat rendah", "#22c55e"], ["cukup rendah", "#84cc16"], ["sedang", "#f59e0b"], ["cukup tinggi", "#f97316"], ["tinggi", "#ef4444"]],
      },
      lst: {
        title: "LST (Suhu Permukaan) per grid 250m",
        stops: [["sangat sejuk", "#0000FF"], ["sejuk", "#00FFFF"], ["sedang", "#FFFF00"], ["panas", "#FFA500"], ["sangat panas", "#FF0000"]],
      },
      ast: {
        title: "AST (estimasi, Arridha et al. 2023) per grid 250m",
        stops: [["sangat sejuk", "#0000FF"], ["sejuk", "#00FFFF"], ["sedang", "#FFFF00"], ["panas", "#FFA500"], ["sangat panas", "#FF0000"]],
      },
    },
    popup: [corridorHazardField, uhiField, ecologyIndexField, rainfallField, floodRiskMapidField, lstField, astField],
  },
]
