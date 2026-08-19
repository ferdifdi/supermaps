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
    description: "Skor akses jalan kaki per grid 250 m dan isochrone jalan kaki dari stasiun.",
    expectedWait: "10-20 detik (OSM + GTFS + OpenAQ)",
    extras: "walk",
    methodology: {
      data: [
        { source: "OSM (Overpass API)", detail: "Jaringan jalan, POI, halte/stasiun, pohon - live, di-cache lokal" },
        { source: "TransJakarta GTFS", year: 2026, detail: "frequencies.txt (headway asli per trip), stops.txt" },
        { source: "OpenAQ v3", detail: "PM2.5 real-time dari stasiun pemantau terdekat (perlu API key - kosong kalau belum dikonfigurasi)" },
        { source: "MAPID Data Catalogue - URBAN HEAT ISLAND", year: 2022, detail: "kelas zona panas per kabupaten/kota" },
        { source: "MAPID Data Catalogue - INDEKS EKOLOGI", year: 2024, detail: "indeks per grid" },
        { source: "MAPID Data Catalogue - Curah Hujan (Presipitasi)", year: 2020, detail: "kelas & intensitas per provinsi" },
      ],
      processing: [
        { step: "Skor akses jalan kaki", detail: "Weighted sum (Siburian et al. 2020): 40% jaringan jalan + 30% ped-shed + 20% persimpangan + 10% campuran hunian, per grid 250m" },
        { step: "Isochrone & rute", detail: "Dijkstra: \"tercepat\" (jarak murni) dan \"ramah kursi roda\" (jarak, ruas wheelchair=no dipenalti berat) - tidak ada formula kenyamanan racikan sendiri" },
        { step: "Transfer efisien", detail: "TransJakarta pakai headway asli dari GTFS; KRL/MRT/LRT/bus lain proxy jarak jalan kaki OSM (ditandai is_proxy di peta)" },
        { step: "Kualitas udara", detail: "Interpolasi IDW ke hex grid dari stasiun OpenAQ terdekat - layer konteks, tidak masuk skor manapun" },
        { step: "UHI / Indeks ekologi / Curah hujan", detail: "Ditampilkan apa adanya dari MAPID Data Catalogue, tanpa dihitung ulang atau digabung jadi skor" },
      ],
    },
    options: { radius: [400, 800] },
    run: (station, opts) => api.walkAccess(station.id, opts.radius || 800),
    layers: [
      // All walk-related layers are gated to mode "isochrone" so toggling to "udara"
      // shows air quality alone, not layered on top of the walk map.
      { source: "isochrone", type: "fill", mode: "isochrone", paint: { "fill-color": "#f59e0b", "fill-opacity": 0.15 } },
      { source: "isochrone", type: "line", mode: "isochrone", paint: { "line-color": "#f59e0b", "line-width": 2 } },
      { source: "grid", type: "fill", mode: "isochrone", paint: { "fill-color": ramp("walk_score", SCORE_STOPS), "fill-opacity": 0.7 } },
      {
        // TJ stops (real GTFS headway) vs KRL/MRT/LRT/other-bus points (OSM proxy,
        // distance only) - is_proxy drives a visibly different style so the map itself
        // signals which numbers are real, per the "harus dikasih tau kalau proxy" requirement.
        source: "transfer_points", type: "circle", mode: "isochrone",
        paint: {
          "circle-radius": 6,
          "circle-color": ["case", ["get", "is_proxy"], "#9ca3af", "#22c55e"],
          "circle-stroke-width": 2,
          "circle-stroke-color": ["case", ["get", "is_proxy"], "#6b7280", "#166534"],
          "circle-opacity": 0.9,
        },
      },
      { source: "route", type: "line", mode: "isochrone", paint: { "line-color": "#111827", "line-width": 4 } },
      {
        // Hex-grid choropleth, IDW-interpolated from real OpenAQ stations - a maplibre
        // "heatmap" layer blurs by screen-pixel radius (visibly shifts color on zoom),
        // this doesn't since it's a plain data-driven fill like uhi/ecology_index/rainfall.
        source: "air_quality_grid", type: "fill", mode: "udara",
        paint: {
          "fill-opacity": 0.65,
          "fill-color": ramp("pm25", [[0, "#22c55e"], [12, "#84cc16"], [35.4, "#f59e0b"], [55.4, "#f97316"], [150.4, "#ef4444"]]),
        },
      },
      {
        // Individual OSM street trees, blurred into a density heatmap - a proxy for
        // canopy/shade coverage, not a validated vegetation index.
        source: "canopy", type: "heatmap", mode: "vegetasi",
        paint: {
          "heatmap-radius": 25, "heatmap-opacity": 0.7,
          "heatmap-color": [
            "interpolate", ["linear"], ["heatmap-density"],
            0, "rgba(34,197,94,0)", 0.5, "#86efac", 1, "#15803d",
          ],
        },
      },
      {
        source: "ecology_poi", type: "circle", mode: "vegetasi",
        paint: { "circle-radius": 5, "circle-color": "#22c55e", "circle-stroke-width": 1, "circle-stroke-color": "#fff" },
      },
      {
        // Raw wheelchair tag per road segment - no invented weighting, just the OSM fact.
        source: "accessibility_roads", type: "line", mode: "aksesibilitas",
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
        source: "uhi", type: "fill", mode: "uhi",
        paint: {
          "fill-opacity": 0.5,
          "fill-color": ["match", ["get", "CLASS"],
            "HOT ZONE", "#ef4444", "VERY WARM ZONE", "#f97316", "NORMAL ZONE", "#22c55e", "#9ca3af"],
        },
      },
      {
        // MAPID Data Catalogue - INDEKS (0-1) per grid cell, published value, no rescoring.
        source: "ecology_index", type: "fill", mode: "ekologi_index",
        paint: {
          "fill-opacity": 0.65,
          "fill-color": ramp("INDEKS", [[0, "#ef4444"], [0.3, "#f59e0b"], [0.6, "#a3e635"], [1, "#15803d"]]),
        },
      },
      {
        // MAPID Data Catalogue - rainfall zone per province (coarse), published as-is.
        source: "rainfall", type: "fill", mode: "hujan",
        paint: {
          "fill-opacity": 0.5,
          "fill-color": ["match", ["get", "Kelas"],
            "Hujan normal", "#eff3ff", "Hujan deras", "#6baed6", "Hujan sangat deras", "#08306b", "#9ca3af"],
        },
      },
    ],
    legends: {
      isochrone: {
        title: "Skor akses jalan kaki",
        stops: SCORE_STOPS,
        note: "Titik transfer: hijau = headway asli (GTFS TransJakarta), abu-abu = proxy jarak jalan kaki (OSM, KRL/MRT/LRT/bus lain - belum ada data jadwal publik).",
      },
      udara: {
        title: "PM2.5 (µg/m³) - interpolasi dari stasiun OpenAQ terdekat",
        stops: [["baik (≤12)", "#22c55e"], ["sedang (≤35)", "#f59e0b"], ["tidak sehat (≤150)", "#ef4444"], ["berbahaya (>150)", "#7f1d1d"]],
        note: "Diinterpolasi (inverse-distance) dari stasiun OpenAQ nyata di sekitar - bukan pengukuran per titik, stasiun aslinya jarang (bisa berjarak beberapa km).",
      },
      vegetasi: {
        title: "Kanopi & ruang hijau (OSM)",
        stops: [["kepadatan pohon", "#22c55e"], ["taman/RTH", "#22c55e"]],
        note: "Titik pohon individual (density heatmap) + taman/RTH dari tag OSM. Bukan indeks vegetasi tervalidasi (NDVI dsb).",
      },
      aksesibilitas: {
        title: "Tag kursi roda per ruas jalan (OSM)",
        stops: [["ramah (yes)", "#22c55e"], ["terbatas (limited)", "#f59e0b"], ["tidak ramah (no)", "#ef4444"], ["tidak ditandai", "#9ca3af"]],
        note: "Tag wheelchair= mentah per ruas jalan, bukan skor gabungan.",
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
    popup: ["walk_score", "road_network", "ped_shed", "intersection", "residential_mix",
      "name", "mode", "distance_m", "headway_min_peak", "is_proxy",
      "preference", "length_m", "minutes", "blocked_segments_crossed",
      "pm25", "category", "station", "wheelchair", "sidewalk", "highway",
      "KELAS", "CLASS", "TEMPERATUR", "INDEKS", "STATUS", "Kelas", "Rata-rata Intensitas (mm/hari)"],
  },
  {
    id: "M-UC2",
    persona: "komuter",
    title: "Basic Needs untuk Komuter",
    description: "Ketersediaan pangan, pusat perbelanjaan/pasar, keuangan, retail, dan kesehatan dalam jangkauan jalan kaki dari stasiun (MAPID Data Catalogue).",
    expectedWait: "5-15 detik",
    extras: "equity",
    methodology: {
      data: [
        {
          source: "MAPID Data Catalogue - APOTEK, KLINIK, PUSKESMAS, RUMAH SAKIT, MAKANAN DAN MINUMAN, PUSAT PERBELANJAAN, PASAR, PASAR MODERN, BANK, ATM, PERDAGANGAN DAN RETAIL",
          year: 2025, detail: "per kabupaten/kota Jabodetabek",
        },
        { source: "OSM (Overpass API)", detail: "Jaringan jalan buat isochrone & rute jalan kaki" },
      ],
      processing: [
        { step: "Isochrone", detail: "Buffer jalan kaki dari stasiun, radius pilihan 400 atau 800m" },
        { step: "Overlay POI", detail: "Tiap POI basic-need dicek reachable/tidak dalam isochrone, per kategori" },
        { step: "Heatmap POI", detail: "Grid choropleth 250m: jumlah POI per sel" },
        { step: "Skor", detail: "Tidak ada equity_score komposit - cuma raw count/rasio per kategori (sengaja dihindari, gak ada dasar buat bobot antar kategori)" },
      ],
    },
    options: { radius: [400, 800] },
    run: (station, opts) => api.amenityEquity(station.id, opts.radius || 800),
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
    expectedWait: "5-15 detik",
    extras: "site",
    methodology: {
      data: [
        {
          source: "MAPID Data Catalogue - kompetitor (tipe bisnis dipilih user)",
          year: 2025, detail: "Contoh: pilih \"MAKANAN DAN MINUMAN\" -> 222 kompetitor asli ketemu di radius 1km Dukuh Atas.",
        },
        {
          source: "MAPID Data Catalogue - KANTOR, APOTEK/KLINIK/PUSKESMAS/RUMAH SAKIT/BANK/ATM/PASAR/dst, HALTE/STASIUN",
          year: 2025, detail: "Anchor: pekerja kantoran, kebutuhan sehari-hari, penumpang transit.",
        },
        { source: "OSM (Overpass API)", detail: "Jaringan jalan buat walk_score" },
      ],
      processing: [
        { step: "Walk score", detail: "Siburian et al. 2020, per grid 250m - ditampilkan berdiri sendiri, bukan digabung ke metrik lain" },
        { step: "Kompetitor", detail: "Titik MAPID Data Catalogue dengan kategori persis sama dengan tipe bisnis yang dipilih - hitungan mentah per grid, tidak dinormalisasi" },
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
    run: (station, opts) => api.siteSelection(station.id, opts.businessType || "APOTEK", opts.subtype),
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
      "name", "anchor_type", "category", "business_type", "subtype", "alamat"],
  },
  {
    id: "K-UC1",
    persona: "kebijakan",
    title: "Indeks TOD & Prioritas Pengembangan",
    description: "Station Composite Index, ranking stasiun, dan tipologi rekomendasi pengembangan.",
    expectedWait: "30-90 detik (scan semua stasiun dalam cakupan)",
    // Scores every station at once, so App drives it through the dashboard instead of `run`.
    dashboard: true,
    methodology: {
      data: [
        { source: "OSM (Overpass API)", detail: "Stasiun/halte, jaringan jalan, POI (proxy kepadatan penduduk & jalur transit)" },
        {
          source: "MAPID Data Catalogue - PERDAGANGAN DAN RETAIL, KANTOR, HALTE, STASIUN",
          year: 2025, detail: "kepadatan komersial/bisnis, transportasi alternatif",
        },
      ],
      processing: [
        { step: "Station Composite Index (SCI)", detail: "8 kriteria/18 indikator, Siburian et al. 2020 Table 1 - skor kriteria dijumlah berbobot lalu dibagi total bobot" },
        { step: "Sumber tiap indikator", detail: "OSM/MAPID kalau bisa diukur langsung; PROXY (kepadatan aktivitas dari MAPID/OSM) buat data penumpang & keamanan yang gak ada feed gratisnya; CONSTANT buat frekuensi perjalanan (paper menilai semua stasiun sama, 1 jalur MRT)" },
        { step: "Transparansi sumber", detail: "Tiap indikator ditandai OSM/MAPID/MIXED/PROXY/CONSTANT - lihat badge di detail stasiun" },
      ],
    },
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
    description: "Risiko banjir per koridor (MAPID, statis) plus konteks UHI/ekologi/curah hujan (MAPID) - layer terpisah, tanpa skor gabungan.",
    expectedWait: "3-6 detik (semua layer statis, tidak ada panggilan live)",
    methodology: {
      data: [
        {
          source: "MAPID Data Catalogue - Wilayah Bahaya/Terancam Banjir", detail:
            "Kelas 5-tingkat (Sangat Rendah..Tinggi) per zona, statis, di-download - satu-satunya sumber hazard di use case ini sekarang.",
        },
        { source: "MAPID Data Catalogue - URBAN HEAT ISLAND", year: 2022, detail: "kelas zona panas per kabupaten/kota" },
        { source: "MAPID Data Catalogue - INDEKS EKOLOGI", year: 2024, detail: "indeks per grid (turunan RSEI)" },
        { source: "MAPID Data Catalogue - Curah Hujan (Presipitasi)", year: 2020, detail: "kelas & intensitas per provinsi" },
        { source: "OSM (Overpass API)", detail: "Jaringan jalan buat koridor & rute detour" },
      ],
      processing: [
        {
          step: "Banjir - lookup statis", detail:
            "Point-in-polygon langsung ke zona MAPID yang sudah didownload, per koridor - instan, tidak ada panggilan live sama sekali.",
        },
        { step: "Klasifikasi", detail: "Pakai Kelas MAPID sendiri (5-tingkat: Sangat Rendah..Tinggi), bukan buatan project ini" },
        {
          step: "Rute aman (detour)", detail:
            "Hard avoidance seperti wheelchair=no di M-UC1: ruas yang MAPID klasifikasikan \"Tinggi\"/\"Cukup Tinggi\" dipenalti berat di routing, bukan skor gabungan",
        },
        { step: "UHI/Ekologi/Curah hujan", detail: "Ditampilkan apa adanya dari MAPID Data Catalogue, tanpa dihitung ulang" },
        {
          step: "Longsor dihapus", detail:
            "Sempat pakai BNPB InaRISK live buat longsor, tapi InaRISK lambat (~4-5 detik/panggilan) dan kadang down, dan resiko longsor Jabodetabek cuma signifikan di sebagian kecil Kabupaten Bogor (perbukitan) - bukan kebutuhan citywide use case ini, jadi dihapus sepenuhnya, bukan sekadar dimatikan.",
        },
        { step: "Tidak ada skor gabungan", detail: "Versi lama nge-blend proxy tutupan hijau (panas) + jarak sungai (banjir) jadi \"vulnerability\" 0.5/0.5 - keduanya proxy buatan sendiri. Sudah dihapus." },
      ],
    },
    extras: "resilience",
    run: (station) => api.resilience(station.id),
    layers: [
      {
        source: "corridors", type: "fill", mode: "banjir",
        paint: {
          "fill-opacity": 0.65,
          "fill-color": ["match", ["get", "banjir_kelas"],
            "Sangat Rendah", "#22c55e", "Cukup Rendah", "#84cc16", "Sedang", "#f59e0b",
            "Cukup Tinggi", "#f97316", "Tinggi", "#ef4444", "#e5e7eb"],
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
        title: "Indeks bahaya banjir per koridor (BNPB InaRISK)",
        stops: [["rendah", "#22c55e"], ["sedang", "#f59e0b"], ["tinggi", "#ef4444"], ["tidak ada data", "#e5e7eb"]],
        note: "Klasifikasi resmi InaRISK. Abu-abu = di luar cakupan raster atau mode MAPID-saja dipilih.",
      },
      longsor: {
        title: "Indeks bahaya longsor per koridor (BNPB InaRISK)",
        stops: [["rendah", "#22c55e"], ["sedang", "#f59e0b"], ["tinggi", "#ef4444"], ["tidak ada data", "#e5e7eb"]],
        note: "Klasifikasi resmi InaRISK. Abu-abu = di luar cakupan raster atau mode MAPID-saja dipilih.",
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
    popup: ["highway", "banjir_value", "banjir_class", "longsor_value", "longsor_class",
      "KELAS", "CLASS", "TEMPERATUR", "INDEKS", "STATUS", "Kelas", "Rata-rata Intensitas (mm/hari)"],
  },
]
