import { useState } from "react"

// One place to keep "what data, what processing" per use case in sync with the code -
// update this alongside usecases.js whenever a data source or scoring step changes.
export default function MethodologyInfo({ methodology }) {
  const [open, setOpen] = useState(false)
  if (!methodology) return null

  return (
    <div className="section">
      <button className="mini" onClick={() => setOpen((v) => !v)}>
        {open ? "Sembunyikan info data & metodologi" : "ℹ Info data & metodologi"}
      </button>
      {open && (
        <div className="methodology">
          <b>Data</b>
          <ul>
            {methodology.data.map((d, i) => (
              <li key={i}><b>{d.source}</b>{d.year ? ` (${d.year})` : ""} — {d.detail}</li>
            ))}
          </ul>
          <b>Pemrosesan</b>
          <ul>
            {methodology.processing.map((p, i) => (
              <li key={i}><b>{p.step}</b> — {p.detail}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
