import { useState } from "react"
import { CATEGORIES, CATEGORY_COLORS, CATEGORY_LABELS } from "../equity"

const TABS = [
  { id: "ringkasan", label: "Ringkasan" },
  { id: "peringkat", label: "Peringkat" },
  { id: "kategori", label: "Kategori" },
  { id: "detail", label: "Detail" },
]

function MissingDots({ missing }) {
  if (!missing.length) return <span className="dot" style={{ background: "#0f766e" }} title="Lengkap" />
  return (
    <>
      {missing.map((c) => (
        <span key={c} className="dot" style={{ background: "#ef4444" }} title={`${CATEGORY_LABELS[c]} kosong`} />
      ))}
    </>
  )
}

function Summary({ rows, metadata, onSelect }) {
  const [sort, setSort] = useState("rank")
  const sorted = [...rows].sort((a, b) =>
    sort === "name" ? a.station.localeCompare(b.station) : a.rank - b.rank,
  )

  return (
    <>
      <div className="dock-actions">
        <button className={sort === "rank" ? "mini active" : "mini"} onClick={() => setSort("rank")}>
          Urut terkurang
        </button>
        <button className={sort === "name" ? "mini active" : "mini"} onClick={() => setSort("name")}>
          Urut nama
        </button>
      </div>

      <table className="dock-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Stasiun</th>
            <th>Moda</th>
            <th>Total POI</th>
            <th>Kosong</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.station_id} onClick={() => onSelect(r.station_id)}>
              <td>{r.rank}</td>
              <td>{r.station}</td>
              <td>{r.mode_label}</td>
              <td>{r.basic_need_poi}</td>
              <td><MissingDots missing={r.missing_categories} /></td>
            </tr>
          ))}
        </tbody>
      </table>

      {metadata && <Metadata metadata={metadata} />}
    </>
  )
}

function Metadata({ metadata }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="metadata">
      <button className="mini" onClick={() => setOpen(!open)}>
        {open ? "Sembunyikan" : "Sumber & metode data"}
      </button>
      {open && (
        <>
          <p className="note">{metadata.method}</p>
          <label>Yang tidak terukur</label>
          <ul className="note-list">
            {metadata.no_data.map((d) => (
              <li key={d.indicator}><b>{d.label}</b> — {d.reason}</li>
            ))}
          </ul>
          <label>Keterangan sumber</label>
          <ul className="note-list">
            {Object.entries(metadata.sources).map(([k, v]) => (
              <li key={k}><span className={`badge badge-${k.toLowerCase()}`}>{k}</span> {v}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function Leaderboard({ rows, onSelect }) {
  const [end, setEnd] = useState("bottom")
  const [n, setN] = useState(10)

  const sorted = [...rows].sort((a, b) => b.basic_need_poi - a.basic_need_poi)
  const shown = end === "top" ? sorted.slice(0, n) : sorted.slice(-n).reverse()
  const max = Math.max(...shown.map((r) => r.basic_need_poi), 1)

  return (
    <>
      <div className="dock-actions">
        <button className={end === "bottom" ? "mini active" : "mini"} onClick={() => setEnd("bottom")}>
          Paling kurang
        </button>
        <button className={end === "top" ? "mini active" : "mini"} onClick={() => setEnd("top")}>
          Paling lengkap
        </button>
        <select value={n} onChange={(e) => setN(Number(e.target.value))}>
          {[5, 10, 20].map((v) => <option key={v} value={v}>Top {v}</option>)}
        </select>
      </div>

      <div className="board">
        {shown.map((r) => (
          <button key={r.station_id} className="board-row" onClick={() => onSelect(r.station_id)}>
            <span className="board-name">{r.station}</span>
            <span className="board-bar">
              <span style={{ width: `${(r.basic_need_poi / max) * 100}%`, background: "#0f766e" }} />
            </span>
            <span className="board-value">{r.basic_need_poi}</span>
          </button>
        ))}
      </div>
    </>
  )
}

function KategoriTab({ rows }) {
  return (
    <>
      <p className="note">Jumlah stasiun yang nol POI per kategori, dari {rows.length} stasiun ditampilkan.</p>
      {CATEGORIES.map((cat) => {
        const missing = rows.filter((r) => r.missing_categories.includes(cat))
        const ratio = rows.length ? missing.length / rows.length : 0
        return (
          <div key={cat} className="criterion">
            <div className="criterion-head" style={{ cursor: "default" }}>
              <span>{CATEGORY_LABELS[cat]}</span>
              <span className="bar">
                <span style={{ width: `${ratio * 100}%`, background: CATEGORY_COLORS[cat] }} />
              </span>
              <span className="criterion-value">{missing.length}/{rows.length}</span>
            </div>
          </div>
        )
      })}
    </>
  )
}

function CategoryChips({ active, onToggle }) {
  return (
    <div className="dock-actions">
      {CATEGORIES.map((cat) => (
        <button
          key={cat}
          className={active.includes(cat) ? "mini active" : "mini"}
          onClick={() => onToggle(cat)}
          style={active.includes(cat) ? { background: CATEGORY_COLORS[cat], borderColor: CATEGORY_COLORS[cat] } : {}}
        >
          {CATEGORY_LABELS[cat]}
        </button>
      ))}
    </div>
  )
}

function PoiSearch({ poiFeatures, categoryFilter, onCategoryFilter, onSelectPoi }) {
  const [q, setQ] = useState("")
  if (!poiFeatures) return null
  const all = poiFeatures.features
  const byCategory = categoryFilter.length ? all.filter((f) => categoryFilter.includes(f.properties.category)) : all
  const matches = q.trim()
    ? byCategory.filter((f) => f.properties.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 30)
    : byCategory.slice(0, 30)

  const toggleCategory = (cat) =>
    onCategoryFilter(categoryFilter.includes(cat) ? categoryFilter.filter((c) => c !== cat) : [...categoryFilter, cat])

  return (
    <div className="section">
      <label>Cari & filter POI di stasiun ini</label>
      <CategoryChips active={categoryFilter} onToggle={toggleCategory} />
      <input
        className="search-input"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Cari dari ${byCategory.length} POI...`}
      />
      <div className="board">
        {matches.length === 0 && <p className="note">Tidak ada POI cocok.</p>}
        {matches.map((f, i) => (
          <button key={i} className="board-row" onClick={() => onSelectPoi(f)}>
            <span className="board-name">
              <span className="dot" style={{ background: CATEGORY_COLORS[f.properties.category] }} />
              {f.properties.name || "(tanpa nama)"}
            </span>
            <span className="board-value">
              {f.properties.reachable ? "terjangkau" : "di luar jangkauan"}
            </span>
          </button>
        ))}
        {byCategory.length > 30 && !q.trim() && <p className="note">Menampilkan 30 pertama. Ketik untuk mencari.</p>}
      </div>
    </div>
  )
}

function Detail({ row, radius, onRadius, detail, status, categoryFilter, onCategoryFilter, onSelectPoi }) {
  if (!row) return <p className="note">Pilih stasiun di peta, tabel, atau papan peringkat.</p>

  return (
    <>
      <div className="detail-head">
        <h2>{row.station}</h2>
        <p className="note">{row.mode_label} · peringkat {row.rank} dari total POI</p>
      </div>

      <div className="section">
        <label>Radius jangkauan jalan kaki</label>
        <div className="dock-actions">
          {[100, 200, 300, 400, 500].map((r) => (
            <button key={r} className={r === radius ? "mini active" : "mini"} onClick={() => onRadius(r)}>
              {r} m
            </button>
          ))}
        </div>
        <input
          type="number" min="50" max="2000" step="50" value={radius}
          onChange={(e) => onRadius(Number(e.target.value))}
          className="search-input"
        />
      </div>

      {status && <p className="note">{status}</p>}

      {detail && (
        <>
          <div className="section">
            <label>Ringkasan isochrone {radius} m</label>
            <p className="note">
              {detail.summary.basic_need_poi_reachable} dari {detail.summary.basic_need_poi_total} POI
              benar-benar terjangkau jalan kaki ({detail.summary.isochrone_area_ha} ha area jangkauan).
            </p>
          </div>

          <div className="section">
            <label>Breakdown per kategori</label>
            {CATEGORIES.map((cat) => {
              const c = detail.summary.categories[cat]
              return (
                <div key={cat} className="criterion">
                  <div className="criterion-head" style={{ cursor: "default" }}>
                    <span>
                      <span className="dot" style={{ background: CATEGORY_COLORS[cat] }} />
                      {CATEGORY_LABELS[cat]}
                    </span>
                    <span className="bar">
                      <span
                        style={{
                          width: c.poi_total ? `${(c.poi_reachable / c.poi_total) * 100}%` : "0%",
                          background: c.is_desert ? "#ef4444" : CATEGORY_COLORS[cat],
                        }}
                      />
                    </span>
                    <span className="criterion-value">{c.poi_reachable}/{c.poi_total}</span>
                  </div>
                  {c.is_desert && <p className="note">Tidak ada {CATEGORY_LABELS[cat].toLowerCase()} terjangkau jalan kaki.</p>}
                </div>
              )
            })}
          </div>

          <PoiSearch
            poiFeatures={detail.poi}
            categoryFilter={categoryFilter}
            onCategoryFilter={onCategoryFilter}
            onSelectPoi={onSelectPoi}
          />
        </>
      )}
    </>
  )
}

export default function EquityDock({
  open, onToggle, tab, onTab, rows, metadata, selected, onSelect,
  radius, onRadius, detail, detailStatus, categoryFilter, onCategoryFilter, onSelectPoi,
}) {
  const row = rows.find((r) => r.station_id === selected)

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
          {!rows.length && <p className="note">Jalankan analisis dulu.</p>}
          {!!rows.length && tab === "ringkasan" && <Summary rows={rows} metadata={metadata} onSelect={onSelect} />}
          {!!rows.length && tab === "peringkat" && <Leaderboard rows={rows} onSelect={onSelect} />}
          {!!rows.length && tab === "kategori" && <KategoriTab rows={rows} />}
          {!!rows.length && tab === "detail" && (
            <Detail
              row={row} radius={radius} onRadius={onRadius}
              detail={detail} status={detailStatus}
              categoryFilter={categoryFilter} onCategoryFilter={onCategoryFilter}
              onSelectPoi={onSelectPoi}
            />
          )}
        </div>
      </aside>
    </>
  )
}
