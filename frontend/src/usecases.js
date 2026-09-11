import { api } from "./api"
import { CLASS_COLORS } from "./tod"
import { CATEGORIES, CATEGORY_COLORS, CATEGORY_ICONS, CATEGORY_LABELS } from "./equity"
import {
  accessByWalkingField, siteGridField, transferPointField, routeField, isochroneMinutesField,
  pm25Field, greenGridField, greenPoiField, roadAccessField, lstField, uhiField,
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

export const USE_CASES = [
  {
    id: "M-UC1",
    persona: "komuter",
    title: "Navigasi Transit & Akses Jalan Kaki",
    description: "Navigasi jalan kaki dari stasiun/halte secara lengkap: skor akses jalan kaki per grid 250m (Siburian et al. 2020), isochrone & rute (tercepat/ramah kursi roda), efisiensi transfer ke moda lain (headway TransJakarta, proxy KRL/MRT/LRT), akses ruang hijau (taman, RTH, kanopi pohon), kualitas udara (PM2.5), suhu permukaan (LST), indeks ekologi, dan curah hujan.",
    expectedWait: 6,
    extras: "walk",
    methodology: {
      data: [
        { source: "OSM - jaringan jalan & isochrone", detail: "MAPID gak punya jaringan jalan. Live Overpass dulu, fallback ke cache statis (backend/data/static/) cuma kalau live gagal." },
        { source: "OSM - POI hunian & pohon/ruang hijau", detail: "Dipakai buat residential_mix, canopy, ecology_poi. Live osm.residential_pois()/osm.green_pois()/osm.trees() dulu, fallback ke cache statis (poi_residential_*.py, poi_green_*.py) cuma kalau live gagal." },
        { source: "MAPID Data Catalogue - POI komersial (PERDAGANGAN DAN RETAIL, buat residential_mix)", detail: "Satu file Jabodetabek, gak ada gap radius/mode. Gak ada fallback OSM." },
        { source: "OSM - daftar stasiun MRT/KRL/LRT (dropdown pemilih)", detail: "Daftar terkurasi manual (output/isochrone_*.py) - live Overpass cuma dipanggil kalau file ini hilang. TJ dari GTFS lokal, selalu instan." },
        { source: "TransJakarta GTFS", year: 2026, detail: "frequencies.txt (headway asli per trip), stops.txt - file lokal, bukan live" },
        { source: "OpenAQ v3", detail: "PM2.5 real-time dari stasiun pemantau terdekat (butuh API key, kosong kalau belum dikonfigurasi)" },
        { source: "LST MAPID (raster GeoTIFF)", detail: "Raster musim hujan & kemarau, disampel per grid 250m dan diklasifikasi 5 kelas sesuai panduan MAPID - musim dipilih otomatis dari bulan berjalan. AST (turunan LST) tidak dipakai." },
        { source: "MAPID Data Catalogue - INDEKS EKOLOGI", year: 2024, detail: "indeks per grid" },
        { source: "MAPID Data Catalogue - Curah Hujan (Presipitasi)", year: 2020, detail: "kelas & intensitas per provinsi" },
      ],
      processing: [
        {
          step: "Access by Walking", detail:
            "Weighted sum Tabel 1 Siburian et al. (2020): 40% Road Network + 30% Ped-Shed + 20% Intersection + 10% Residential Diversity, per grid 250m. Standardisasi min-max (formula 3) dilakukan antar-sel dalam buffer ini, bukan antar-stasiun seperti versi asli paper (K-UC1) - komuter cuma lihat 1 stasiun, gak ada pembanding stasiun lain.",
        },
        { step: "Isochrone & rute", detail: "Dijkstra: \"tercepat\" (jarak murni) dan \"ramah kursi roda\" (jarak, ruas wheelchair=no dipenalti berat) - tidak ada formula kenyamanan racikan sendiri" },
        { step: "Transfer efisien", detail: "TransJakarta pakai headway asli dari GTFS; KRL/MRT/LRT proxy jarak jalan kaki, mode-nya dari daftar stasiun statis (output/isochrone_*.py, sama kayak dropdown - bukan re-tebak dari tag OSM mentah lagi biar gak salah label kayak dulu) (ditandai is_proxy di peta)" },
        { step: "Kualitas udara", detail: "Interpolasi IDW ke hex grid dari stasiun OpenAQ terdekat - layer konteks, tidak masuk skor manapun" },
        { step: "LST (Suhu Permukaan)", detail: "Nilai LST asli disampel per grid 250m dari raster musim berjalan (BMKG: kemarau April-September, hujan Oktober-Maret) lalu diklasifikasi 5 kelas - tidak digabung jadi skor" },
        { step: "Indeks ekologi / Curah hujan", detail: "Ditampilkan apa adanya dari MAPID Data Catalogue, tanpa dihitung ulang atau digabung jadi skor" },
      ],
    },
    options: {
      radius: [400, 800],
    },
    run: (station, opts) => api.walkAccess(station.id, opts.radius || 800),
    // Draw order (MapView adds each layer just below "stations", so LATER entries here
    // end up ON TOP of earlier ones - this array is bottom-to-top). Requested stacking,
    // topmost first: point pins (transfer/hijau markers are separate DOM Markers, always
    // above the GL canvas regardless of array position) > kerangka jalan (accessibility_
    // roads) > isochrone/route > heatmap (whichever topic is active, at the very bottom
    // so it never hides the road skeleton or isochrone outline above it).
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
          color: () => "#22c55e",
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
        title: "PM2.5 (µg/m³) - interpolasi dari stasiun OpenAQ terdekat",
        stops: [["baik (≤12)", "#22c55e"], ["sedang (≤35)", "#f59e0b"], ["tidak sehat (≤150)", "#ef4444"], ["berbahaya (>150)", "#7f1d1d"]],
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
    title: "Basic Needs untuk Komuter",
    description: "Ketersediaan pangan, pusat perbelanjaan/pasar, keuangan, retail, dan kesehatan dalam jangkauan jalan kaki dari stasiun (MAPID Data Catalogue).",
    expectedWait: 15,
    extras: "equity",
    methodology: {
      data: [
        {
          source: "MAPID Data Catalogue - APOTEK, KLINIK, PUSKESMAS, RUMAH SAKIT, MAKANAN DAN MINUMAN, PUSAT PERBELANJAAN, PASAR, PASAR MODERN, BANK, ATM, PERDAGANGAN DAN RETAIL",
          year: 2025, detail: "Per kabupaten/kota Jabodetabek. Gak ada fallback OSM - kosong di suatu stasiun/radius berarti memang gak ada POI di sana.",
        },
        { source: "OSM - jaringan jalan (isochrone & rute)", detail: "MAPID gak punya jaringan jalan. Live Overpass dulu, fallback ke cache statis (backend/data/static/) cuma kalau live gagal." },
        { source: "OSM - daftar stasiun MRT/KRL/LRT (dropdown)", detail: "Daftar terkurasi manual - live Overpass cuma dipanggil kalau file ini hilang. TJ dari GTFS lokal, instan." },
      ],
      processing: [
        { step: "Isochrone", detail: "Buffer jalan kaki dari stasiun, radius pilihan 400 atau 800m" },
        { step: "Overlay POI", detail: "Tiap POI basic-need dicek reachable/tidak dalam isochrone, per kategori" },
        { step: "Heatmap POI", detail: "Grid choropleth 250m: jumlah POI per sel" },
        { step: "Skor", detail: "Tidak ada equity_score komposit - cuma raw count/rasio per kategori (sengaja dihindari, gak ada dasar buat bobot antar kategori)" },
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
    description: "Pilih tipe bisnis, lihat kompetitor setipe (MAPID Data Catalogue) dan anchor demand di sekitar stasiun.",
    expectedWait: 15,
    extras: "site",
    methodology: {
      data: [
        {
          source: "MAPID Data Catalogue - kompetitor (tipe bisnis dipilih user)",
          year: 2025, detail: "Contoh: \"MAKANAN DAN MINUMAN\" -> 222 kompetitor di radius 1km Dukuh Atas. Gak ada fallback OSM.",
        },
        {
          source: "MAPID Data Catalogue - KANTOR, APOTEK/KLINIK/PUSKESMAS/RUMAH SAKIT/BANK/ATM/PASAR/dst, HALTE/STASIUN",
          year: 2025, detail: "Anchor: kantor & kebutuhan dasar dari MAPID (gak ada fallback OSM), transit dari OSM+GTFS (MAPID gak punya daftar stasiun/halte sendiri di jalur ini).",
        },
        {
          source: "OSM - jaringan jalan & POI hunian (walk_score)", detail:
            "Live Overpass dulu, fallback ke cache statis cuma kalau live gagal - radius default ikut mode stasiun (800m MRT/KRL/LRT, 400m TJ) supaya pas sama cakupan cache.",
        },
        {
          source: "MAPID Data Catalogue - POI komersial (buat walk_score)", detail:
            "Satu file Jabodetabek, gak ada gap radius. Gak ada fallback OSM.",
        },
        { source: "OSM - daftar stasiun MRT/KRL/LRT (dropdown)", detail: "Daftar terkurasi manual - live Overpass cuma dipanggil kalau file ini hilang. TJ dari GTFS lokal, instan." },
      ],
      processing: [
        { step: "Walk score", detail: "Siburian et al. 2020, per grid 250m - ditampilkan berdiri sendiri, bukan digabung ke metrik lain" },
        { step: "Kompetitor", detail: "Titik MAPID Data Catalogue dengan kategori persis sama dengan tipe bisnis yang dipilih - bisa dipersempit sampai 3 tingkat (Tipe bisnis -> Sub-tipe TIPE_2 -> Sub-tipe detail TIPE_3, misal MAKANAN DAN MINUMAN -> MINUMAN -> COFFEESHOP). Hitungan mentah per grid, tidak dinormalisasi." },
        { step: "Anchor", detail: "Hitungan mentah kantor/kebutuhan dasar/transit MAPID per grid" },
        { step: "Tidak ada skor gabungan", detail: "Tidak ada formula tervalidasi buat nimbang aksesibilitas vs kompetitor vs anchor, jadi semua ditampilkan apa adanya - pilih sendiri layer mana yang mau dilihat" },
        { step: "Catchment", detail: "Voronoi dari titik kompetitor dalam radius" },
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
        source: "anchors", type: "circle", toggle: "site_anchor",
        pin: {
          icon: (p) => ({ kantor: "🏢", kebutuhan_dasar: "🛒", transit: "🚌" }[p.anchor_type] || "📍"),
          color: (p) => ({ kantor: "#4a90e2", kebutuhan_dasar: "#22c55e", transit: "#f59e0b" }[p.anchor_type] || "#9ca3af"),
          label: (p) => p.name || p.anchor_type || "Anchor",
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
    description: "Station Composite Index, ranking stasiun, dan tipologi rekomendasi pengembangan.",
    expectedWait: 30,
    // Scores every station at once, so App drives it through the dashboard instead of `run`.
    dashboard: true,
    methodology: {
      data: [
        { source: "OSM - daftar stasiun/halte yang di-scan", detail: "Daftar terkurasi manual (output/isochrone_*.py) - live Overpass cuma dipanggil kalau file ini hilang. KRL/MRT/LRT saja - TJ tidak masuk cakupan K-UC1 (halte terlalu banyak buat scan sekaligus, lihat catatan pemrosesan)." },
        { source: "OSM - jaringan jalan per stasiun", detail: "MAPID gak punya jaringan jalan. Live Overpass dulu, fallback ke cache statis (backend/data/static/) cuma kalau live gagal." },
        {
          source: "OSM - POI hunian, ruang hijau, parkir per stasiun", detail:
            "MAPID gak punya kategori parkir, gak ada layer hijau berbasis titik. Dipakai buat population_density, land_use_diversity (residential/green), car_parking, motorcycle_parking, accessible_buildings. Query terpisah (osm.residential_pois()/osm.green_pois()/osm.facility_pois()) - live dulu, fallback ke cache statis (poi_residential_*.py, poi_green_*.py, poi_parking_*.py) cuma kalau live gagal.",
        },
        {
          source: "Keamanan, papan informasi, transportasi alternatif", detail:
            "CONSTANT - tag OSM buat ketiganya ternyata nyaris kosong/gak konsisten di hampir semua stasiun, gak bisa jadi sinyal pembeda. Diasumsikan sama (1.0) untuk semua stasiun semua moda, sama kayak train_trips - bukan diukur, sengaja gak dihitung sebagai pembeda ranking.",
        },
        {
          source: "MAPID Data Catalogue - PERDAGANGAN DAN RETAIL, KANTOR, HALTE, STASIUN",
          year: 2025, detail: "kepadatan komersial/bisnis - dibaca langsung dari kategori MAPID sendiri, tidak lewat OSM sama sekali untuk indikator ini",
        },
        {
          source: "Cache statis per moda (backend/data/k-uc1/)", detail:
            "Hasil precompute station_indicators() per stasiun (lihat generate_kuc1_static.py) - dipakai dulu kalau ada, live cuma buat stasiun yang belum kecover cache. Tanggal generate tiap moda ditampilkan di panel \"Sumber & metode data\" di hasil analisis.",
        },
      ],
      processing: [
        { step: "Station Composite Index (SCI)", detail: "8 kriteria/18 indikator, Siburian et al. 2020 Table 1 - skor kriteria dijumlah berbobot lalu dibagi total bobot" },
        { step: "Sumber tiap indikator", detail: "OSM/MAPID kalau bisa diukur langsung; PROXY (kepadatan aktivitas dari MAPID/OSM) buat data penumpang yang gak ada feed gratisnya; CONSTANT buat frekuensi perjalanan, keamanan, papan informasi, dan transportasi alternatif (semua stasiun dianggap sama, gak ada data terukur yang layak dipakai)" },
        { step: "Transparansi sumber", detail: "Tiap indikator ditandai OSM/MAPID/PROXY/CONSTANT - lihat badge di detail stasiun" },
        {
          step: "Kenapa TJ tidak masuk K-UC1", detail:
            "Beda dari indikator lain - ini scan SEMUA stasiun satu moda sekaligus. TJ punya ribuan halte, jauh lebih banyak drpd KRL/MRT/LRT gabungan, jadi dikeluarkan dari cakupan dashboard ini (tetap bisa dipilih di use case lain). Satu stasiun diproses sekaligus (semaphore) biar gak kena rate-limit/blocklist Overpass buat sisa moda yang di-scan.",
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
    description: "Risiko banjir per koridor (MAPID Data Catalogue, otomatis fallback ke BNPB InaRISK kalau MAPID sama sekali tidak punya zona banjir di buffer stasiun ini) plus konteks UHI/ekologi/curah hujan (MAPID).",
    expectedWait: 6,
    methodology: {
      data: [
        {
          source: "MAPID Data Catalogue - Wilayah Bahaya/Terancam Banjir", detail:
            "Kelas 5-tingkat (Sangat Rendah..Tinggi) per zona, utama - dipakai kalau minimal satu koridor di buffer stasiun ini tercakup zona MAPID.",
        },
        {
          source: "BNPB InaRISK (gis.bnpb.go.id)", detail:
            "Indeks bahaya banjir & longsor (0-1, diklasifikasi rendah/sedang/tinggi), raster resmi pemerintah, live. Dipakai untuk SELURUH buffer stasiun ini kalau MAPID sama sekali gak punya zona banjir yang menyentuh buffer ini. MAPID gak punya data longsor sama sekali.",
        },
        { source: "MAPID Data Catalogue - URBAN HEAT ISLAND", year: 2022, detail: "Kelas zona panas per kabupaten/kota - tidak ada fallback" },
        { source: "MAPID Data Catalogue - INDEKS EKOLOGI", year: 2024, detail: "Indeks per grid (turunan RSEI) - tidak ada fallback" },
        { source: "MAPID Data Catalogue - Curah Hujan (Presipitasi)", year: 2020, detail: "Kelas & intensitas per provinsi - tidak ada fallback" },
        { source: "OSM - jaringan jalan (koridor & rute detour)", detail: "MAPID gak punya jaringan jalan. Live Overpass dulu, fallback ke cache statis (backend/data/static/) cuma kalau live gagal." },
        { source: "OSM - daftar stasiun MRT/KRL/LRT (dropdown)", detail: "Daftar terkurasi manual (output/isochrone_*.py) - live Overpass cuma dipanggil kalau file ini hilang. TJ dari GTFS lokal, selalu instan." },
      ],
      processing: [
        {
          step: "Banjir - MAPID (utama)", detail:
            "Point-in-polygon langsung ke zona MAPID yang sudah didownload, per koridor - instan, tidak ada panggilan live sama sekali. Kelas 5-tingkat MAPID sendiri. Dipakai selama ada minimal satu koridor di buffer ini yang tercakup zona MAPID.",
        },
        {
          step: "Banjir & longsor - fallback InaRISK", detail:
            "Kalau MAPID sama sekali tidak punya zona banjir yang menyentuh buffer stasiun ini, otomatis pindah ke BNPB InaRISK \"identify\" raster call per titik untuk SELURUH buffer itu - disampel di grid heksagon ~120m (bukan satu panggilan per koridor, biar gak >10 menit), tiap koridor pakai nilai sampel terdekatnya. Klasifikasi 3-tingkat resmi InaRISK (rendah/sedang/tinggi), beda skema dari kelas 5-tingkat MAPID. Longsor cuma pernah terisi lewat jalur fallback ini - Jabodetabek risikonya kecil di luar perbukitan Bogor, tapi datanya tetap ditampilkan apa adanya kalau fallback ini aktif.",
        },
        {
          step: "Rute aman (detour)", detail:
            "Hard avoidance seperti wheelchair=no di M-UC1: ruas yang diklasifikasikan \"Tinggi\"/\"Cukup Tinggi\" (MAPID) atau \"tinggi\" (InaRISK banjir/longsor) dipenalti berat di routing, bukan skor gabungan",
        },
        { step: "UHI/Ekologi/Curah hujan", detail: "Ditampilkan apa adanya dari MAPID Data Catalogue, tanpa dihitung ulang" },
        { step: "Tidak ada skor gabungan", detail: "Versi lama nge-blend proxy tutupan hijau (panas) + jarak sungai (banjir) jadi \"vulnerability\" 0.5/0.5 - keduanya proxy buatan sendiri. Sudah dihapus." },
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
    },
    popup: [corridorHazardField, uhiField, ecologyIndexField, rainfallField, floodRiskMapidField],
  },
]
