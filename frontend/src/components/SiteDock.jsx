import { useState } from "react"

const TABS = [
  { id: "ringkasan", label: "Ringkasan" },
  { id: "anchor", label: "Anchor" },
  { id: "kompetitor", label: "Kompetitor" },
]

const ANCHOR_TYPE_LABELS = { kantor: "Kantor", kebutuhan_dasar: "Kebutuhan dasar", transit: "Transit" }
const ANCHOR_TYPE_COLORS = { kantor: "#4a90e2", kebutuhan_dasar: "#22c55e", transit: "#f59e0b" }

const MAP_MODES = [
  { id: "walk_score", label: "Walk score" },
  { id: "kompetitor", label: "Kompetitor" },
  { id: "anchor", label: "Anchor" },
]

function BarChart({ rows, format }) {
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
            <span className="criterion-value">{format === "percent" ? `${Math.round(r.value * 100)}%` : r.value}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function Ringkasan({ result, mapMode, onMapMode }) {
  const s = result.summary
  const anchorRows = [
    { label: "Kantor (MAPID)", value: s.anchor_kantor, color: ANCHOR_TYPE_COLORS.kantor },
    { label: "Kebutuhan dasar (MAPID)", value: s.anchor_kebutuhan_dasar, color: ANCHOR_TYPE_COLORS.kebutuhan_dasar },
    { label: "Transit (MAPID)", value: s.anchor_transit, color: ANCHOR_TYPE_COLORS.transit },
  ]
  return (
    <>
      <div className="section">
        <label>Tampilan peta</label>
        <div className="dock-actions">
          {MAP_MODES.map((m) => (
            <button key={m.id} className={mapMode === m.id ? "mini active" : "mini"} onClick={() => onMapMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="section">
        <label>Walk score</label>
        <p className="note">Rata-rata <b>{s.mean_walk_score ?? "-"}</b> per grid 250m (Siburian et al. 2020) - ditampilkan berdiri sendiri, tidak digabung ke metrik lain.</p>
      </div>

      <div className="section">
        <label>Anchor MAPID di sekitar ({s.anchor_count})</label>
        <BarChart rows={anchorRows} format="count" />
      </div>

      <div className="section">
        <label>Kompetitor "{s.business_type}{s.subtype ? ` - ${s.subtype}` : ""}"</label>
        <p className="note">
          <b>{s.competitors}</b> kompetitor tipe ini ditemukan di radius (MAPID Data Catalogue, hitungan asli - bukan MAPID Missions).
        </p>
      </div>
    </>
  )
}

function AnchorSearch({ result, onFocus }) {
  const [q, setQ] = useState("")
  const [typeFilter, setTypeFilter] = useState([])
  const all = result.anchors?.features || []
  const byType = typeFilter.length ? all.filter((f) => typeFilter.includes(f.properties.anchor_type)) : all
  const matches = (q.trim()
    ? byType.filter((f) => (f.properties.name || "").toLowerCase().includes(q.trim().toLowerCase()))
    : byType
  ).slice(0, 30)

  const toggleType = (t) =>
    setTypeFilter((prev) => (prev.includes(t) ? prev.filter((v) => v !== t) : [...prev, t]))

  return (
    <div className="section">
      <label>Filter tipe anchor</label>
      <div className="dock-actions">
        {Object.keys(ANCHOR_TYPE_LABELS).map((t) => (
          <button
            key={t}
            className={typeFilter.includes(t) ? "mini active" : "mini"}
            onClick={() => toggleType(t)}
            style={typeFilter.includes(t) ? { background: ANCHOR_TYPE_COLORS[t], borderColor: ANCHOR_TYPE_COLORS[t] } : {}}
          >
            {ANCHOR_TYPE_LABELS[t]}
          </button>
        ))}
      </div>
      <input
        className="search-input"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Cari dari ${byType.length} anchor...`}
      />
      <div className="board">
        {matches.length === 0 && <p className="note">Tidak ada anchor cocok.</p>}
        {matches.map((f, i) => (
          <button key={i} className="board-row" style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer" }}
            onClick={() => onFocus(f)}>
            <span className="board-name">
              <span className="dot" style={{ background: ANCHOR_TYPE_COLORS[f.properties.anchor_type] }} />
              {f.properties.name || "(tanpa nama)"}
              <span className="note"> ({ANCHOR_TYPE_LABELS[f.properties.anchor_type]}{f.properties.category ? ` - ${f.properties.category}` : ""})</span>
            </span>
          </button>
        ))}
        {byType.length > 30 && !q.trim() && <p className="note">Menampilkan 30 pertama. Ketik untuk mencari.</p>}
      </div>
    </div>
  )
}

function Kompetitor({ result, onFocus }) {
  const points = result.competitors?.features || []
  return (
    <div className="section">
      <label>Kompetitor "{result.summary.business_type}{result.summary.subtype ? ` - ${result.summary.subtype}` : ""}" ({points.length})</label>
      <p className="note">Dari MAPID Data Catalogue - kategori persis sama dengan tipe bisnis yang dipilih.</p>
      <div className="board">
        {points.length === 0 && <p className="note">Tidak ada kompetitor tipe ini ditemukan di radius.</p>}
        {points.map((f, i) => (
          <button key={i} className="board-row" style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer" }}
            onClick={() => onFocus(f)}>
            <span className="board-name">
              <span className="dot" style={{ background: "#7c3aed" }} />
              {f.properties.name || `Kompetitor #${i + 1}`}
            </span>
            {f.properties.alamat && <div className="note">{f.properties.alamat}</div>}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function SiteDock({ open, onToggle, tab, onTab, result, onFocus, mapMode, onMapMode }) {
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
          {tab === "anchor" && <AnchorSearch result={result} onFocus={onFocus} />}
          {tab === "kompetitor" && <Kompetitor result={result} onFocus={onFocus} />}
        </div>
      </aside>
    </>
  )
}
