import { HIGHWAY_LABELS } from "../popupFields"

const TABS = [
  { id: "ringkasan", label: "Ringkasan" },
  { id: "koridor", label: "Koridor" },
]

function countBy(features, key, colors) {
  const counts = {}
  for (const f of features) {
    const v = f.properties[key] || "?"
    counts[v] = (counts[v] || 0) + 1
  }
  return Object.entries(counts).map(([label, value]) => ({ label, value, color: colors[label] || "#9ca3af" }))
}

function countByCorridorClass(features, key, colors) {
  const counts = {}
  for (const f of features) {
    const v = f.properties[key]
    if (!v) continue
    counts[v] = (counts[v] || 0) + 1
  }
  return Object.entries(counts).map(([label, value]) => ({ label, value, color: colors[label] || "#9ca3af" }))
}

const HAZARD_COLORS = { rendah: "#22c55e", sedang: "#f59e0b", tinggi: "#ef4444" }
// MAPID's own 5-level Kelas (the MAPID path) - different scheme from InaRISK's 3-level
// rendah/sedang/tinggi (the InaRISK fallback path), same palette direction (green->red)
// as banjir_mapid. Which path a station uses is decided automatically server-side by
// data coverage (analysis.py's resilience()) - there's no user-facing switch for it.
const MAPID_HAZARD_COLORS = {
  "Sangat Rendah": "#22c55e", "Cukup Rendah": "#84cc16", "Sedang": "#f59e0b",
  "Cukup Tinggi": "#f97316", "Tinggi": "#ef4444",
}

// Same "one selector drives map + stats" pattern as M-UC1's WalkDock - avoids a separate
// map-mode picker and chart picker showing the same topic names twice.
const TOPICS = [
  {
    id: "banjir", label: "Banjir",
    // The MAPID path populates banjir_kelas (5-level), the InaRISK fallback path
    // populates banjir_class (3-level) instead - see analysis.py's resilience(). Which
    // one ran for this station is decided automatically by data coverage, not by the user.
    rows: (result) => {
      const f = result.corridors?.features || []
      if (!f.length) return false
      return result.summary.use_inarisk
        ? countByCorridorClass(f, "banjir_class", HAZARD_COLORS)
        : countByCorridorClass(f, "banjir_kelas", MAPID_HAZARD_COLORS)
    },
    format: "count",
    note: (s) => s.use_inarisk
      ? `${s.banjir_known}/${s.corridors} koridor punya data InaRISK, ${s.banjir_tinggi} diklasifikasikan "tinggi".`
      : `${s.banjir_known}/${s.corridors} koridor punya data MAPID (Kelas 5-tingkat), ${s.banjir_tinggi} diklasifikasikan "Tinggi"/"Cukup Tinggi".`,
  },
  {
    id: "longsor", label: "Longsor",
    rows: (result) => {
      const f = result.corridors?.features || []
      return f.length && countByCorridorClass(f, "longsor_class", HAZARD_COLORS)
    },
    format: "count",
    note: (s) => s.use_inarisk
      ? `${s.longsor_known}/${s.corridors} koridor punya data InaRISK, ${s.longsor_tinggi} diklasifikasikan "tinggi".`
      : "MAPID tidak menyediakan data longsor untuk area ini - hanya tersedia otomatis dari BNPB InaRISK saat MAPID tidak mencakup wilayah stasiun.",
  },
  {
    id: "uhi", label: "UHI",
    rows: (result) => {
      const f = result.uhi?.features || []
      return f.length && countBy(f, "KELAS", { "ZONA PANAS": "#ef4444", "ZONA HANGAT": "#f97316", "ZONA NORMAL": "#22c55e" })
    },
    format: "count",
    note: (s, result) => (result.uhi?.features?.length ? "Data MAPID Data Catalogue 2022, per kabupaten/kota (zona besar)." : "Tidak ada data UHI yang mencakup lokasi ini."),
  },
  {
    id: "ekologi_index", label: "Indeks ekologi",
    rows: (result) => {
      const f = result.ecology_index?.features || []
      return f.length && countBy(f, "STATUS", { BAIK: "#15803d", CUKUP: "#a3e635", SEDANG: "#f59e0b", BURUK: "#ef4444", "TIDAK DIKETAHUI": "#9ca3af" })
    },
    format: "count",
    note: (s, result) => {
      const f = result.ecology_index?.features || []
      if (!f.length) return "Tidak ada data indeks ekologi yang mencakup lokasi ini."
      const avg = f.reduce((sum, ft) => sum + ft.properties.INDEKS, 0) / f.length
      return `Indeks ekologi rata-rata ${avg.toFixed(3)} dari 1, di ${f.length} sel data MAPID (2024, turunan RSEI).`
    },
  },
  {
    id: "hujan", label: "Curah hujan",
    rows: (result) => {
      const f = result.rainfall?.features || []
      return f.length && countBy(f, "Kelas", { "Hujan normal": "#6baed6", "Hujan deras": "#2171b5", "Hujan sangat deras": "#08306b" })
    },
    format: "count",
    note: (s, result) => (result.rainfall?.features?.length ? "Data MAPID Data Catalogue 2020, per provinsi (zona besar)." : "Tidak ada data curah hujan yang mencakup lokasi ini."),
  },
  {
    id: "banjir_mapid", label: "Banjir (MAPID)",
    rows: (result) => {
      const f = result.flood_risk_mapid?.features || []
      return f.length && countBy(f, "Kelas", {
        "Sangat Rendah": "#22c55e", "Cukup Rendah": "#84cc16", "Sedang": "#f59e0b",
        "Cukup Tinggi": "#f97316", "Tinggi": "#ef4444",
      })
    },
    format: "count",
    note: (s, result) => (result.flood_risk_mapid?.features?.length
      ? "Data MAPID \"Wilayah Bahaya/Terancam Banjir\" - sumber & skema klasifikasi beda dari InaRISK di atas, ditampilkan terpisah, bukan digabung jadi satu angka."
      : "Tidak ada data wilayah banjir MAPID yang mencakup lokasi ini."),
  },
]

// Same checkbox-list pattern as WalkDock's LayerToggles (M-UC1), but K-UC2 only has one
// independent overlay to toggle: every fill here is mode-gated (one topic visible at a
// time via TOPICS above), so there's just a single "hide whichever topic fill is active"
// checkbox, shared across all of them via the "resilience_heatmap" toggle key in
// usecases.js. No separate road-corridor skeleton layer exists here to add a toggle for.
function LayerToggles({ showHeatmap, onToggleHeatmap }) {
  if (!onToggleHeatmap) return null
  return (
    <div className="section">
      <label>Layer di peta</label>
      <div className="dock-actions" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
        <label className="filter-option" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={showHeatmap !== false} onChange={onToggleHeatmap} />
          Heatmap (ikut topik dipilih)
        </label>
      </div>
    </div>
  )
}

function BarChart({ rows }) {
  const max = Math.max(...rows.map((r) => r.value), 1)
  return (
    <div className="section">
      {rows.map((r) => (
        <div key={r.label} className="criterion">
          <div className="criterion-head" style={{ cursor: "default" }}>
            <span><span className="dot" style={{ background: r.color }} />{r.label}</span>
            <span className="bar">
              <span style={{ width: `${(r.value / max) * 100}%`, background: r.color }} />
            </span>
            <span className="criterion-value">{r.value}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function Ringkasan({ result, mapMode, onMapMode, ...toggles }) {
  const topic = TOPICS.find((t) => t.id === mapMode) || TOPICS[0]
  const rows = topic.rows(result)
  return (
    <>
      {result.summary.inarisk_unavailable && (
        <div className="section">
          <p className="note" style={{ color: "#ef4444", fontWeight: 600 }}>
            ⚠ Server InaRISK (BNPB) sedang tidak bisa diakses - ini beda dengan "tidak ada risiko".
            MAPID tidak mencakup wilayah stasiun ini (makanya InaRISK dipakai), jadi coba lagi nanti saja.
          </p>
        </div>
      )}
      <div className="section">
        <label>Tampilan peta</label>
        <div className="dock-actions">
          {TOPICS.map((t) => (
            <button key={t.id} className={mapMode === t.id ? "mini active" : "mini"} onClick={() => onMapMode(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <LayerToggles {...toggles} />

      <div className="section">
        <label>{topic.label}</label>
        <p className="note">{topic.note(result.summary, result)}</p>
      </div>
      {rows ? <BarChart rows={rows} /> : <p className="note">Data tidak tersedia untuk layer ini.</p>}

      <div className="section">
        <label>Koridor jalan</label>
        <p className="note">{result.summary.corridors} ruas jalan dianalisis dalam radius 500m. Tidak ada skor kerentanan gabungan - tiap hazard (banjir, longsor, panas, ekologi, curah hujan) ditampilkan terpisah, apa adanya.</p>
        <p className="note">Resolusi data: buffer 500 m dari stasiun, koridor jalan dengan lebar buffer 40 m.</p>
      </div>
    </>
  )
}

const MAPID_TINGGI_KELAS = new Set(["Tinggi", "Cukup Tinggi"])

function KoridorList({ result, onFocus, onMapMode, ...toggles }) {
  const corridors = result.corridors?.features || []
  const usesInarisk = result.summary.use_inarisk
  const risky = corridors.filter((f) => usesInarisk
    ? f.properties.banjir_class === "tinggi" || f.properties.longsor_class === "tinggi"
    : MAPID_TINGGI_KELAS.has(f.properties.banjir_kelas))
  return (
    <div className="section">
      <LayerToggles {...toggles} />
      <label>Koridor risiko "tinggi" ({risky.length})</label>
      <p className="note">
        {usesInarisk
          ? "Diklasifikasikan InaRISK sendiri (bukan skor project ini) - ruas ini yang dihindari rute \"aman\" (detour)."
          : "Diklasifikasikan MAPID sendiri (Kelas 5-tingkat, bukan skor project ini) - ruas ini yang dihindari rute \"aman\" (detour)."}
      </p>
      <div className="board">
        {risky.length === 0 && <p className="note">Tidak ada koridor berisiko "tinggi" terdeteksi.</p>}
        {risky.map((f, i) => (
          <button key={i} className="board-row" style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer" }}
            onClick={() => {
              // The corridor fill layer is mode-gated (mode: "banjir"/"longsor" in
              // usecases.js) - flying to a corridor without also switching to whichever
              // hazard actually made it "tinggi" here just pans to an empty map, the fill
              // for the currently-active topic (if any other) doesn't show this corridor.
              const isBanjirTinggi = usesInarisk ? f.properties.banjir_class === "tinggi" : MAPID_TINGGI_KELAS.has(f.properties.banjir_kelas)
              onMapMode?.(isBanjirTinggi ? "banjir" : "longsor")
              onFocus(f)
            }}>
            <span className="board-name">
              <span className="dot" style={{ background: "#ef4444" }} />
              Koridor #{f.properties.corridor_id} ({HIGHWAY_LABELS[f.properties.highway] || f.properties.highway})
            </span>
            <div className="note">
              {usesInarisk ? (
                <>
                  {f.properties.banjir_class === "tinggi" && `banjir: ${f.properties.banjir_value} `}
                  {f.properties.longsor_class === "tinggi" && `longsor: ${f.properties.longsor_value}`}
                </>
              ) : `banjir: ${f.properties.banjir_kelas}`}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

export default function ResilienceDock({
  open, onToggle, tab, onTab, result, onFocus, mapMode, onMapMode, showHeatmap, onToggleHeatmap,
}) {
  const toggles = { showHeatmap, onToggleHeatmap }
  return (
    <>
      <button className={open ? "dock-toggle open" : "dock-toggle"} onClick={onToggle}>
        {open ? "›" : "‹"}
      </button>
      <aside className={open ? "dock open" : "dock"}>
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={t.id === tab ? "tab active" : "tab"} onClick={() => onTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="dock-body">
          {tab === "ringkasan" && <Ringkasan result={result} mapMode={mapMode} onMapMode={onMapMode} {...toggles} />}
          {tab === "koridor" && <KoridorList result={result} onFocus={onFocus} onMapMode={onMapMode} {...toggles} />}
        </div>
      </aside>
    </>
  )
}
