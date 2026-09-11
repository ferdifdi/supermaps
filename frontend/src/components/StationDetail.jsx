import { useEffect, useState } from "react"
import { CLASS_COLORS, CRITERIA_LABELS } from "../tod"

function Badge({ source }) {
  if (source === "OSM") return null
  return <span className={`badge badge-${source.toLowerCase()}`}>{source}</span>
}

function Criterion({ name, score, priorities }) {
  const [open, setOpen] = useState(false)
  const parts = priorities.filter((p) => p.criterion === name)

  return (
    <div className="criterion">
      <button className="criterion-head" onClick={() => setOpen(!open)}>
        <span>
          {open ? "▾" : "▸"} {CRITERIA_LABELS[name]}
        </span>
        <span className="bar">
          <span style={{ width: `${score * 100}%` }} />
        </span>
        <span className="criterion-value">{score.toFixed(2)}</span>
      </button>
      {open && (
        <div className="criterion-body">
          {parts.map((p) => (
            <div key={p.indicator} className="indicator-row">
              <span>
                {p.label} <Badge source={p.source} />
              </span>
              <span className="bar small">
                <span style={{ width: `${p.score * 100}%` }} />
              </span>
              <span className="criterion-value">{p.score.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function WhatIf({ row, whatIf, onWhatIf }) {
  const top = row.priorities.slice(0, 5)
  const [overrides, setOverrides] = useState({})

  useEffect(() => setOverrides({}), [row.station_id])

  const set = (indicator, value) => {
    const next = { ...overrides, [indicator]: value }
    setOverrides(next)
    onWhatIf(row.station_id, next)
  }

  return (
    <div className="section">
      <label>Simulasi what-if</label>
      <p className="note">
        Geser skor indikator ke target yang diinginkan untuk melihat proyeksi indeks TOD dan peringkat.
      </p>
      {top.map((p) => (
        <div key={p.indicator} className="slider-row">
          <span>
            {p.label} <Badge source={p.source} />
          </span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={overrides[p.indicator] ?? p.score}
            onChange={(e) => set(p.indicator, Number(e.target.value))}
          />
          <span className="criterion-value">{(overrides[p.indicator] ?? p.score).toFixed(2)}</span>
        </div>
      ))}
      {whatIf && whatIf.station === row.station && (
        <p className="whatif">
          Indeks TOD {whatIf.sci_before} → <b>{whatIf.sci_after}</b> ({whatIf.delta >= 0 ? "+" : ""}
          {whatIf.delta}), peringkat {whatIf.rank_before} → <b>{whatIf.rank_after}</b>
        </p>
      )}
      {Object.keys(overrides).length > 0 && (
        <button className="mini" onClick={() => { setOverrides({}); onWhatIf(row.station_id, {}) }}>
          Reset simulasi
        </button>
      )}
    </div>
  )
}

export default function StationDetail({ row, whatIf, onWhatIf }) {
  if (!row) return <p className="note">Pilih stasiun di peta, tabel, atau papan peringkat.</p>

  return (
    <>
      <div className="detail-head">
        <h2>{row.station}</h2>
        <p className="note">
          {row.mode_label} · peringkat {row.rank} ·{" "}
          <span className="dot" style={{ background: CLASS_COLORS[row.classification] }} />
          klasifikasi {row.classification}
        </p>
        <div className="sci">{row.sci.toFixed(3)}</div>
      </div>

      <div className="section">
        <label>Rekomendasi tipologi pengembangan</label>
        <div className="card">
          <b>{row.typology}</b>
          <span>{row.typology_reason}</span>
        </div>
      </div>

      <div className="section">
        <label>Rincian skor per kriteria</label>
        {Object.entries(row.criteria).map(([name, score]) => (
          <Criterion key={name} name={name} score={score} priorities={row.priorities} />
        ))}
      </div>

      <div className="section">
        <label>Prioritas perbaikan</label>
        <p className="note">Diurutkan dari kenaikan indeks TOD terbesar bila indikator dibawa ke skor 1.</p>
        {row.priorities.slice(0, 6).map((p) => (
          <div key={p.indicator} className="priority">
            <span>
              {p.label} <Badge source={p.source} />
            </span>
            <span className="criterion-value">
              {p.score.toFixed(2)} · +{p.potential_gain.toFixed(3)}
            </span>
          </div>
        ))}
      </div>

      <WhatIf row={row} whatIf={whatIf} onWhatIf={onWhatIf} />
    </>
  )
}
