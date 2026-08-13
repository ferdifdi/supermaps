import { useCallback, useEffect, useMemo, useState } from "react"
import MapView from "./MapView"
import Chatbot from "./components/Chatbot"
import FilterBar from "./components/FilterBar"
import RightDock from "./components/RightDock"
import { api } from "./api"
import { EMPTY_FILTERS, MODES, applyFilters } from "./tod"
import { PERSONAS, USE_CASES } from "./usecases"

export default function App() {
  const [styles, setStyles] = useState([])
  const [styleUrl, setStyleUrl] = useState(null)
  const [stations, setStations] = useState([])
  const [persona, setPersona] = useState("komuter")
  const [useCaseId, setUseCaseId] = useState("M-UC1")
  const [stationId, setStationId] = useState("")
  const [category, setCategory] = useState("menugo")
  const [result, setResult] = useState(null)
  const [insight, setInsight] = useState("")
  const [status, setStatus] = useState("")
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth > 768)

  // TOD dashboard
  const [scopeModes, setScopeModes] = useState(["KRL", "MRT", "LRT"])
  const [todRows, setTodRows] = useState([])
  const [todMeta, setTodMeta] = useState(null)
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [filtersFromChat, setFiltersFromChat] = useState(false)
  const [dockOpen, setDockOpen] = useState(false)
  const [dockTab, setDockTab] = useState("ringkasan")
  const [whatIf, setWhatIf] = useState(null)

  useEffect(() => {
    api.styles().then((s) => { setStyles(s); setStyleUrl(s[0].url) })
    api.stations().then(setStations)
  }, [])

  const useCase = USE_CASES.find((u) => u.id === useCaseId)
  const isDashboard = Boolean(useCase.dashboard)
  const station = stations.find((s) => s.id === stationId)
  const personaUseCases = USE_CASES.filter((u) => u.persona === persona)

  const visibleRows = useMemo(() => applyFilters(todRows, filters), [todRows, filters])

  // On the dashboard the map is fed from the scored rows, not from a per-station analysis run.
  const dashboardResult = useMemo(() => {
    if (!useCase.dashboard || !todRows.length) return null
    const visible = new Set(visibleRows.map((r) => r.station_id))
    return {
      stations: {
        type: "FeatureCollection",
        features: todRows.map((r) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [r.lon, r.lat] },
          properties: {
            station_id: r.station_id,
            name: r.station,
            sci: r.sci,
            rank: r.rank,
            classification: r.classification,
            typology: r.typology,
            dimmed: !visible.has(r.station_id),
            selected: r.station_id === stationId,
          },
        })),
      },
    }
  }, [useCase, todRows, visibleRows, stationId])

  async function run() {
    setStatus("Menjalankan analisis…")
    setInsight("")
    try {
      if (useCase.dashboard) {
        if (!scopeModes.length) return setStatus("Pilih minimal satu moda.")
        setTodRows([])
        const { rows, metadata } = await api.todDashboard(scopeModes.join(","))
        setTodRows(rows)
        setTodMeta(metadata)
        setDockOpen(true)
        setWhatIf(null)
      } else {
        if (!station) return setStatus("Pilih stasiun dulu.")
        setResult(null)
        setResult(await useCase.run(station, { category }))
      }
      setStatus("")
    } catch (e) {
      setStatus(`Gagal: ${e.message}`)
    }
  }

  async function explain() {
    setInsight("Menyusun narasi…")
    try {
      setInsight(await api.insight(useCase.title, persona, result.summary))
    } catch (e) {
      setInsight(`Gagal: ${e.message}`)
    }
  }

  // Stable identity: MapView rebuilds its result layers whenever this callback changes.
  const selectStation = useCallback((id) => {
    setStationId(id)
    if (isDashboard) {
      setDockTab("detail")
      setDockOpen(true)
    }
  }, [isDashboard])

  async function runWhatIf(id, overrides) {
    if (!Object.keys(overrides).length) return setWhatIf(null)
    setWhatIf(await api.todWhatIf(id, overrides))
  }

  return (
    <div className="app">
      <button
        className={sidebarOpen ? "sidebar-toggle open" : "sidebar-toggle"}
        onClick={() => setSidebarOpen((v) => !v)}
      >
        {sidebarOpen ? "‹" : "›"}
      </button>

      <aside className={sidebarOpen ? "sidebar open" : "sidebar"}>
        <header className="brand">
          <h1>SuperMaps</h1>
          <p>Transit Intelligence Jabodetabek</p>
        </header>

        <div className="tabs">
          {PERSONAS.map((p) => (
            <button
              key={p.id}
              className={p.id === persona ? "tab active" : "tab"}
              onClick={() => { setPersona(p.id); setUseCaseId(USE_CASES.find((u) => u.persona === p.id).id); setResult(null) }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="section">
          <label>Use case</label>
          {personaUseCases.map((u) => (
            <button
              key={u.id}
              className={u.id === useCaseId ? "card active" : "card"}
              onClick={() => { setUseCaseId(u.id); setResult(null) }}
            >
              <b>{u.id} — {u.title}</b>
              <span>{u.description}</span>
            </button>
          ))}
        </div>

        <div className="section">
          {useCase.dashboard ? (
            <>
              <label>Cakupan moda</label>
              <div className="mode-toggles">
                {MODES.map((m) => (
                  <label key={m} className="filter-option">
                    <input
                      type="checkbox"
                      checked={scopeModes.includes(m)}
                      onChange={() =>
                        setScopeModes((prev) =>
                          prev.includes(m) ? prev.filter((v) => v !== m) : [...prev, m],
                        )
                      }
                    />
                    {m}
                  </label>
                ))}
              </div>
              {scopeModes.includes("TJ") && (
                <p className="note">Transjakarta punya banyak halte — perhitungan pertama lebih lama.</p>
              )}
              <p className="note">
                Indeks bersifat relatif: setiap stasiun distandardisasi terhadap stasiun lain dalam
                tabel yang sama.
              </p>
            </>
          ) : (
            <>
              <label>Stasiun</label>
              <select value={stationId} onChange={(e) => setStationId(e.target.value)}>
                <option value="">— pilih stasiun —</option>
                {stations.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({s.mode_label})</option>
                ))}
              </select>
              {useCase.options?.category && (
                <>
                  <label>Kategori data Mapid</label>
                  <select value={category} onChange={(e) => setCategory(e.target.value)}>
                    {useCase.options.category.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </>
              )}
            </>
          )}
          <button className="primary" onClick={run}>Jalankan analisis</button>
          {status && <p className="note">{status}</p>}
        </div>

        {useCase.dashboard && todRows.length > 0 && (
          <div className="section">
            <label>Ringkasan</label>
            <p className="note">{todRows.length} stasiun terhitung.</p>
            <button className="secondary" onClick={() => setDockOpen(true)}>Buka dashboard</button>
          </div>
        )}

        {!useCase.dashboard && result?.summary && (
          <div className="section">
            <label>Ringkasan</label>
            <pre className="summary">{JSON.stringify(result.summary, null, 2)}</pre>
            <button className="secondary" onClick={explain}>Jelaskan dengan AI</button>
            {insight && <p className="insight">{insight}</p>}
          </div>
        )}

        <div className="section">
          <label>Basemap MAPID</label>
          <select value={styleUrl || ""} onChange={(e) => setStyleUrl(e.target.value)}>
            {styles.map((s) => <option key={s.name} value={s.url}>{s.name}</option>)}
          </select>
        </div>
      </aside>

      <main className="main">
        {styleUrl && (
          <MapView
            styleUrl={styleUrl}
            stations={stations}
            activeStation={station}
            result={useCase.dashboard ? dashboardResult : result}
            useCase={useCase}
            onPickStation={selectStation}
          />
        )}

        {useCase.dashboard && todRows.length > 0 && (
          <FilterBar
            filters={filters}
            onChange={(f) => { setFilters(f); setFiltersFromChat(false) }}
            fromChat={filtersFromChat}
            matched={visibleRows.length}
            total={todRows.length}
          />
        )}

        {(useCase.dashboard ? dashboardResult : result) && (
          <div className="legend">
            <b>{useCase.legend.title}</b>
            {useCase.legend.stops.map(([value, color]) => (
              <div key={value} className="legend-row">
                <span className="swatch" style={{ background: color }} />
                {value}
              </div>
            ))}
          </div>
        )}

        <Chatbot
          ready={todRows.length > 0}
          onFilters={(f) => { setFilters(f); setFiltersFromChat(true) }}
          onFocus={selectStation}
        />
      </main>

      {useCase.dashboard && (
        <RightDock
          open={dockOpen}
          onToggle={() => setDockOpen((v) => !v)}
          tab={dockTab}
          onTab={setDockTab}
          rows={visibleRows}
          allRows={todRows}
          metadata={todMeta}
          selected={stationId}
          onSelect={selectStation}
          whatIf={whatIf}
          onWhatIf={runWhatIf}
        />
      )}
    </div>
  )
}
