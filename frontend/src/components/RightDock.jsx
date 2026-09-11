import { useState } from "react"
import { CLASS_COLORS, CRITERIA_LABELS } from "../tod"
import QuadrantChart from "./QuadrantChart"
import StationDetail from "./StationDetail"

const TABS = [
  { id: "ringkasan", label: "Ringkasan" },
  { id: "peringkat", label: "Peringkat" },
  { id: "kuadran", label: "Kuadran" },
  { id: "detail", label: "Detail" },
]

function ClassDot({ classification }) {
  return <span className="dot" style={{ background: CLASS_COLORS[classification] }} />
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
          Urut indeks
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
            <th>Indeks TOD</th>
            <th>Tipologi</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.station_id} onClick={() => onSelect(r.station_id)}>
              <td>{r.rank}</td>
              <td>
                <ClassDot classification={r.classification} />
                {r.station}
              </td>
              <td>{r.mode_label}</td>
              <td>{r.sci.toFixed(3)}</td>
              <td>{r.typology}</td>
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
          <p className="note">Resolusi data: buffer {metadata.buffer_m} m dari stasiun.</p>
          {metadata.static_generated_at && Object.keys(metadata.static_generated_at).length > 0 && (
            <p className="note">
              Data statis (backend/data/k-uc1/) digenerate:{" "}
              {Object.entries(metadata.static_generated_at)
                .map(([mode, ts]) => `${mode} ${new Date(ts).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })}`)
                .join(", ")}
              . Moda lain dihitung live.
            </p>
          )}
          <label>Indikator tanpa data terukur</label>
          <ul className="note-list">
            {metadata.no_data.map((d) => (
              <li key={d.indicator}>
                <b>{d.label}</b> — {d.reason}
              </li>
            ))}
          </ul>
          <label>Keterangan sumber</label>
          <ul className="note-list">
            {Object.entries(metadata.sources).map(([k, v]) => (
              <li key={k}>
                <span className={`badge badge-${k.toLowerCase()}`}>{k}</span> {v}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function Leaderboard({ rows, onSelect }) {
  const [end, setEnd] = useState("top")
  const [by, setBy] = useState("sci")
  const [n, setN] = useState(10)

  const value = (r) => (by === "sci" ? r.sci : r.criteria[by])
  const sorted = [...rows].sort((a, b) => value(b) - value(a))
  const shown = end === "top" ? sorted.slice(0, n) : sorted.slice(-n).reverse()
  const max = Math.max(...shown.map(value), 0.0001)

  return (
    <>
      <div className="dock-actions">
        <button className={end === "top" ? "mini active" : "mini"} onClick={() => setEnd("top")}>
          Terbaik
        </button>
        <button className={end === "bottom" ? "mini active" : "mini"} onClick={() => setEnd("bottom")}>
          Terburuk
        </button>
        <select value={n} onChange={(e) => setN(Number(e.target.value))}>
          {[5, 10, 20].map((v) => (
            <option key={v} value={v}>
              Top {v}
            </option>
          ))}
        </select>
      </div>

      <select value={by} onChange={(e) => setBy(e.target.value)}>
        <option value="sci">Indeks TOD keseluruhan</option>
        {Object.entries(CRITERIA_LABELS).map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </select>

      <div className="board">
        {shown.map((r) => (
          <button key={r.station_id} className="board-row" onClick={() => onSelect(r.station_id)}>
            <span className="board-name">
              <ClassDot classification={r.classification} />
              {r.station}
            </span>
            <span className="board-bar">
              <span
                style={{
                  width: `${(value(r) / max) * 100}%`,
                  background: CLASS_COLORS[r.classification],
                }}
              />
            </span>
            <span className="board-value">{value(r).toFixed(3)}</span>
          </button>
        ))}
      </div>
    </>
  )
}

export default function RightDock({
  open, onToggle, tab, onTab, rows, allRows, metadata, selected, onSelect, whatIf, onWhatIf,
}) {
  const row = allRows.find((r) => r.station_id === selected)

  return (
    <>
      <button className={open ? "dock-toggle open" : "dock-toggle"} onClick={onToggle}>
        {open ? "›" : "‹"}
      </button>
      <aside className={open ? "dock open" : "dock"}>
        <div className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={t.id === tab ? "tab active" : "tab"}
              onClick={() => onTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="dock-body">
          {!allRows.length && <p className="note">Jalankan analisis Indeks TOD dulu.</p>}

          {!!allRows.length && tab === "ringkasan" && (
            <Summary rows={rows} metadata={metadata} onSelect={onSelect} />
          )}
          {!!allRows.length && tab === "peringkat" && <Leaderboard rows={rows} onSelect={onSelect} />}
          {!!allRows.length && tab === "kuadran" && (
            <QuadrantChart rows={rows} selected={selected} onSelect={onSelect} />
          )}
          {!!allRows.length && tab === "detail" && (
            <StationDetail row={row} whatIf={whatIf} onWhatIf={onWhatIf} />
          )}
        </div>
      </aside>
    </>
  )
}
