import { api } from "./api"
import { CLASS_COLORS } from "./tod"
import { CATEGORIES, CATEGORY_COLORS, CATEGORY_LABELS } from "./equity"

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
    description: "Access by Walking (Siburian et al. 2020) per grid 250m dan isochrone jalan kaki dari stasiun.",
    expectedWait: "Statis: 3-6 detik (jalan/isochrone/hunian/hijau/pohon/komersial semua dari cache) - cuma PM2.5 yang tetap live. Live: ~10-25 detik (perkiraan, bukan hasil benchmark - 4 panggilan Overpass sekuensial: jalan, POI, pohon, daftar stasiun rel buat deteksi titik transfer; yang terakhir query se-Jabodetabek tapi di-cache ke disk, jadi cuma berat di panggilan live pertama sesi backend ini, abis itu instan). Query pertama ke moda tertentu (MRT/KRL/LRT/TJ) di mode Statis sesi ini agak lebih lambat sekali (baca+parse file moda itu doang, bukan borong ke-4 moda), query berikutnya instan dari RAM. Query identik (stasiun+radius+mode sama) diulang dalam 5 menit juga instan (result cache).",
    extras: "walk",
    methodology: {
      data: [
        { source: "OSM - jaringan jalan & isochrone", detail: "STATIS, di-download sekali via Overpass lalu disimpan geojson (backend/data/static/) - MRT/KRL: 18 Agu 2026, LRT & TJ: 19 Agu 2026. Kalau stasiun belum ke-cover static (radius beda dari cache), fallback live Overpass." },
        { source: "OSM - POI hunian & pohon/ruang hijau", detail: "STATIS (output/poi_residential_*.py, poi_green_*.py - 19-20 Agu 2026), dipakai buat residential_mix, canopy, dan ecology_poi. Fallback live osm.pois()/osm.trees() kalau mode/radius belum ke-cover." },
        { source: "MAPID Data Catalogue - POI komersial (PERDAGANGAN DAN RETAIL, buat residential_mix)", detail: "STATIS di mode Statis (mapid_data.retail(), satu file Jabodetabek jadi gak ada gap radius/mode seperti file OSM static lainnya). Mode Live pakai osm.is_commercial dari osm.pois() sebagai gantinya." },
        { source: "OSM - daftar stasiun MRT/KRL/LRT (dropdown pemilih)", detail: "Statis dari cache (output/isochrone_*.py, 18-19 Agu 2026), fallback live Overpass kalau belum ke-cover. TJ dari GTFS lokal, selalu instan." },
        { source: "TransJakarta GTFS", year: 2026, detail: "frequencies.txt (headway asli per trip), stops.txt - file lokal, bukan live" },
        { source: "OpenAQ v3", detail: "PM2.5 real-time dari stasiun pemantau terdekat (perlu API key - kosong kalau belum dikonfigurasi)" },
        { source: "MAPID Data Catalogue - URBAN HEAT ISLAND", year: 2022, detail: "kelas zona panas per kabupaten/kota" },
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
        { step: "UHI / Indeks ekologi / Curah hujan", detail: "Ditampilkan apa adanya dari MAPID Data Catalogue, tanpa dihitung ulang atau digabung jadi skor" },
      ],
    },
    options: {
      radius: [400, 800],
      dataSource: [
        {
          value: "static", label: "Statis (cepat)",
          note: "Jaringan jalan & isochrone dari cache statis OSM (MRT/KRL 18 Agu 2026, LRT & TJ 19 Agu 2026). POI hunian & pohon/ruang hijau juga dari cache statis (poi_residential_*.py/poi_green_*.py). POI komersial (buat residential_mix) dari MAPID Data Catalogue - statis, gak ada gap radius/mode. Dropdown stasiun statis juga. Tetap live: PM2.5 (OpenAQ v3 real-time). UHI/Ekologi/Curah hujan dari MAPID, statis, di luar toggle ini.",
        },
        {
          value: "live", label: "Live OSM murni (lambat)",
          note: "Jaringan jalan, isochrone, POI hunian, pohon/ruang hijau, & POI komersial (jadi osm.is_commercial, ganti MAPID) semua dipaksa fetch OSM Overpass tiap run, cache statis & MAPID diabaikan sepenuhnya. PM2.5 tetap live sama seperti mode Statis; dropdown stasiun tetap pakai cache statis (gak dipengaruhi toggle ini). Paling lambat dari 2 pilihan - kalau Overpass gagal/timeout, pindah ke mode Statis.",
        },
      ],
    },
    run: (station, opts) => api.walkAccess(station.id, opts.radius || 800, opts.dataSource || "static"),
    layers: [
      // Four overlays (isochrone outline, transfer POI, green POI, road skeleton) aren't
      // mode-gated - each has its own "toggle" key instead, so all four can stay visible
      // together regardless of which "Tampilan peta" topic pill is picked. Ringkasan/
      // Transfer/Hijau all expose the same 5 checkboxes (isochrone/poi_transfer/poi_hijau/
      // jalan/heatmap) for this reason - one consistent overlay set, not per-tab
      // differences. The per-topic choropleth (grid/air_quality_grid/green_grid/uhi/
      // ecology_index/rainfall) stays mode-gated - only one shows at a time, following
      // the topic pill - but all share the "heatmap" toggle so that one (whichever is
      // currently active) can be hidden without switching topic. accessibility_roads used
      // to be one of these (gated to "aksesibilitas") - it's "jalan" now instead, merged
      // into the base map so the road skeleton shows under the walk-score heatmap too, not
      // only when that one topic is picked.
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
        source: "transfer_points", type: "circle", toggle: "poi_transfer",
        paint: {
          "circle-radius": 6,
          "circle-color": ["case", ["get", "is_proxy"], "#9ca3af", "#22c55e"],
          "circle-stroke-width": 2,
          "circle-stroke-color": ["case", ["get", "is_proxy"], "#6b7280", "#166534"],
          "circle-opacity": 0.9,
        },
      },
      {
        // Individual markers (trees excluded - too dense to click one by one, they only
        // feed green_grid's count below) - click targets for GreenSearch's "Rute"/focus
        // buttons.
        source: "ecology_poi", type: "circle", toggle: "poi_hijau",
        paint: { "circle-radius": 5, "circle-color": "#22c55e", "circle-stroke-width": 1, "circle-stroke-color": "#fff" },
      },
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
        // Raw wheelchair tag per road segment - no invented weighting, just the OSM fact.
        // Not mode-gated (unlike before) - merged into the base map via its own "jalan"
        // toggle, so the road skeleton shows together with the walk-score heatmap (or any
        // other topic) instead of only appearing under the separate "Aksesibilitas" pick.
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
      {
        // MAPID Data Catalogue, published as-is - one zone per kabupaten/kota (coarse).
        source: "uhi", type: "fill", mode: "uhi", toggle: "heatmap",
        paint: {
          "fill-opacity": 0.5,
          "fill-color": ["match", ["get", "CLASS"],
            "HOT ZONE", "#ef4444", "VERY WARM ZONE", "#f97316", "NORMAL ZONE", "#22c55e", "#9ca3af"],
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
    ],
    legends: {
      isochrone: {
        title: "Access by Walking per grid 250m (Siburian et al. 2020)",
        stops: SCORE_STOPS,
      },
      udara: {
        title: "PM2.5 (µg/m³) - interpolasi dari stasiun OpenAQ terdekat",
        stops: [["baik (≤12)", "#22c55e"], ["sedang (≤35)", "#f59e0b"], ["tidak sehat (≤150)", "#ef4444"], ["berbahaya (>150)", "#7f1d1d"]],
        note: "Diinterpolasi (inverse-distance) dari stasiun OpenAQ nyata di sekitar - bukan pengukuran per titik, stasiun aslinya jarang (bisa berjarak beberapa km).",
      },
      vegetasi: {
        title: "Kepadatan hijau per grid 250m (pohon + taman/RTH)",
        stops: [[0, "#f0fdf4"], [3, "#bbf7d0"], [8, "#4ade80"], [15, "#16a34a"], ["25+", "#14532d"]],
        note: "Jumlah titik pohon + taman/RTH (tag OSM) per sel 250m, grid choropleth sama seperti Access by Walking - bukan blur heatmap, bukan indeks vegetasi tervalidasi (NDVI dsb).",
      },
      uhi: {
        title: "Urban Heat Island (MAPID, 2022)",
        stops: [["zona normal", "#22c55e"], ["zona hangat", "#f97316"], ["zona panas", "#ef4444"]],
        note: "Data MAPID Data Catalogue per kabupaten/kota - satu zona besar, jadi biasanya tampil rata dalam radius 500m stasiun (memang resolusi aslinya sekasar itu).",
      },
      ekologi_index: {
        title: "Indeks Ekologi per grid (MAPID, 2024)",
        stops: [["buruk (0)", "#ef4444"], ["sedang (0.3)", "#f59e0b"], ["cukup (0.6)", "#a3e635"], ["baik (1)", "#15803d"]],
        note: "Nilai INDEKS asli dari MAPID Data Catalogue, ditampilkan apa adanya.",
      },
      hujan: {
        title: "Curah Hujan (MAPID, 2020)",
        stops: [["normal", "#eff3ff"], ["deras", "#6baed6"], ["sangat deras", "#08306b"]],
        note: "Data MAPID Data Catalogue per provinsi - zona besar, biasanya rata dalam radius 500m stasiun.",
      },
    },
    popup: ["access_by_walking", "road_network", "intersection", "ped_shed", "residential_mix",
      "name", "mode", "distance_m", "headway_min_peak", "is_proxy",
      "preference", "length_m", "minutes", "blocked_segments_crossed",
      "pm25", "category", "station", "wheelchair", "sidewalk", "highway", "kind", "leisure", "landuse", "green_count",
      "KELAS", "CLASS", "TEMPERATUR", "INDEKS", "STATUS", "Kelas", "Rata-rata Intensitas (mm/hari)"],
  },
  {
    id: "M-UC2",
    persona: "komuter",
    title: "Basic Needs untuk Komuter",
    description: "Ketersediaan pangan, pusat perbelanjaan/pasar, keuangan, retail, dan kesehatan dalam jangkauan jalan kaki dari stasiun (MAPID Data Catalogue).",
    expectedWait: "Statis: 5-15 detik (POI MAPID, jalan & dropdown stasiun dari cache). Live: ~5-12 detik (perkiraan - 2 panggilan Overpass sekuensial: jalan + POI, hasilnya jauh lebih sedikit POI drpd MAPID krn tagging basic-need OSM di Indonesia jarang). Query pertama ke satu kategori POI MAPID (APOTEK/BANK/dst) di mode Statis sesi ini agak lebih lambat sekali (baca+parse file kategori itu doang, bukan borong 12 kategori), kategori yang udah kepakai jadi instan buat query berikutnya.",
    extras: "equity",
    methodology: {
      data: [
        {
          source: "MAPID Data Catalogue - APOTEK, KLINIK, PUSKESMAS, RUMAH SAKIT, MAKANAN DAN MINUMAN, PUSAT PERBELANJAAN, PASAR, PASAR MODERN, BANK, ATM, PERDAGANGAN DAN RETAIL",
          year: 2025, detail: "per kabupaten/kota Jabodetabek - file statis dari MAPID, bukan live",
        },
        { source: "OSM - jaringan jalan (isochrone & rute)", detail: "STATIS (backend/data/static/) - MRT/KRL: 18 Agu 2026, LRT: 19 Agu 2026, TJ: 19 Agu 2026. Fallback live Overpass kalau radius/stasiun belum ke-cover." },
        { source: "OSM - daftar stasiun MRT/KRL/LRT (dropdown)", detail: "Statis dari cache, fallback live kalau belum ke-cover. TJ dari GTFS lokal, instan." },
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
      dataSource: [
        {
          value: "static", label: "Statis (cepat)",
          note: "POI basic-need dari MAPID Data Catalogue (2025, statis). Jaringan jalan/isochrone dari cache statis OSM (MRT/KRL 18 Agu 2026, LRT & TJ 19 Agu 2026). Dropdown stasiun tetap live (OSM Overpass).",
        },
        {
          value: "live", label: "Live OSM murni (lambat, tanpa POI MAPID)",
          note: "POI basic-need dari tag OSM (amenity=pharmacy/bank/marketplace dkk, live Overpass, lihat osm_poi.py) - HASILNYA JAUH LEBIH SEDIKIT drpd MAPID, tagging OSM di Indonesia jarang. Jaringan jalan/isochrone juga dipaksa live. Kalau Overpass gagal/timeout, pindah ke mode Statis.",
        },
      ],
    },
    run: (station, opts) => api.amenityEquity(station.id, opts.radius || 800, opts.dataSource || "static"),
    // "mode" layers only render when App's map-mode toggle matches; layers without a
    // mode (POI dots, route, isochrone outline) always render regardless of which mode
    // is active - the outline in particular needs to stay visible in heatmap modes too,
    // so the coverage flag (green/red) doesn't disappear just because the fill is hidden.
    layers: [
      { source: "isochrone", type: "fill", mode: "isochrone", paint: { "fill-color": "#5b4bdb", "fill-opacity": 0.12 } },
      {
        source: "isochrone", type: "line",
        paint: {
          "line-color": ["case", ["get", "complete"], "#22c55e", "#ef4444"],
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
    description: "Pilih tipe bisnis, lihat kompetitor setipe (MAPID Data Catalogue) dan anchor demand di sekitar stasiun - layer terpisah, tanpa skor gabungan.",
    expectedWait: "Statis: 5-15 detik (MAPID statis, dropdown stasiun statis, jaringan jalan/POI hunian/komersial buat walk_score juga statis - radius default sekarang ikut mode stasiun: 800m MRT/KRL/LRT, 400m TJ, pas sama cakupan cache). Live: ~10-20 detik (perkiraan - jalan + POI kantor/kebutuhan-dasar (2x panggilan terpisah) + daftar stasiun rel sekuensial; daftar stasiun di-cache abis panggilan live pertama sesi ini). Query pertama ke moda/kategori bisnis tertentu di mode Statis sesi ini agak lebih lambat sekali (load per moda/kategori, bukan borong semua), setelahnya instan.",
    extras: "site",
    methodology: {
      data: [
        {
          source: "MAPID Data Catalogue - kompetitor (tipe bisnis dipilih user)",
          year: 2025, detail: "Contoh: pilih \"MAKANAN DAN MINUMAN\" -> 222 kompetitor asli ketemu di radius 1km Dukuh Atas. File statis, bukan live.",
        },
        {
          source: "MAPID Data Catalogue - KANTOR, APOTEK/KLINIK/PUSKESMAS/RUMAH SAKIT/BANK/ATM/PASAR/dst, HALTE/STASIUN",
          year: 2025, detail: "Anchor: pekerja kantoran, kebutuhan sehari-hari, penumpang transit. File statis, bukan live.",
        },
        {
          source: "OSM - jaringan jalan & POI hunian (walk_score)", detail:
            "Radius default use case ini sekarang ikut mode stasiun (800m MRT/KRL/LRT, 400m TJ) - pas sama cakupan cache statis-nya, jadi di mode Statis ini kepakai statis, bukan selalu fallback live. Radius custom lewat API tetap bisa fallback live kalau > cakupan cache.",
        },
        {
          source: "MAPID Data Catalogue - POI komersial (buat walk_score)", detail:
            "MAPID satu file Jabodetabek, gak ada gap radius kayak file OSM static - selalu statis di mode Statis berapa pun radiusnya.",
        },
        { source: "OSM - daftar stasiun MRT/KRL/LRT (dropdown)", detail: "Statis dari cache, fallback live kalau belum ke-cover. TJ dari GTFS lokal, instan." },
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
      dataSource: [
        {
          value: "static", label: "Statis (cepat)",
          note: "Kompetitor & anchor (kantor/kebutuhan dasar) dari MAPID Data Catalogue (2025, statis). Anchor transit dari cache statis + GTFS, dropdown stasiun juga statis. Jaringan jalan & POI hunian (walk_score) dari cache statis juga - radius default sekarang ikut mode stasiun (800m MRT/KRL/LRT, 400m TJ), pas sama cakupan cache. POI komersial (walk_score) dari MAPID, statis di radius berapa pun.",
        },
        {
          value: "live", label: "Live OSM murni (lambat, tanpa MAPID)",
          note: "Kompetitor & anchor kantor/kebutuhan dasar dari tag OSM (live Overpass, osm_poi.py) - sub-tipe MAPID (TIPE_2) diabaikan, dan hasilnya JAUH LEBIH SEDIKIT drpd MAPID. Jaringan jalan juga dipaksa live. Kalau Overpass gagal/timeout, pindah ke mode Statis.",
        },
      ],
    },
    run: (station, opts) => api.siteSelection(station.id, opts.businessType || "APOTEK", opts.subtype, opts.subtype2, opts.dataSource || "static"),
    layers: [
      { source: "grid", type: "fill", mode: "walk_score", paint: { "fill-color": ramp("walk_score", SCORE_STOPS), "fill-opacity": 0.7 } },
      {
        source: "grid", type: "fill", mode: "kompetitor",
        paint: { "fill-color": ramp("competitor_count", [[0, "#f7f7f7"], [1, "#e9d5ff"], [2, "#c084fc"], [4, "#9333ea"], [6, "#581c87"]]), "fill-opacity": 0.7 },
      },
      {
        source: "grid", type: "fill", mode: "anchor",
        paint: {
          "fill-opacity": 0.7,
          "fill-color": [
            "interpolate", ["linear"],
            ["+", ["get", "anchor_kantor"], ["get", "anchor_kebutuhan_dasar"], ["get", "anchor_transit"]],
            0, "#f7f7f7", 3, "#bbf7d0", 8, "#4ade80", 15, "#16a34a", 25, "#14532d",
          ],
        },
      },
      { source: "catchment", type: "line", paint: { "line-color": "#7c3aed", "line-width": 1 } },
      {
        source: "anchors", type: "circle",
        paint: {
          "circle-radius": 4,
          "circle-color": ["match", ["get", "anchor_type"],
            "kantor", "#4a90e2", "kebutuhan_dasar", "#22c55e", "transit", "#f59e0b", "#9ca3af"],
          "circle-opacity": 0.6,
        },
      },
      // One business type per query, so every competitor dot is the same solid color -
      // no rainbow mixing, gampang dibedain dari anchor.
      { source: "competitors", type: "circle", paint: { "circle-radius": 6, "circle-color": "#7c3aed", "circle-stroke-width": 1.5, "circle-stroke-color": "#fff" } },
    ],
    legends: {
      walk_score: { title: "Walk score (Siburian et al. 2020)", stops: SCORE_STOPS },
      kompetitor: {
        title: "Jumlah kompetitor per grid",
        stops: [[0, "#f7f7f7"], [1, "#e9d5ff"], [2, "#c084fc"], [4, "#9333ea"], ["6+", "#581c87"]],
        note: "Titik ungu di peta = kompetitor tipe bisnis yang dipilih (MAPID Data Catalogue). Hitungan mentah, bukan skor.",
      },
      anchor: {
        title: "Anchor MAPID per grid (kantor+kebutuhan dasar+transit)",
        stops: [[0, "#f7f7f7"], [3, "#bbf7d0"], [8, "#4ade80"], [15, "#16a34a"], ["25+", "#14532d"]],
        note: "Titik kecil: biru = kantor, hijau = kebutuhan dasar, oranye = transit.",
      },
    },
    popup: ["walk_score", "competitor_count", "anchor_kantor", "anchor_kebutuhan_dasar", "anchor_transit",
      "name", "anchor_type", "category", "business_type", "subtype", "subtype2", "alamat"],
  },
  {
    id: "K-UC1",
    persona: "kebijakan",
    title: "Indeks TOD & Prioritas Pengembangan",
    description: "Station Composite Index, ranking stasiun, dan tipologi rekomendasi pengembangan.",
    expectedWait: "10-30 detik - jaringan jalan/POI hunian-hijau-parkir per stasiun sekarang statis, tapi POI komersial (safety/keamanan/transfer) tetap live dikali semua stasiun yang di-scan. Scan pertama satu moda (MRT/KRL/LRT/TJ) sesi ini kena load sekali per moda itu (bukan borong ke-4 moda), scan ulang moda yang sama abis itu instan dari RAM.",
    // Scores every station at once, so App drives it through the dashboard instead of `run`.
    dashboard: true,
    methodology: {
      data: [
        { source: "OSM - daftar stasiun/halte yang di-scan", detail: "Statis dari cache (18-19 Agu 2026), fallback live kalau cache belum ada" },
        { source: "OSM - jaringan jalan per stasiun", detail: "STATIS kalau stasiunnya MRT/KRL/LRT/TJ (backend/data/static/, 18-19 Agu 2026), fallback live Overpass kalau belum ke-cover" },
        {
          source: "OSM - POI hunian, ruang hijau, parkir per stasiun", detail:
            "STATIS (output/poi_residential_*.py, poi_green_*.py, poi_parking_*.py - 19-20 Agu 2026), dipakai buat population_density, land_use_diversity (bagian residential/green), car_parking, motorcycle_parking. Fallback live kalau mode/radius belum ke-cover.",
        },
        {
          source: "OSM - POI lain (proxy keamanan/informasi/transit/bangunan)", detail:
            "LIVE tiap stasiun di-scan (osm.pois()) - safety, information_display, alt_transport, accessible_buildings, land_use_diversity (bagian residential_diversity/non-residential) belum ada static cache-nya.",
        },
        {
          source: "MAPID Data Catalogue - PERDAGANGAN DAN RETAIL, KANTOR, HALTE, STASIUN",
          year: 2025, detail: "kepadatan komersial/bisnis, transportasi alternatif",
        },
      ],
      processing: [
        { step: "Station Composite Index (SCI)", detail: "8 kriteria/18 indikator, Siburian et al. 2020 Table 1 - skor kriteria dijumlah berbobot lalu dibagi total bobot" },
        { step: "Sumber tiap indikator", detail: "OSM/MAPID kalau bisa diukur langsung; PROXY (kepadatan aktivitas dari MAPID/OSM) buat data penumpang & keamanan yang gak ada feed gratisnya; CONSTANT buat frekuensi perjalanan (paper menilai semua stasiun sama, 1 jalur MRT)" },
        { step: "Transparansi sumber", detail: "Tiap indikator ditandai OSM/MAPID/MIXED/PROXY/CONSTANT - lihat badge di detail stasiun" },
        {
          step: "Tidak ada pilihan \"Live OSM murni\"", detail:
            "Beda dari use case lain - ini scan SEMUA stasiun satu moda sekaligus (bisa ribuan halte buat TJ). Dipaksa live per stasiun x sebanyak itu = Overpass ke-rate-limit/blocklist, bukan cuma lambat. Jaringan jalan/daftar stasiun/POI hunian-hijau-parkir tetap statis-first (fallback live cuma kalau cache belum ada per stasiun), POI keamanan/informasi/transit tetap live seperti biasa.",
        },
      ],
    },
    options: {
      modes: ["rail", "rail,bus"],
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
    description: "Risiko banjir per koridor (MAPID statis, atau BNPB InaRISK live) plus konteks UHI/ekologi/curah hujan (MAPID) - layer terpisah, tanpa skor gabungan.",
    expectedWait: "Statis: 3-6 detik. Live: ~20-35 detik (perkiraan - jalan+POI dulu (2 panggilan Overpass), lalu InaRISK ~4-5 detik/panggilan disampel grid heksagon per buffer, puluhan panggilan tapi jalan 8 sekaligus/concurrent, bukan satu-satu - kalau BNPB down, otomatis balik ke mode Statis). Query pertama ke moda tertentu di mode Statis sesi ini agak lebih lambat sekali (load jaringan jalan moda itu doang), berikutnya instan - buka tab Detour abis Resilience juga instan (reuse graph yang sama, gak dihitung ulang).",
    methodology: {
      data: [
        {
          source: "MAPID Data Catalogue - Wilayah Bahaya/Terancam Banjir", detail:
            "Kelas 5-tingkat (Sangat Rendah..Tinggi) per zona, statis, di-download - dipakai di mode Statis.",
        },
        {
          source: "BNPB InaRISK (gis.bnpb.go.id)", detail:
            "Indeks bahaya banjir & longsor (0-1, diklasifikasi rendah/sedang/tinggi), raster resmi pemerintah, live - dipakai di mode Live sebagai pengganti MAPID buat banjir, dan satu-satunya sumber longsor (MAPID gak punya).",
        },
        { source: "MAPID Data Catalogue - URBAN HEAT ISLAND", year: 2022, detail: "kelas zona panas per kabupaten/kota - selalu statis, gak ada versi live" },
        { source: "MAPID Data Catalogue - INDEKS EKOLOGI", year: 2024, detail: "indeks per grid (turunan RSEI) - selalu statis" },
        { source: "MAPID Data Catalogue - Curah Hujan (Presipitasi)", year: 2020, detail: "kelas & intensitas per provinsi - selalu statis" },
        { source: "OSM - jaringan jalan (koridor & rute detour)", detail: "STATIS (backend/data/static/, 18-19 Agu 2026) di mode Statis, live Overpass di mode Live" },
        { source: "OSM - daftar stasiun MRT/KRL/LRT (dropdown)", detail: "Statis dari cache (output/isochrone_*.py, 18-19 Agu 2026), fallback live Overpass kalau belum ke-cover. TJ dari GTFS lokal, selalu instan." },
      ],
      processing: [
        {
          step: "Banjir - mode Statis", detail:
            "Point-in-polygon langsung ke zona MAPID yang sudah didownload, per koridor - instan, tidak ada panggilan live sama sekali. Kelas 5-tingkat MAPID sendiri.",
        },
        {
          step: "Banjir & longsor - mode Live", detail:
            "BNPB InaRISK \"identify\" raster call per titik - disampel di grid heksagon ~120m dalam buffer (bukan satu panggilan per koridor, biar gak >10 menit), tiap koridor pakai nilai sampel terdekatnya. Klasifikasi 3-tingkat resmi InaRISK (rendah/sedang/tinggi). Longsor cuma ada di mode ini - Jabodetabek risikonya kecil di luar perbukitan Bogor, tapi datanya tetap ditampilkan apa adanya kalau user pilih Live.",
        },
        {
          step: "Rute aman (detour)", detail:
            "Hard avoidance seperti wheelchair=no di M-UC1: ruas yang diklasifikasikan \"Tinggi\"/\"Cukup Tinggi\" (MAPID) atau \"tinggi\" (InaRISK banjir/longsor) dipenalti berat di routing, bukan skor gabungan",
        },
        { step: "UHI/Ekologi/Curah hujan", detail: "Ditampilkan apa adanya dari MAPID Data Catalogue, tanpa dihitung ulang - sama di kedua mode, gak ada live equivalent buat ini" },
        { step: "Tidak ada skor gabungan", detail: "Versi lama nge-blend proxy tutupan hijau (panas) + jarak sungai (banjir) jadi \"vulnerability\" 0.5/0.5 - keduanya proxy buatan sendiri. Sudah dihapus." },
      ],
    },
    extras: "resilience",
    options: {
      dataSource: [
        {
          value: "static", label: "Statis (cepat)",
          note: "Banjir dari MAPID Data Catalogue (5-tingkat, statis). Longsor tidak dihitung (MAPID gak punya data itu). UHI/Ekologi/Curah hujan selalu MAPID statis. Jaringan jalan (koridor & rute detour) dari cache statis kalau ke-cover. Dropdown stasiun statis dari cache juga.",
        },
        {
          value: "live", label: "Live BNPB InaRISK + OSM (lambat)",
          note: "Banjir DAN longsor dari BNPB InaRISK (live, disampel grid heksagon per buffer - tetap puluhan panggilan ~4-5 detik/panggilan ke server pemerintah, bisa down). Jaringan jalan dipaksa live Overpass. UHI/Ekologi/Curah hujan tetap MAPID statis (gak ada live equivalent - data publikasi periodik, bukan real-time feed). Kalau InaRISK/Overpass gagal, pindah ke mode Statis.",
        },
      ],
    },
    run: (station, opts) => api.resilience(station.id, opts.dataSource || "static"),
    layers: [
      {
        // Static mode fills "banjir_kelas" (MAPID's 5-level Kelas), live mode fills
        // "banjir_class" (BNPB InaRISK's 3-level rendah/sedang/tinggi) instead - coalesce
        // reads whichever one this run actually populated (see analysis.py's resilience()).
        source: "corridors", type: "fill", mode: "banjir",
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
        source: "corridors", type: "fill", mode: "longsor",
        paint: {
          "fill-opacity": 0.65,
          "fill-color": ["match", ["get", "longsor_class"],
            "rendah", "#22c55e", "sedang", "#f59e0b", "tinggi", "#ef4444", "#e5e7eb"],
        },
      },
      {
        source: "uhi", type: "fill", mode: "uhi",
        paint: {
          "fill-opacity": 0.5,
          "fill-color": ["match", ["get", "CLASS"],
            "HOT ZONE", "#ef4444", "VERY WARM ZONE", "#f97316", "NORMAL ZONE", "#22c55e", "#9ca3af"],
        },
      },
      {
        source: "ecology_index", type: "fill", mode: "ekologi_index",
        paint: { "fill-opacity": 0.65, "fill-color": ramp("INDEKS", [[0, "#ef4444"], [0.3, "#f59e0b"], [0.6, "#a3e635"], [1, "#15803d"]]) },
      },
      {
        source: "rainfall", type: "fill", mode: "hujan",
        paint: {
          "fill-opacity": 0.5,
          "fill-color": ["match", ["get", "Kelas"],
            "Hujan normal", "#eff3ff", "Hujan deras", "#6baed6", "Hujan sangat deras", "#08306b", "#9ca3af"],
        },
      },
      {
        source: "flood_risk_mapid", type: "fill", mode: "banjir_mapid",
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
        note: "Mode Statis: klasifikasi MAPID (5-tingkat Sangat Rendah..Tinggi). Mode Live: klasifikasi resmi BNPB InaRISK (3-tingkat rendah/sedang/tinggi). Dua skema beda sumber, warnanya disamakan di sini tapi angkanya tidak dibandingkan 1:1. Abu-abu = di luar cakupan data.",
      },
      longsor: {
        title: "Indeks bahaya longsor per koridor (BNPB InaRISK)",
        stops: [["rendah", "#22c55e"], ["sedang", "#f59e0b"], ["tinggi", "#ef4444"], ["tidak ada data", "#e5e7eb"]],
        note: "Cuma ada di mode Live (InaRISK) - MAPID gak punya data longsor. Abu-abu di mode Statis = memang gak dihitung, bukan \"aman\".",
      },
      uhi: { title: "Urban Heat Island (MAPID, 2022)", stops: [["zona normal", "#22c55e"], ["zona hangat", "#f97316"], ["zona panas", "#ef4444"]] },
      ekologi_index: { title: "Indeks Ekologi per grid (MAPID, 2024)", stops: [["buruk (0)", "#ef4444"], ["sedang (0.3)", "#f59e0b"], ["cukup (0.6)", "#a3e635"], ["baik (1)", "#15803d"]] },
      hujan: { title: "Curah Hujan (MAPID, 2020)", stops: [["normal", "#eff3ff"], ["deras", "#6baed6"], ["sangat deras", "#08306b"]] },
      banjir_mapid: {
        title: "Wilayah Bahaya/Terancam Banjir (MAPID)",
        stops: [["sangat rendah", "#22c55e"], ["cukup rendah", "#84cc16"], ["sedang", "#f59e0b"], ["cukup tinggi", "#f97316"], ["tinggi", "#ef4444"]],
        note: "Sumber & skema klasifikasi beda dari InaRISK - dua data pemerintah/MAPID berdiri sendiri-sendiri, tidak direkonsiliasi jadi satu angka.",
      },
    },
    popup: ["highway", "banjir_kelas", "banjir_value", "banjir_class", "longsor_value", "longsor_class",
      "KELAS", "CLASS", "TEMPERATUR", "INDEKS", "STATUS", "Kelas", "Rata-rata Intensitas (mm/hari)"],
  },
]
