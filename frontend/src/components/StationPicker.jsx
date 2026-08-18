import { useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"

const MODES = ["KRL", "MRT", "LRT", "TJ"]

export default function StationPicker({ stations, value, onChange }) {
  const [mode, setMode] = useState("")
  const [tjStations, setTjStations] = useState(null)
  const [tjLoading, setTjLoading] = useState(false)
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef(null)

  useEffect(() => {
    if (mode !== "TJ" || tjStations !== null) return
    setTjLoading(true)
    api.stations("TJ").then((data) => {
      setTjStations(data)
      setTjLoading(false)
    })
  }, [mode, tjStations])

  const pool = useMemo(() => {
    if (mode === "TJ") return tjStations || []
    if (mode) return stations.filter((s) => s.mode_label === mode)
    return stations
  }, [stations, tjStations, mode])

  const selected =
    (mode === "TJ" ? tjStations : stations)?.find((s) => s.id === value) ||
    stations.find((s) => s.id === value) ||
    null

  useEffect(() => {
    function onClickOutside(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener("mousedown", onClickOutside)
    return () => document.removeEventListener("mousedown", onClickOutside)
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return pool
    return pool.filter((s) => s.name.toLowerCase().includes(q))
  }, [pool, query])

  function pick(station) {
    onChange(station.id)
    setQuery("")
    setOpen(false)
  }

  function onKeyDown(e) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      setOpen(true)
      return
    }
    if (!open) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, filtered.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (filtered[highlight]) pick(filtered[highlight])
    } else if (e.key === "Escape") {
      setOpen(false)
    }
  }

  return (
    <div className="station-picker" ref={rootRef}>
      <select
        value={mode}
        onChange={(e) => {
          setMode(e.target.value)
          setQuery("")
          setHighlight(0)
        }}
      >
        <option value="">Semua moda</option>
        {MODES.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
      <input
        className="search-input"
        type="text"
        placeholder={tjLoading ? "Memuat halte TJ..." : "Cari nama stasiun/halte..."}
        disabled={tjLoading}
        value={open ? query : selected ? `${selected.name} (${selected.mode_label})` : ""}
        onFocus={() => {
          setOpen(true)
          setQuery("")
          setHighlight(0)
        }}
        onChange={(e) => {
          setQuery(e.target.value)
          setHighlight(0)
        }}
        onKeyDown={onKeyDown}
      />
      {open && !tjLoading && (
        <div className="station-picker-list">
          {filtered.length === 0 && <div className="station-picker-empty">Tidak ada hasil</div>}
          {filtered.slice(0, 200).map((s, i) => (
            <div
              key={s.id}
              className={`station-picker-item${i === highlight ? " active" : ""}${s.id === value ? " selected" : ""}`}
              onMouseDown={() => pick(s)}
              onMouseEnter={() => setHighlight(i)}
            >
              {s.name} <span>({s.mode_label})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
