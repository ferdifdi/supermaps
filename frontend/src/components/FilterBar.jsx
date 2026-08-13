import { useState } from "react"
import { CLASSIFICATIONS, EMPTY_FILTERS, MODES, TYPOLOGIES } from "../tod"

const GROUPS = [
  { key: "modes", label: "Moda", options: MODES },
  { key: "classifications", label: "Klasifikasi", options: CLASSIFICATIONS },
  { key: "typologies", label: "Tipologi", options: TYPOLOGIES },
]

export default function FilterBar({ filters, onChange, fromChat, matched, total }) {
  const [open, setOpen] = useState(null)

  const toggle = (key, value) => {
    const current = filters[key]
    onChange({
      ...filters,
      [key]: current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
    })
  }

  const chips = GROUPS.flatMap(({ key, options }) =>
    filters[key].filter((v) => options.includes(v)).map((v) => ({ key, value: v })),
  )

  return (
    <div className="filterbar">
      <div className="filterbar-row">
        {GROUPS.map(({ key, label, options }) => (
          <div key={key} className="filter-group">
            <button
              className={filters[key].length ? "filter-btn active" : "filter-btn"}
              onClick={() => setOpen(open === key ? null : key)}
            >
              {label}
              {filters[key].length > 0 && ` (${filters[key].length})`} ▾
            </button>
            {open === key && (
              <div className="filter-menu">
                {options.map((o) => (
                  <label key={o} className="filter-option">
                    <input
                      type="checkbox"
                      checked={filters[key].includes(o)}
                      onChange={() => toggle(key, o)}
                    />
                    {o}
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}

        <span className="filter-count">
          {matched} dari {total} stasiun
        </span>

        {chips.length > 0 && (
          <button className="filter-reset" onClick={() => onChange(EMPTY_FILTERS)}>
            Reset
          </button>
        )}
      </div>

      {chips.length > 0 && (
        <div className="filterbar-row">
          {chips.map(({ key, value }) => (
            <button key={`${key}-${value}`} className="chip" onClick={() => toggle(key, value)}>
              {value} ×
            </button>
          ))}
          {fromChat && <span className="chip-note">difilter oleh chat</span>}
        </div>
      )}
    </div>
  )
}
