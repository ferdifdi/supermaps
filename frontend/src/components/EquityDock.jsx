import { useState } from "react"
import { api } from "../api"
import { CATEGORIES, CATEGORY_COLORS, CATEGORY_LABELS } from "../equity"

const TABS = [
  { id: "ringkasan", label: "Ringkasan" },
  { id: "kategori", label: "Kategori" },
  { id: "poi", label: "Cari POI" },
  { id: "bandingkan", label: "Bandingkan" },
]

const MAP_MODES = [
  { id: "isochrone", label: "Isochrone" },
  { id: "heatmap_poi", label: "Heatmap POI" },
]

// Same checkbox-list pattern as WalkDock's LayerToggles (M-UC1) - isochrone outline/fill,
// basic-need POI pins, and the heatmap_poi grid choropleth (+ its grid_id labels) are
// independent overlays here too, see usecases.js's M-UC2 layer "toggle" keys.
function LayerToggles({ showIsochrone, onToggleIsochrone, showPoi, onTogglePoi, showHeatmap, onToggleHeatmap }) {
  if (!onToggleIsochrone) return null
  const items = [
    { label: "Isochrone", show: showIsochrone, onToggle: onToggleIsochrone },
    { label: "Titik POI", show: showPoi, onToggle: onTogglePoi },
    { label: "Heatmap POI (ikut topik dipilih)", show: showHeatmap, onToggle: onToggleHeatmap },
  ]
  return (
    <div className="section">
      <label>Layer di peta</label>
      <div className="dock-actions" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
        {items.map((it) => (
          <label key={it.label} className="filter-option" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={it.show !== false} onChange={it.onToggle} />
            {it.label}
          </label>
        ))}
      </div>
    </div>
  )
}

function CoverageFlag({ categories }) {
  const missing = CATEGORIES.filter((c) => categories[c].is_desert)
  if (!missing.length) {
    return (
      <p className="note" style={{ color: "#22c55e", fontWeight: 600 }}>
        ✓ Lengkap — semua kebutuhan dasar tersedia dalam jangkauan jalan kaki.
      </p>
    )
  }
  return (
    <p className="note" style={{ color: "#ef4444", fontWeight: 600 }}>
      ✗ Tidak lengkap — {missing.map((c) => CATEGORY_LABELS[c]).join(", ")} tidak tersedia dalam jangkauan jalan kaki.
    </p>
  )
}

function Ringkasan({ station, result, mapMode, onMapMode, radius, ...toggles }) {
  const s = result.summary
  return (
    <>
      <div className="detail-head">
        <h2>{station.name}</h2>
        <p className="note">{station.mode_label}</p>
      </div>

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
      <LayerToggles {...toggles} />

      <div className="section">
        <CoverageFlag categories={s.categories} />
        <p className="note">
          <b>{s.basic_need_poi_reachable}</b> dari {s.basic_need_poi_total} POI kebutuhan dasar
          benar-benar terjangkau jalan kaki ({s.isochrone_area_ha} ha area jangkauan).
        </p>
        <p className="note">Resolusi data: buffer {radius} m dari stasiun (isochrone jaringan jalan), grid 250 m.</p>
      </div>
    </>
  )
}

function Kategori({ categories, ...toggles }) {
  const max = Math.max(...CATEGORIES.map((c) => categories[c].poi_total), 1)
  return (
    <>
      <LayerToggles {...toggles} />
      <div className="section">
      <CoverageFlag categories={categories} />
      {CATEGORIES.map((cat) => {
        const c = categories[cat]
        return (
          <div key={cat} className="criterion">
            <div className="criterion-head" style={{ cursor: "default" }}>
              <span>
                {c.is_desert ? "✗" : "✓"} <span className="dot" style={{ background: CATEGORY_COLORS[cat] }} />
                {CATEGORY_LABELS[cat]}
              </span>
              <span className="bar">
                <span style={{ width: `${(c.poi_total / max) * 100}%`, background: c.is_desert ? "#ef4444" : CATEGORY_COLORS[cat] }} />
              </span>
              <span className="criterion-value">{c.poi_reachable}/{c.poi_total}</span>
            </div>
            {c.is_desert && <p className="note">Tidak ada {CATEGORY_LABELS[cat].toLowerCase()} terjangkau jalan kaki.</p>}
          </div>
        )
      })}
      </div>
    </>
  )
}

function PoiDetail({ props }) {
  return (
    <div className="poi-detail">
      {props.tipe_2 && <p className="note">Jenis: {props.tipe_2}{props.tipe_3 && props.tipe_3 !== "-" ? ` — ${props.tipe_3}` : ""}</p>}
      {props.status && <p className="note">Status: {props.status}</p>}
      {props.alamat && <p className="note">📍 {props.alamat}</p>}
      {props.telepon && <p className="note">📞 {props.telepon}</p>}
      {(props.kecamatan || props.desa) && (
        <p className="note">{[props.desa, props.kecamatan].filter(Boolean).join(", ")}</p>
      )}
    </div>
  )
}

function PoiSearch({ result, categoryFilter, onCategoryFilter, onFocusPoi, onRoutePoi, routingId, ...toggles }) {
  const [q, setQ] = useState("")
  const [expanded, setExpanded] = useState(null)
  const all = result.poi.features
  const byCategory = categoryFilter.length ? all.filter((f) => categoryFilter.includes(f.properties.category)) : all
  const matches = (q.trim()
    ? byCategory.filter((f) => f.properties.name.toLowerCase().includes(q.trim().toLowerCase()))
    : byCategory
  ).slice(0, 30)

  const toggleCategory = (cat) =>
    onCategoryFilter(categoryFilter.includes(cat) ? categoryFilter.filter((c) => c !== cat) : [...categoryFilter, cat])

  return (
    <div className="section">
      <LayerToggles {...toggles} />
      <label>Filter kategori</label>
      <div className="dock-actions">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            className={categoryFilter.includes(cat) ? "mini active" : "mini"}
            onClick={() => toggleCategory(cat)}
            style={categoryFilter.includes(cat) ? { background: CATEGORY_COLORS[cat], borderColor: CATEGORY_COLORS[cat] } : {}}
          >
            {CATEGORY_LABELS[cat]}
          </button>
        ))}
      </div>
      <input
        className="search-input"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Cari dari ${byCategory.length} POI...`}
      />
      <div className="board">
        {matches.length === 0 && <p className="note">Tidak ada POI cocok.</p>}
        {matches.map((f, i) => (
          <div key={i}>
            <div className="board-row" style={{ display: "flex", gap: 6 }}>
              <button
                style={{ flex: 1, textAlign: "left", border: "none", background: "none", cursor: "pointer", padding: 0 }}
                onClick={() => { onFocusPoi(f); setExpanded(expanded === i ? null : i) }}
              >
                <span className="board-name">
                  <span className="dot" style={{ background: CATEGORY_COLORS[f.properties.category] }} />
                  {f.properties.name || "(tanpa nama)"}
                </span>
              </button>
              <button className="mini" onClick={() => onRoutePoi(f, i)} disabled={routingId === i}>
                {routingId === i ? "…" : "Rute"}
              </button>
            </div>
            {expanded === i && <PoiDetail props={f.properties} />}
          </div>
        ))}
        {byCategory.length > 30 && !q.trim() && <p className="note">Menampilkan 30 pertama. Ketik untuk mencari.</p>}
      </div>
    </div>
  )
}

function Bandingkan({ station, result, radius, stations }) {
  const [otherId, setOtherId] = useState("")
  const [other, setOther] = useState(null)
  const [status, setStatus] = useState("")

  async function compare() {
    if (!otherId) return
    setStatus("Menghitung…")
    setOther(null)
    try {
      setOther(await api.amenityEquity(otherId, radius))
      setStatus("")
    } catch (e) {
      setStatus(`Gagal: ${e.message}`)
    }
  }

  return (
    <div className="section">
      <label>Bandingkan dengan stasiun lain</label>
      <select value={otherId} onChange={(e) => setOtherId(e.target.value)}>
        <option value="">— pilih stasiun —</option>
        {stations.filter((s) => s.id !== station.id).map((s) => (
          <option key={s.id} value={s.id}>{s.name} ({s.mode_label})</option>
        ))}
      </select>
      <button className="secondary" onClick={compare} disabled={!otherId}>Bandingkan</button>
      {status && <p className="note">{status}</p>}
      {other && (
        <>
          <p className="note">
            <b>{station.name}</b>: {result.summary.basic_need_poi_reachable}/{result.summary.basic_need_poi_total} POI terjangkau ·{" "}
            <b>{other.summary.basic_need_poi_reachable}/{other.summary.basic_need_poi_total} POI</b> terjangkau di stasiun kedua
          </p>
          {CATEGORIES.map((cat) => (
            <p key={cat} className="note">
              {CATEGORY_LABELS[cat]}: {result.summary.categories[cat].poi_reachable} vs {other.summary.categories[cat].poi_reachable}
            </p>
          ))}
        </>
      )}
    </div>
  )
}

export default function EquityDock({
  open, onToggle, tab, onTab, station, result, radius, stations,
  categoryFilter, onCategoryFilter, onFocusPoi, onRoutePoi, routingId, mapMode, onMapMode,
  showIsochrone, onToggleIsochrone, showPoi, onTogglePoi, showHeatmap, onToggleHeatmap,
}) {
  const toggles = { showIsochrone, onToggleIsochrone, showPoi, onTogglePoi, showHeatmap, onToggleHeatmap }
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
          {tab === "ringkasan" && <Ringkasan station={station} result={result} mapMode={mapMode} onMapMode={onMapMode} radius={radius} {...toggles} />}
          {tab === "kategori" && <Kategori categories={result.summary.categories} {...toggles} />}
          {tab === "poi" && (
            <PoiSearch
              result={result} categoryFilter={categoryFilter} onCategoryFilter={onCategoryFilter}
              onFocusPoi={onFocusPoi} onRoutePoi={onRoutePoi} routingId={routingId}
              {...toggles}
            />
          )}
          {tab === "bandingkan" && <Bandingkan station={station} result={result} radius={radius} stations={stations} />}
        </div>
      </aside>
    </>
  )
}
