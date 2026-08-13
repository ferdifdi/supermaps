import { useCallback, useEffect, useMemo, useState } from "react"
import MapView from "./MapView"
import Chatbot from "./components/Chatbot"
import EquityDock from "./components/EquityDock"
import FilterBar from "./components/FilterBar"
import RightDock from "./components/RightDock"
import { api } from "./api"
import * as equity from "./equity"
import * as tod from "./tod"
import { PERSONAS, USE_CASES } from "./usecases"

const TOD_GROUPS = [
  { key: "modes", label: "Moda", options: tod.MODES },
  { key: "classifications", label: "Klasifikasi", options: tod.CLASSIFICATIONS },
  { key: "typologies", label: "Tipologi", options: tod.TYPOLOGIES },
]
const EQUITY_GROUPS = [
  { key: "modes", label: "Moda", options: tod.MODES },
  { key: "missing_categories", label: "Kategori kosong", options: equity.CATEGORIES },
]

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
  const [dockOpen, setDockOpen] = useState(false)
  const [dockTab, setDockTab] = useState("ringkasan")

  // TOD dashboard (K-UC1)
  const [scopeModes, setScopeModes] = useState(["KRL", "MRT", "LRT"])
  const [todRows, setTodRows] = useState([])
  const [todMeta, setTodMeta] = useState(null)
  const [filters, setFilters] = useState(tod.EMPTY_FILTERS)
  const [filtersFromChat, setFiltersFromChat] = useState(false)
  const [whatIf, setWhatIf] = useState(null)

  // Basic needs dashboard (M-UC2)
  const [equityScopeModes, setEquityScopeModes] = useState(tod.MODES)
  const [equityRadius, setEquityRadius] = useState(equity.DEFAULT_RADIUS)
  const [equityRows, setEquityRows] = useState([])
  const [equityMeta, setEquityMeta] = useState(null)
  const [equityFilters, setEquityFilters] = useState(equity.EMPTY_FILTERS)
  const [equityFiltersFromChat, setEquityFiltersFromChat] = useState(false)
  const [equityDetail, setEquityDetail] = useState(null)
  const [equityDetailStatus, setEquityDetailStatus] = useState("")
  const [poiCategoryFilter, setPoiCategoryFilter] = useState([])
  const [focusPoint, setFocusPoint] = useState(null)

  useEffect(() => {
    api.styles().then((s) => { setStyles(s); setStyleUrl(s[0].url) })
    api.stations().then(setStations)
  }, [])

  const useCase = USE_CASES.find((u) => u.id === useCaseId)
  const isDashboard = Boolean(useCase.dashboard)
  const dashboardType = useCase.dashboardType
  const station = stations.find((s) => s.id === stationId)
  const personaUseCases = USE_CASES.filter((u) => u.persona === persona)

  const visibleTodRows = useMemo(() => tod.applyFilters(todRows, filters), [todRows, filters])
  const visibleEquityRows = useMemo(() => equity.applyFilters(equityRows, equityFilters), [equityRows, equityFilters])

  // Fetch the selected station's real walk-network isochrone whenever it (or the
  // radius) changes - the dashboard table itself is straight-line only (fast, no OSM).
  useEffect(() => {
    if (dashboardType !== "equity" || !stationId) { setEquityDetail(null); setEquityDetailStatus(""); return }
    setEquityDetail(null)
    setEquityDetailStatus("Menghitung isochrone jaringan jalan…")
    api.amenityEquity(stationId, equityRadius)
      .then((d) => { setEquityDetail(d); setEquityDetailStatus("") })
      .catch((e) => setEquityDetailStatus(`Gagal: ${e.message}`))
  }, [dashboardType, stationId, equityRadius])

  // On a dashboard use case the map is fed from the scored rows, not from a per-station run.
  const dashboardResult = useMemo(() => {
    if (dashboardType === "tod") {
      if (!todRows.length) return null
      const visible = new Set(visibleTodRows.map((r) => r.station_id))
      return {
        stations: {
          type: "FeatureCollection",
          features: todRows.map((r) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [r.lon, r.lat] },
            properties: {
              station_id: r.station_id, name: r.station, sci: r.sci, rank: r.rank,
              classification: r.classification, typology: r.typology,
              dimmed: !visible.has(r.station_id), selected: r.station_id === stationId,
            },
          })),
        },
      }
    }
    if (dashboardType === "equity") {
      if (!equityRows.length) return null
      const visible = new Set(visibleEquityRows.map((r) => r.station_id))
      const filteredPoi = equityDetail && poiCategoryFilter.length
        ? { ...equityDetail.poi, features: equityDetail.poi.features.filter((f) => poiCategoryFilter.includes(f.properties.category)) }
        : equityDetail?.poi
      return {
        stations: {
          type: "FeatureCollection",
          features: equityRows.map((r) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [r.lon, r.lat] },
            properties: {
              station_id: r.station_id, name: r.station, basic_need_poi: r.basic_need_poi,
              missing_categories: r.missing_categories.join(", ") || "-",
              missing_count: r.missing_categories.length,
              dimmed: !visible.has(r.station_id), selected: r.station_id === stationId,
            },
          })),
        },
        // Only present once the selected station's isochrone has loaded.
        ...(equityDetail && { isochrone: equityDetail.isochrone, poi: filteredPoi }),
      }
    }
    return null
  }, [dashboardType, todRows, visibleTodRows, equityRows, visibleEquityRows, equityDetail, poiCategoryFilter, stationId])

  async function run() {
    setStatus("Menjalankan analisis…")
    setInsight("")
    try {
      if (dashboardType === "tod") {
        if (!scopeModes.length) return setStatus("Pilih minimal satu moda.")
        setTodRows([])
        const { rows, metadata } = await api.todDashboard(scopeModes.join(","))
        setTodRows(rows)
        setTodMeta(metadata)
        setDockOpen(true)
        setWhatIf(null)
      } else if (dashboardType === "equity") {
        if (!equityScopeModes.length) return setStatus("Pilih minimal satu moda.")
        setEquityRows([])
        const { rows, metadata } = await api.equityDashboard(equityScopeModes.join(","), equityRadius)
        setEquityRows(rows)
        setEquityMeta(metadata)
        setDockOpen(true)
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
    setFocusPoint(null)
    if (isDashboard) {
      setDockTab("detail")
      setDockOpen(true)
    }
  }, [isDashboard])

  async function runWhatIf(id, overrides) {
    if (!Object.keys(overrides).length) return setWhatIf(null)
    setWhatIf(await api.todWhatIf(id, overrides))
  }

  function selectPoi(feature) {
    const [lon, lat] = feature.geometry.coordinates
    setFocusPoint({ lon, lat })
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
          {dashboardType === "tod" && (
            <>
              <label>Cakupan moda</label>
              <div className="mode-toggles">
                {tod.MODES.map((m) => (
                  <label key={m} className="filter-option">
                    <input
                      type="checkbox" checked={scopeModes.includes(m)}
                      onChange={() => setScopeModes((prev) => prev.includes(m) ? prev.filter((v) => v !== m) : [...prev, m])}
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
          )}

          {dashboardType === "equity" && (
            <>
              <label>Cakupan moda</label>
              <div className="mode-toggles">
                {tod.MODES.map((m) => (
                  <label key={m} className="filter-option">
                    <input
                      type="checkbox" checked={equityScopeModes.includes(m)}
                      onChange={() => setEquityScopeModes((prev) => prev.includes(m) ? prev.filter((v) => v !== m) : [...prev, m])}
                    />
                    {m}
                  </label>
                ))}
              </div>
              <label>Radius jangkauan jalan kaki</label>
              <div className="mode-toggles">
                {equity.RADII.map((r) => (
                  <button key={r} className={r === equityRadius ? "mini active" : "mini"} onClick={() => setEquityRadius(r)}>
                    {r} m
                  </button>
                ))}
              </div>
              <input
                type="number" min={equity.MIN_RADIUS} max={equity.MAX_RADIUS} step="50"
                value={equityRadius} onChange={(e) => setEquityRadius(Number(e.target.value))}
                className="search-input"
              />
              <p className="note">
                Dashboard pakai radius garis lurus (cepat). Panel Detail per stasiun pakai isochrone
                jaringan jalan sebenarnya di radius yang sama.
              </p>
            </>
          )}

          {!dashboardType && (
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

        {dashboardType === "tod" && todRows.length > 0 && (
          <div className="section">
            <label>Ringkasan</label>
            <p className="note">{todRows.length} stasiun terhitung.</p>
            <button className="secondary" onClick={() => setDockOpen(true)}>Buka dashboard</button>
          </div>
        )}

        {dashboardType === "equity" && equityRows.length > 0 && (
          <div className="section">
            <label>Ringkasan</label>
            <p className="note">{equityRows.length} stasiun terhitung.</p>
            <button className="secondary" onClick={() => setDockOpen(true)}>Buka dashboard</button>
          </div>
        )}

        {!dashboardType && result?.summary && (
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
            focusPoint={focusPoint}
            result={isDashboard ? dashboardResult : result}
            useCase={useCase}
            onPickStation={selectStation}
          />
        )}

        {dashboardType === "tod" && todRows.length > 0 && (
          <FilterBar
            groups={TOD_GROUPS}
            emptyFilters={tod.EMPTY_FILTERS}
            filters={filters}
            onChange={(f) => { setFilters(f); setFiltersFromChat(false) }}
            fromChat={filtersFromChat}
            matched={visibleTodRows.length}
            total={todRows.length}
          />
        )}

        {dashboardType === "equity" && equityRows.length > 0 && (
          <FilterBar
            groups={EQUITY_GROUPS}
            emptyFilters={equity.EMPTY_FILTERS}
            filters={equityFilters}
            onChange={(f) => { setEquityFilters(f); setEquityFiltersFromChat(false) }}
            fromChat={equityFiltersFromChat}
            matched={visibleEquityRows.length}
            total={equityRows.length}
          />
        )}

        {(isDashboard ? dashboardResult : result) && (
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

        {dashboardType === "tod" && (
          <Chatbot
            key="tod"
            title="Tanya data TOD"
            chatFn={api.chat}
            suggestions={tod.SUGGESTIONS}
            filterKeys={["modes", "classifications", "typologies"]}
            notReadyLabel="Jalankan analisis Indeks TOD dulu agar tabel tersedia."
            ready={todRows.length > 0}
            onFilters={(f) => { setFilters(f); setFiltersFromChat(true) }}
            onFocus={selectStation}
          />
        )}

        {dashboardType === "equity" && (
          <Chatbot
            key="equity"
            title="Tanya data Basic Needs"
            chatFn={api.equityChat}
            suggestions={equity.SUGGESTIONS}
            filterKeys={["modes", "missing_categories"]}
            notReadyLabel="Jalankan analisis Basic Needs dulu agar tabel tersedia."
            ready={equityRows.length > 0}
            onFilters={(f) => { setEquityFilters(f); setEquityFiltersFromChat(true) }}
            onFocus={selectStation}
          />
        )}
      </main>

      {dashboardType === "tod" && (
        <RightDock
          open={dockOpen}
          onToggle={() => setDockOpen((v) => !v)}
          tab={dockTab}
          onTab={setDockTab}
          rows={visibleTodRows}
          allRows={todRows}
          metadata={todMeta}
          selected={stationId}
          onSelect={selectStation}
          whatIf={whatIf}
          onWhatIf={runWhatIf}
        />
      )}

      {dashboardType === "equity" && (
        <EquityDock
          open={dockOpen}
          onToggle={() => setDockOpen((v) => !v)}
          tab={dockTab}
          onTab={setDockTab}
          rows={visibleEquityRows}
          metadata={equityMeta}
          selected={stationId}
          onSelect={selectStation}
          radius={equityRadius}
          onRadius={setEquityRadius}
          detail={equityDetail}
          detailStatus={equityDetailStatus}
          categoryFilter={poiCategoryFilter}
          onCategoryFilter={setPoiCategoryFilter}
          onSelectPoi={selectPoi}
        />
      )}
    </div>
  )
}
