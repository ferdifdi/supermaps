import { useState } from "react"

const TABS = [
  { id: "ringkasan", label: "Ringkasan" },
  { id: "transfer", label: "Transfer" },
  { id: "hijau", label: "Hijau" },
  { id: "rute", label: "Rute" },
]

const GREEN_TYPE_LABELS = { park: "Taman", garden: "Taman", grass: "Rumput/RTH", forest: "Hutan kota", recreation_ground: "Lapangan/RTH" }

const MODE_LABELS = { TJ: "TransJakarta", KRL: "KRL", LRT: "LRT/Tram", Bus: "Bus lain" }

const PREFERENCES = [
  { id: "fast", label: "Paling cepat" },
  { id: "accessible", label: "Ramah kursi roda" },
]

const AQ_COLOR = (pm25) => (pm25 <= 12 ? "#22c55e" : pm25 <= 35.4 ? "#f59e0b" : pm25 <= 55.4 ? "#f97316" : pm25 <= 150.4 ? "#ef4444" : "#7f1d1d")

function countBy(features, key, colors) {
  const counts = {}
  for (const f of features) {
    const v = f.properties[key] || "?"
    counts[v] = (counts[v] || 0) + 1
  }
  return Object.entries(counts).map(([label, value]) => ({ label, value, color: colors[label] || "#9ca3af" }))
}

// One entry per map mode - drives both the map layer toggle and what shows below it,
// so there's a single "pick a topic" control instead of a separate map-mode picker and
// chart picker that overlap in name and confuse which one does what.
const TOPICS = [
  {
    id: "isochrone", label: "Peta jalan",
    rows: (result) => result.summary.walk_score_components && [
      { label: "Jaringan jalan", value: result.summary.walk_score_components.road_network, color: "#5b4bdb" },
      { label: "Ped-shed", value: result.summary.walk_score_components.ped_shed, color: "#4a90e2" },
      { label: "Persimpangan", value: result.summary.walk_score_components.intersection, color: "#b87cf6" },
      { label: "Campuran hunian", value: result.summary.walk_score_components.residential_mix, color: "#f06fae" },
    ],
    format: "percent",
    note: (s) => `Rata-rata walk_score ${s.mean_walk_score} dari ${s.cells} grid 250m (Siburian et al. 2020). ${s.isochrone_area_ha} ha terjangkau jarak, ${s.accessible_area_ha} ha ramah kursi roda.`,
  },
  {
    id: "udara", label: "Kualitas udara",
    rows: (result) => {
      const stations = result.air_quality_stations || []
      return stations.length && stations.map((st) => ({
        label: `${st.station || "?"} (${st.distance_m}m)`, value: st.pm25, color: AQ_COLOR(st.pm25),
      }))
    },
    format: "raw", unit: " µg/m³",
    note: (s) => s.air_quality
      ? `Terdekat: ${s.air_quality.pm25} µg/m³ PM2.5 (${s.air_quality.category}), stasiun ${s.air_quality.station || "?"}. Peta = hex grid diinterpolasi (IDW) dari stasiun-stasiun ini, bukan pengukuran per titik.`
      : "Data OpenAQ tidak tersedia (belum dikonfigurasi atau tidak ada stasiun dalam 25km).",
  },
  {
    id: "vegetasi", label: "Vegetasi",
    rows: () => null,
    note: (s) => `${s.tree_count} pohon (OSM natural=tree) dan ${s.green_space_count} taman/RTH terdeteksi dalam radius. Proxy kanopi, bukan indeks vegetasi tervalidasi.`,
  },
  {
    id: "aksesibilitas", label: "Aksesibilitas",
    rows: (result) => result.summary.sidewalk_ratio != null && [
      { label: "Bertrotoar", value: result.summary.sidewalk_ratio, color: "#22c55e" },
      { label: "Ramah kursi roda", value: result.summary.wheelchair_tagged_ratio, color: "#4a90e2" },
      { label: "Tidak ramah kursi roda", value: result.summary.wheelchair_no_ratio, color: "#ef4444" },
    ],
    format: "percent",
    note: () => "Rasio panjang jalan per tag OSM mentah (sidewalk=, wheelchair=), bukan skor gabungan.",
  },
  {
    id: "uhi", label: "UHI",
    rows: (result) => {
      const f = result.uhi?.features || []
      return f.length && countBy(f, "KELAS", { "ZONA PANAS": "#ef4444", "ZONA HANGAT": "#f97316", "ZONA NORMAL": "#22c55e" })
    },
    format: "count",
    note: (s, result) => (result.uhi?.features?.length
      ? "Data MAPID Data Catalogue 2022, per kabupaten/kota (zona besar - biasanya rata dalam radius 500m)."
      : "Tidak ada data UHI yang mencakup lokasi ini."),
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
      return `Rata-rata INDEKS ${avg.toFixed(3)} dari ${f.length} grid MAPID (2024), nilai asli tanpa dihitung ulang.`
    },
  },
  {
    id: "hujan", label: "Curah hujan",
    rows: (result) => {
      const f = result.rainfall?.features || []
      return f.length && countBy(f, "Kelas", { "Hujan normal": "#6baed6", "Hujan deras": "#2171b5", "Hujan sangat deras": "#08306b" })
    },
    format: "count",
    note: (s, result) => (result.rainfall?.features?.length
      ? "Data MAPID Data Catalogue 2020, per provinsi (zona besar - biasanya rata dalam radius 500m)."
      : "Tidak ada data curah hujan yang mencakup lokasi ini."),
  },
]

function BarChart({ rows, format, unit }) {
  const max = Math.max(...rows.map((r) => r.value), format === "percent" ? 1 : 1)
  return (
    <div className="section">
      {rows.map((r) => (
        <div key={r.label} className="criterion">
          <div className="criterion-head" style={{ cursor: "default" }}>
            <span><span className="dot" style={{ background: r.color }} />{r.label}</span>
            <span className="bar">
              <span style={{ width: `${(r.value / max) * 100}%`, background: r.color }} />
            </span>
            <span className="criterion-value">
              {format === "percent" ? `${Math.round(r.value * 100)}%` : `${Math.round(r.value * 10) / 10}${unit || ""}`}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

function Ringkasan({ result, mapMode, onMapMode }) {
  const topic = TOPICS.find((t) => t.id === mapMode) || TOPICS[0]
  const rows = topic.rows(result)

  return (
    <>
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

      <div className="section">
        <label>{topic.label}</label>
        <p className="note">{topic.note(result.summary, result)}</p>
      </div>
      {rows && <BarChart rows={rows} format={topic.format} unit={topic.unit} />}
    </>
  )
}

function TransferList({ result, onFocus }) {
  const points = result.transfer_points?.features || []
  return (
    <div className="section">
      <label>Titik transfer ({points.length})</label>
      <p className="note">Hijau = headway asli dari GTFS TransJakarta. Abu-abu = proxy jarak jalan kaki OSM (KRL/MRT/LRT/bus lain belum ada jadwal publik).</p>
      <div className="board">
        {points.length === 0 && <p className="note">Tidak ada titik transfer dalam radius.</p>}
        {points.map((f, i) => {
          const p = f.properties
          return (
            <button key={i} className="board-row" style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer" }}
              onClick={() => onFocus(f)}>
              <span className="board-name">
                <span className="dot" style={{ background: p.is_proxy ? "#9ca3af" : "#22c55e" }} />
                {p.name} <span className="note">({MODE_LABELS[p.mode] || p.mode})</span>
              </span>
              <div className="note">
                {p.distance_m} m
                {p.headway_min_peak != null && ` · headway ~${p.headway_min_peak} menit (puncak)`}
                {p.is_proxy && " · proxy"}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function GreenSearch({ result, onFocus, onRouteGreen, routingId }) {
  const [q, setQ] = useState("")
  const [expanded, setExpanded] = useState(null)
  const all = result.ecology_poi?.features || []
  const matches = (q.trim()
    ? all.filter((f) => (f.properties.name || "").toLowerCase().includes(q.trim().toLowerCase()))
    : all
  ).slice(0, 30)

  return (
    <div className="section">
      <label>Cari taman & ruang hijau ({all.length})</label>
      <p className="note">Dari tag OSM (leisure=park/garden, landuse=grass/forest/recreation_ground) dalam radius jalan kaki.</p>
      <input
        className="search-input"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Cari dari ${all.length} lokasi hijau...`}
      />
      <div className="board">
        {matches.length === 0 && <p className="note">Tidak ada lokasi hijau cocok.</p>}
        {matches.map((f, i) => (
          <div key={i}>
            <div className="board-row" style={{ display: "flex", gap: 6 }}>
              <button
                style={{ flex: 1, textAlign: "left", border: "none", background: "none", cursor: "pointer", padding: 0 }}
                onClick={() => { onFocus(f); setExpanded(expanded === i ? null : i) }}
              >
                <span className="board-name">
                  <span className="dot" style={{ background: "#22c55e" }} />
                  {f.properties.name || "(tanpa nama)"}
                  <span className="note"> ({GREEN_TYPE_LABELS[f.properties.leisure || f.properties.landuse] || "RTH"})</span>
                </span>
              </button>
              <button className="mini" onClick={() => onRouteGreen(f, i)} disabled={routingId === i}>
                {routingId === i ? "…" : "Rute"}
              </button>
            </div>
          </div>
        ))}
        {all.length > 30 && !q.trim() && <p className="note">Menampilkan 30 pertama. Ketik untuk mencari.</p>}
      </div>
    </div>
  )
}

function Rute({ stationId, picking, onTogglePick, preference, onPreference, routeResult, routeStatus }) {
  return (
    <div className="section">
      <label>Preferensi rute</label>
      <div className="dock-actions">
        {PREFERENCES.map((p) => (
          <button key={p.id} className={preference === p.id ? "mini active" : "mini"} onClick={() => onPreference(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <p className="note">
        Rute jalan kaki dari stasiun ke tujuan dekat (rumah/kantor/POI). Bukan buat commute
        antar-stasiun - jaraknya biasanya jauh di luar jangkauan jalan kaki.
      </p>
      <button className={picking ? "secondary active" : "secondary"} onClick={onTogglePick} disabled={!stationId}>
        {picking ? "Klik di peta untuk tujuan…" : "Pilih tujuan di peta"}
      </button>
      {routeStatus && <p className="note">{routeStatus}</p>}
      {routeResult && (
        <p className="note">
          Jarak <b>{routeResult.length_m} m</b> · {routeResult.minutes} menit jalan kaki
          {routeResult.blocked_segments_crossed > 0 && ` · ${routeResult.blocked_segments_crossed} ruas tanpa akses kursi roda terlewati (tidak ada jalur lain)`}
        </p>
      )}
    </div>
  )
}

export default function WalkDock({
  open, onToggle, tab, onTab, result, stationId,
  picking, onTogglePick, preference, onPreference, routeResult, routeStatus, onFocus,
  onRouteGreen, greenRoutingId,
  mapMode, onMapMode,
}) {
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
          {tab === "ringkasan" && <Ringkasan result={result} mapMode={mapMode} onMapMode={onMapMode} />}
          {tab === "transfer" && <TransferList result={result} onFocus={onFocus} />}
          {tab === "hijau" && <GreenSearch result={result} onFocus={onFocus} onRouteGreen={onRouteGreen} routingId={greenRoutingId} />}
          {tab === "rute" && (
            <Rute
              stationId={stationId} picking={picking} onTogglePick={onTogglePick}
              preference={preference} onPreference={onPreference}
              routeResult={routeResult} routeStatus={routeStatus}
            />
          )}
        </div>
      </aside>
    </>
  )
}
