import { useState } from "react"
import { api } from "../api"
import { CATEGORY_COLORS } from "../equity"

const CATEGORIES = ["pangan", "minimarket", "kesehatan"]
const CATEGORY_LABELS = { pangan: "Pangan & kuliner", minimarket: "Minimarket & toko", kesehatan: "Kesehatan" }

const TABS = [
  { id: "ringkasan", label: "Ringkasan" },
  { id: "kategori", label: "Kategori" },
  { id: "poi", label: "Cari POI" },
  { id: "bandingkan", label: "Bandingkan" },
]

function Ringkasan({ station, result }) {
  const s = result.summary
  return (
    <>
      <div className="detail-head">
        <h2>{station.name}</h2>
        <p className="note">{station.mode_label}</p>
      </div>
      <div className="section">
        <p className="note">
          <b>{s.basic_need_poi_reachable}</b> dari {s.basic_need_poi_total} POI kebutuhan dasar
          benar-benar terjangkau jalan kaki ({s.isochrone_area_ha} ha area jangkauan).
        </p>
      </div>
    </>
  )
}

function Kategori({ categories }) {
  const max = Math.max(...CATEGORIES.map((c) => categories[c].poi_total), 1)
  return (
    <div className="section">
      {CATEGORIES.map((cat) => {
        const c = categories[cat]
        return (
          <div key={cat} className="criterion">
            <div className="criterion-head" style={{ cursor: "default" }}>
              <span>
                <span className="dot" style={{ background: CATEGORY_COLORS[cat] }} />
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
  )
}

function PoiSearch({ result, categoryFilter, onCategoryFilter, onFocusPoi, onRoutePoi, routingId }) {
  const [q, setQ] = useState("")
  const all = result.poi.features
  const byCategory = categoryFilter.length ? all.filter((f) => categoryFilter.includes(f.properties.category)) : all
  const matches = q.trim()
    ? byCategory.filter((f) => f.properties.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 30)
    : byCategory.slice(0, 30)

  const toggleCategory = (cat) =>
    onCategoryFilter(categoryFilter.includes(cat) ? categoryFilter.filter((c) => c !== cat) : [...categoryFilter, cat])

  return (
    <div className="section">
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
          <div key={i} className="board-row" style={{ display: "flex", gap: 6 }}>
            <button style={{ flex: 1, textAlign: "left", border: "none", background: "none", cursor: "pointer", padding: 0 }} onClick={() => onFocusPoi(f)}>
              <span className="board-name">
                <span className="dot" style={{ background: CATEGORY_COLORS[f.properties.category] }} />
                {f.properties.name || "(tanpa nama)"}
              </span>
            </button>
            <button className="mini" onClick={() => onRoutePoi(f, i)} disabled={routingId === i}>
              {routingId === i ? "…" : "Rute"}
            </button>
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
  categoryFilter, onCategoryFilter, onFocusPoi, onRoutePoi, routingId,
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
          {tab === "ringkasan" && <Ringkasan station={station} result={result} />}
          {tab === "kategori" && <Kategori categories={result.summary.categories} />}
          {tab === "poi" && (
            <PoiSearch
              result={result} categoryFilter={categoryFilter} onCategoryFilter={onCategoryFilter}
              onFocusPoi={onFocusPoi} onRoutePoi={onRoutePoi} routingId={routingId}
            />
          )}
          {tab === "bandingkan" && <Bandingkan station={station} result={result} radius={radius} stations={stations} />}
        </div>
      </aside>
    </>
  )
}
