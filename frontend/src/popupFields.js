// Human-readable map-click popups.
//
// Each use case's `popup` array (see usecases.js) used to be a flat list of raw
// backend property names, rendered by MapView as literal `<b>key</b>: value` rows -
// e.g. "access_by_walking: 0.72", "KELAS: Sangat Panas". Non-technical users (see
// PERSONAS in usecases.js) have no reason to know what "access_by_walking" or "KELAS"
// means. This file replaces that with small "field" descriptors: `test(props)` decides
// whether a clicked feature matches (e.g. "does this feature carry access_by_walking"),
// `render(props)` returns a short factual sentence using only real values already on
// the feature - no invented numbers, no invented quality buckets (see the file-level
// comment in usecases.js methodology blocks for which layers are "published as-is").
//
// MapView.jsx concatenates every matching field's render() output into the popup.

export const MODE_LABELS = { TJ: "TransJakarta", MRT: "MRT", KRL: "KRL", LRT: "LRT" }

export const HIGHWAY_LABELS = {
  primary: "jalan utama", secondary: "jalan sekunder", tertiary: "jalan kolektor",
  residential: "jalan permukiman", unclassified: "jalan lingkungan", trunk: "jalan arteri",
  footway: "jalur pejalan kaki", path: "jalan setapak", service: "jalan akses/servis",
  pedestrian: "area pejalan kaki", living_street: "jalan lingkungan (living street)",
  cycleway: "jalur sepeda", steps: "tangga",
}

const SIDEWALK_LABELS = {
  yes: "ada trotoar", both: "trotoar di kedua sisi", left: "trotoar di satu sisi",
  right: "trotoar di satu sisi", separate: "trotoar terpisah dari badan jalan",
  no: "tidak ada trotoar", none: "tidak ada trotoar",
}

const WHEELCHAIR_LABELS = {
  yes: "bisa dilalui kursi roda", limited: "akses kursi roda terbatas", no: "tidak ramah kursi roda",
}

const GREEN_TAG_LABELS = {
  park: "taman", garden: "taman/kebun", nature_reserve: "kawasan konservasi",
  playground: "taman bermain", forest: "hutan kota", grass: "lahan rumput/RTH",
  recreation_ground: "lapangan/RTH", green_area: "area hijau", shelter: "tempat berteduh",
  common: "ruang terbuka", pitch: "lapangan olahraga",
}

const ANCHOR_LABELS = { kantor: "Kantor", kebutuhan_dasar: "Kebutuhan dasar", transit: "Transit" }

// M-UC1 grid: Siburian et al. (2020) weighted walk-access score, standardised per cell
// within this one station's buffer (see usecases.js methodology - no invented "baik/
// buruk" bucket, this score has no official bins).
export const accessByWalkingField = {
  test: (p) => p.access_by_walking != null,
  render: (p) =>
    `<b>Sel #${p.grid_id} - Skor akses jalan kaki: ${p.access_by_walking.toFixed(2)} dari 1</b><br/>` +
    `Dibandingkan sel-sel lain dalam radius ini - gabungan kepadatan jaringan jalan, jangkauan layan pejalan kaki, jumlah persimpangan, dan keragaman hunian di sekitar sel 250 m ini.`,
}

// U-UC1 grid: same Siburian formula, shown standalone (not fused with competitor/anchor
// counts) - see usecases.js "Tidak ada skor gabungan" note.
export const siteGridField = {
  test: (p) => p.walk_score != null,
  render: (p) => {
    const anchorTotal = (p.anchor_kantor || 0) + (p.anchor_kebutuhan_dasar || 0) + (p.anchor_transit || 0)
    return (
      `<b>Sel #${p.grid_id} (250 m persegi)</b><br/>` +
      `Walk score: ${p.walk_score.toFixed(2)} dari 1 (dibanding sel lain di radius ini).<br/>` +
      `Kompetitor sejenis dalam sel: ${p.competitor_count} titik.<br/>` +
      `Anchor demand (kantor, kebutuhan dasar, transit): ${anchorTotal} titik - ` +
      `kantor ${p.anchor_kantor}, kebutuhan dasar ${p.anchor_kebutuhan_dasar}, transit ${p.anchor_transit}.`
    )
  },
}

export const transferPointField = {
  test: (p) => p.mode != null && p.distance_m != null,
  render: (p) => {
    const modeLabel = MODE_LABELS[p.mode] || p.mode
    let headway = ""
    if (p.headway_min_peak != null) {
      headway = p.is_proxy
        ? `<br/>Perkiraan headway (bukan jadwal real-time): sekitar ${p.headway_min_peak} menit saat jam sibuk.`
        : `<br/>Headway jam sibuk: ${p.headway_min_peak} menit (jadwal resmi).`
    } else if (p.is_proxy) {
      headway = `<br/>Jadwal real-time belum tersedia untuk moda ini di titik ini.`
    }
    return `<b>${p.name || modeLabel}</b><br/>${modeLabel} - ${Math.round(p.distance_m)} m jalan kaki dari sini.${headway}`
  },
}

// Route line (M-UC1 detour route, M-UC2 isochrone route) - length_m/minutes together
// means an actual route; isochroneMinutesField below covers the "just a boundary" case.
export const routeField = {
  test: (p) => p.length_m != null && p.minutes != null,
  render: (p) => {
    const pref = p.preference === "wheelchair" ? "ramah kursi roda" : "tercepat"
    const blocked = p.blocked_segments_crossed
      ? `<br/>Melewati ${p.blocked_segments_crossed} ruas jalan yang kurang ramah kursi roda.`
      : ""
    return `<b>Rute ${pref}</b><br/>Jarak ${Math.round(p.length_m)} m, sekitar ${p.minutes} menit jalan kaki.${blocked}`
  },
}

// M-UC2's isochrone boundary carries only "minutes" (constant walking-time radius, no
// length) - kept distinct from routeField so it doesn't collide with an actual route line.
export const isochroneMinutesField = {
  test: (p) => p.minutes != null && p.length_m == null,
  render: (p) => `<b>Batas jangkauan jalan kaki: sekitar ${p.minutes} menit dari stasiun</b>`,
}

// PM2.5 category already comes from the backend's WHO/EPA-style breakpoints
// (airquality.py's PM25_BREAKPOINTS) - reused as-is, not re-bucketed here.
export const pm25Field = {
  test: (p) => p.pm25 != null,
  render: (p) => `<b>Kualitas udara (PM2.5): ${p.pm25} µg/m³</b> - ${p.category || "kategori tidak tersedia"}.`,
}

export const greenGridField = {
  test: (p) => p.green_count != null,
  render: (p) => `<b>Sel #${p.grid_id}</b><br/>Jumlah titik hijau (pohon, taman, RTH) dalam sel ini: ${p.green_count} titik.`,
}

export const greenPoiField = {
  test: (p) => p.leisure != null || p.landuse != null || p.kind != null,
  render: (p) => {
    const raw = p.leisure || p.landuse || p.kind
    const label = GREEN_TAG_LABELS[raw] || raw || "ruang hijau"
    return `<b>${p.name || "Titik hijau"}</b><br/>Jenis: ${label}.`
  },
}

// M-UC1's accessibility_roads - raw OSM wheelchair/sidewalk tags, no invented weighting
// (see usecases.js comment on that layer).
export const roadAccessField = {
  test: (p) => p.highway != null && (p.wheelchair !== undefined || p.sidewalk !== undefined),
  render: (p) => {
    const hw = HIGHWAY_LABELS[p.highway] || p.highway
    const wc = p.wheelchair ? WHEELCHAIR_LABELS[p.wheelchair] || p.wheelchair : "status akses kursi roda tidak tercatat"
    const sw = p.sidewalk ? `, ${SIDEWALK_LABELS[p.sidewalk] || p.sidewalk}` : ""
    return `<b>${hw}</b> - ${wc}${sw}.`
  },
}

// M-UC1's LST grid - real sampled temperature + MAPID's own 5-class label, reused as-is
// (see usecases.js "LST (Suhu Permukaan)" processing note).
export const lstField = {
  test: (p) => p.SUHU != null,
  render: (p) => `<b>Sel #${p.grid_id} - Suhu permukaan: ${p.SUHU}°C</b> - kelas ${p.CLASS || p.KELAS} (musim berjalan, citra satelit LST MAPID).`,
}

// K-UC2 only - AST estimate (Arridha et al. 2023 linear fit from LST, classified on its
// own CLASS_AST/KELAS_AST - see lst.py's classify_ast) that M-UC1's LST layer explicitly
// doesn't compute. A separate field/layer from lstField above, not combined with it.
export const astField = {
  test: (p) => p.AST != null,
  render: (p) => `<b>Sel #${p.grid_id} - AST (estimasi): ${p.AST}°C</b> - kelas ${p.CLASS_AST || p.KELAS_AST} (musim berjalan).`,
}

// K-UC2's UHI zone - MAPID's own class + published temperature range, shown as-is.
export const uhiField = {
  test: (p) => p.TEMPERATUR != null,
  render: (p) => `<b>Urban Heat Island: ${p.KELAS || p.CLASS}</b> - suhu permukaan sekitar ${p.TEMPERATUR} (data MAPID per kabupaten/kota, 2022).`,
}

// MAPID's INDEKS EKOLOGI - published 0-1 value + MAPID's own STATUS label (both are
// MAPID's real data, not derived here) - see usecases.js "ditampilkan apa adanya" note.
// No extra "baik/buruk" wording is added beyond MAPID's own STATUS field.
export const ecologyIndexField = {
  test: (p) => p.INDEKS != null,
  render: (p) =>
    `<b>Indeks ekologi kawasan: ${p.INDEKS.toFixed(2)} dari 1</b>` +
    (p.STATUS ? ` - status publikasi MAPID: ${p.STATUS}.` : " (data MAPID, 2024)."),
}

// MAPID's rainfall zone - published class + intensity, per province (coarse zone).
export const rainfallField = {
  test: (p) => p.Kelas != null && p["Rata-rata Intensitas (mm/hari)"] != null,
  render: (p) =>
    `<b>Curah hujan: ${p.Kelas}</b> - rata-rata intensitas ${p["Rata-rata Intensitas (mm/hari)"]} mm/hari (data MAPID per provinsi, zona besar).`,
}

// K-UC2's flood-risk zone (MAPID's WILAYAH BAHAYA/TERANCAM BANJIR) - only carries Kelas,
// no intensity field, which is how it's told apart from rainfallField above.
export const floodRiskMapidField = {
  test: (p) => p.Kelas != null && p["Rata-rata Intensitas (mm/hari)"] == null,
  render: (p) => `<b>Wilayah rawan banjir: ${p.Kelas}</b> (data MAPID).`,
}

// K-UC2's road corridors - MAPID's 5-level Kelas when it has coverage, otherwise BNPB
// InaRISK's 3-level class for that same corridor (two different official schemes, not
// reconciled into one number - see usecases.js "banjir" legend note).
export const corridorHazardField = {
  test: (p) => p.corridor_id !== undefined,
  render: (p) => {
    const hw = HIGHWAY_LABELS[p.highway] || p.highway
    const lines = [`<b>${hw}</b>`]
    const banjirKelas = p.banjir_kelas || p.banjir_class
    if (banjirKelas) {
      const src = p.banjir_kelas ? "data MAPID" : "BNPB InaRISK"
      const val = p.banjir_value != null ? ` (indeks ${p.banjir_value.toFixed(2)})` : ""
      lines.push(`Risiko banjir: ${banjirKelas}${val} - ${src}.`)
    }
    if (p.longsor_class) {
      const val = p.longsor_value != null ? ` (indeks ${p.longsor_value.toFixed(2)})` : ""
      lines.push(`Risiko longsor: ${p.longsor_class}${val} - BNPB InaRISK.`)
    }
    return lines.join("<br/>")
  },
}

// K-UC1 dashboard station bubble - classification/typology are the app's own established
// labels (tinggi/sedang/rendah, see CLASS_COLORS), reused as-is.
export const sciField = {
  test: (p) => p.sci != null,
  render: (p) =>
    `<b>${p.name}</b><br/>Peringkat #${p.rank} - Indeks TOD: ${p.sci.toFixed(2)} dari 1, tergolong "${p.classification}".` +
    (p.typology ? `<br/>Tipologi rekomendasi: ${p.typology}.` : ""),
}

// U-UC1 anchor pins (kantor/kebutuhan dasar/transit demand points).
export const anchorPinField = {
  test: (p) => p.anchor_type != null,
  render: (p) => `<b>${p.name || ANCHOR_LABELS[p.anchor_type] || "Anchor"}</b><br/>Jenis: ${ANCHOR_LABELS[p.anchor_type] || p.anchor_type}.`,
}

// U-UC1 competitor pins.
export const competitorPinField = {
  test: (p) => p.business_type != null && p.anchor_type == null,
  render: (p) => {
    const sub = p.subtype2 || p.subtype
    const addr = p.alamat ? `<br/>${p.alamat}` : ""
    return `<b>${p.name || "Kompetitor"}</b><br/>Kompetitor sejenis: ${p.business_type}${sub ? ` (${sub})` : ""}.${addr}`
  },
}

// M-UC2 basic-need POI (needs CATEGORY_LABELS from equity.js, passed in by the caller
// since that map already lives in usecases.js's imports).
export const basicNeedPoiField = (categoryLabels) => ({
  test: (p) => p.category != null && p.reachable !== undefined,
  render: (p) => {
    const catLabel = categoryLabels[p.category] || p.category
    const reach = p.reachable ? "terjangkau jalan kaki dari stasiun" : "di luar jangkauan jalan kaki dari stasiun"
    const sub = p.tipe_2 ? ` (${p.tipe_2})` : ""
    const status = p.status ? `<br/>Status: ${p.status}.` : ""
    return `<b>${p.name || catLabel}</b><br/>${catLabel}${sub} - ${reach}.${status}`
  },
})
