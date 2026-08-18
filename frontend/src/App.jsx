import { useCallback, useEffect, useMemo, useState } from "react"
import MapView from "./MapView"
import AiDock from "./components/AiDock"
import Chatbot from "./components/Chatbot"
import EquityDock from "./components/EquityDock"
import FilterBar from "./components/FilterBar"
import MethodologyInfo from "./components/MethodologyInfo"
import RightDock from "./components/RightDock"
import ResilienceDock from "./components/ResilienceDock"
import RoleSelect from "./components/RoleSelect"
import SiteDock from "./components/SiteDock"
import StationPicker from "./components/StationPicker"
import WalkDock from "./components/WalkDock"
import { api } from "./api"
import * as equity from "./equity"
import * as tod from "./tod"
import { USE_CASES } from "./usecases"

const TOD_GROUPS = [
  { key: "modes", label: "Moda", options: tod.MODES },
  { key: "classifications", label: "Klasifikasi", options: tod.CLASSIFICATIONS },
  { key: "typologies", label: "Tipologi", options: tod.TYPOLOGIES },
]

export default function App() {
  const [roleChosen, setRoleChosen] = useState(false)
  const [styles, setStyles] = useState([])
  const [styleUrl, setStyleUrl] = useState(null)
  const [stations, setStations] = useState([])
  const [persona, setPersona] = useState("komuter")
  const [useCaseId, setUseCaseId] = useState("M-UC1")
  const [stationId, setStationId] = useState("")
  const [category, setCategory] = useState("APOTEK")
  const [subtype, setSubtype] = useState("")
  const [subtypeOptions, setSubtypeOptions] = useState([])
  const [radius, setRadius] = useState(800)
  const [useInarisk, setUseInarisk] = useState(true)
  const [result, setResult] = useState(null)
  const [insight, setInsight] = useState("")
  const [status, setStatus] = useState("")
  const [loading, setLoading] = useState(false)
  const [loadingSeconds, setLoadingSeconds] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  // Mobile: a Gojek-style bottom sheet with three switchable sections instead of the
  // desktop's separate side sidebar + side dock. "analisis" reuses .sidebar, "hasil"/"ai"
  // both reuse .dock (real per-use-case dock vs AiDock, mutually exclusive) - same
  // components, just repositioned/resized by CSS at the mobile breakpoint. Desktop reuses
  // this same state to pick Hasil vs AI inside the dock (sidebar stays independently
  // toggleable there via sidebarOpen).
  const [resultView, setResultView] = useState("analisis")
  const [sheetSnap, setSheetSnap] = useState("half") // "peek" | "half" | "full"

  // TOD dashboard (K-UC1)
  const [scopeMode, setScopeMode] = useState("KRL")
  const [todRows, setTodRows] = useState([])
  const [todMeta, setTodMeta] = useState(null)
  const [filters, setFilters] = useState(tod.EMPTY_FILTERS)
  const [filtersFromChat, setFiltersFromChat] = useState(false)
  const [dockOpen, setDockOpen] = useState(false)
  const [dockTab, setDockTab] = useState("ringkasan")
  const [whatIf, setWhatIf] = useState(null)

  // M-UC2 extras (POI search/filter, compare, route)
  const [poiCategoryFilter, setPoiCategoryFilter] = useState([])
  const [focusPoint, setFocusPoint] = useState(null)
  const [routeResult, setRouteResult] = useState(null)
  const [routingId, setRoutingId] = useState(null)
  const [mapMode, setMapMode] = useState("isochrone")

  // M-UC1 extras (route preference, click-to-pick destination, route stats)
  const [routePreference, setRoutePreference] = useState("fast")
  const [picking, setPicking] = useState(false)
  const [routeStatus, setRouteStatus] = useState("")
  const [routeStats, setRouteStats] = useState(null)
  const [greenRoutingId, setGreenRoutingId] = useState(null)

  useEffect(() => {
    api.styles().then((s) => { setStyles(s); setStyleUrl(s[0].url) })
    api.stations().then(setStations)
  }, [])

  // Loading feedback (Shneiderman: informative feedback) - ticks every second while an
  // analysis runs so the wait isn't a silent freeze, alongside expectedWait per use case.
  useEffect(() => {
    if (!loading) return
    setLoadingSeconds(0)
    const id = setInterval(() => setLoadingSeconds((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [loading])

  // U-UC1: some business types (MAKANAN DAN MINUMAN, PERDAGANGAN DAN RETAIL) have a
  // TIPE_2 subcategory in MAPID's data - fetch it whenever the category changes so the
  // subtype dropdown only shows options that actually exist for this category.
  useEffect(() => {
    setSubtype("")
    if (useCaseId !== "U-UC1") return setSubtypeOptions([])
    api.businessSubtypes(category).then(setSubtypeOptions)
  }, [category, useCaseId])

  const useCase = USE_CASES.find((u) => u.id === useCaseId)
  const isDashboard = Boolean(useCase.dashboard)
  const station = stations.find((s) => s.id === stationId)
  const personaUseCases = USE_CASES.filter((u) => u.persona === persona)

  const visibleRows = useMemo(() => tod.applyFilters(todRows, filters), [todRows, filters])

  // Stable reference (not recreated every render) - AiPanel resets its chat whenever
  // this changes, so a fresh object each render would wipe the conversation constantly.
  const aiDashboardResult = useMemo(
    () => (todRows.length ? { stations: todRows.slice(0, 30) } : null),
    [todRows],
  )

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

  // M-UC2's POI category filter thins what the map shows too, and the route (if any) is
  // fetched separately from the base analysis, so both get merged in here for MapView.
  // The isochrone outline also carries a "complete" flag so its color still shows
  // coverage status even in the heatmap modes, where the fill is hidden.
  const mapResult = useMemo(() => {
    if (useCase.extras === "walk") return result ? { ...result, ...(routeResult && { route: routeResult }) } : result
    if (useCase.extras !== "equity" || !result) return result
    const poi = poiCategoryFilter.length
      ? { ...result.poi, features: result.poi.features.filter((f) => poiCategoryFilter.includes(f.properties.category)) }
      : result.poi
    const complete = equity.CATEGORIES.every((c) => !result.summary.categories[c].is_desert)
    const isochrone = {
      ...result.isochrone,
      features: result.isochrone.features.map((f) => ({ ...f, properties: { ...f.properties, complete } })),
    }
    return { ...result, poi, isochrone, ...(routeResult && { route: routeResult }) }
  }, [useCase, result, poiCategoryFilter, routeResult])

  async function run() {
    setStatus("")
    setLoading(true)
    setInsight("")
    try {
      if (useCase.dashboard) {
        setTodRows([])
        const { rows, metadata } = await api.todDashboard(scopeMode)
        setTodRows(rows)
        setTodMeta(metadata)
        setDockOpen(true)
        setResultView("hasil")
        setWhatIf(null)
      } else {
        if (!station) { setLoading(false); return setStatus("Pilih stasiun dulu.") }
        setResult(null)
        setPoiCategoryFilter([])
        setFocusPoint(null)
        setRouteResult(null)
        setRouteStats(null)
        setPicking(false)
        setResult(await useCase.run(station, { category, businessType: category, subtype, radius, useInarisk }))
        if (["equity", "walk", "site", "resilience"].includes(useCase.extras)) {
          setDockTab("ringkasan"); setDockOpen(true); setResultView("hasil")
        }
      }
      setStatus("")
    } catch (e) {
      setStatus(`Gagal: ${e.message}`)
    }
    setLoading(false)
  }

  async function explain() {
    setInsight("Menyusun narasi…")
    try {
      setInsight(await api.insight(useCase.title, persona, result.summary))
    } catch (e) {
      setInsight(`Gagal: ${e.message}`)
    }
  }

  async function routeToPoi(feature, index) {
    setRoutingId(index)
    try {
      const [lon, lat] = feature.geometry.coordinates
      const data = await api.route(stationId, lon, lat, "fast")
      setRouteResult(data.route)
    } catch (e) {
      setStatus(`Gagal ambil rute: ${e.message}`)
    }
    setRoutingId(null)
  }

  async function pickDestination({ lon, lat }) {
    setPicking(false)
    setRouteStatus("Menghitung rute…")
    setRouteResult(null)
    setRouteStats(null)
    try {
      const data = await api.route(stationId, lon, lat, routePreference)
      setRouteResult(data.route)
      setRouteStats(data.summary)
      setRouteStatus("")
    } catch (e) {
      setRouteStatus(`Gagal ambil rute: ${e.message}`)
    }
  }

  function focusTransferPoint(feature) {
    const [lon, lat] = feature.geometry.coordinates
    setFocusPoint({ lon, lat })
  }

  function focusPolygon(feature) {
    const ring = feature.geometry.type === "Polygon" ? feature.geometry.coordinates[0] : feature.geometry.coordinates[0][0]
    const [lon, lat] = ring[0]
    setFocusPoint({ lon, lat })
  }

  async function routeToGreenPoi(feature, index) {
    setGreenRoutingId(index)
    const [lon, lat] = feature.geometry.coordinates
    await pickDestination({ lon, lat })
    setGreenRoutingId(null)
    setDockTab("rute")
  }

  // Mobile bottom sheet drag: --sheet-h lives on the root element so both .sidebar and
  // .dock (siblings, not nested) can read it - only one is "open" at a time per
  // resultView, so there's never a conflict over whose height it's driving.
  // "full" caps at 90vh, not 100 - leaves a gap at the top so the sheet never covers a
  // notch/dynamic island. "peek" is the lowest drag-down goes (handle+tabs stay visible
  // and grabbable, can't collapse to 0 or there'd be nothing left to drag back up with).
  const SHEET_SNAP_VH = { peek: 10, half: 50, full: 90 }

  function startSheetDrag(e) {
    const startY = e.touches ? e.touches[0].clientY : e.clientY
    const startVh = SHEET_SNAP_VH[sheetSnap]
    const root = document.documentElement

    function move(ev) {
      const y = ev.touches ? ev.touches[0].clientY : ev.clientY
      const vh = Math.min(90, Math.max(8, startVh + ((startY - y) / window.innerHeight) * 100))
      root.style.setProperty("--sheet-h", `${vh}vh`)
    }
    function end(ev) {
      const y = ev.changedTouches ? ev.changedTouches[0].clientY : ev.clientY
      const vh = startVh + ((startY - y) / window.innerHeight) * 100
      const nearest = Object.entries(SHEET_SNAP_VH).reduce(
        (best, [k, v]) => (Math.abs(v - vh) < Math.abs(SHEET_SNAP_VH[best] - vh) ? k : best), "half",
      )
      setSheetSnap(nearest)
      root.style.removeProperty("--sheet-h")
      document.removeEventListener("mousemove", move)
      document.removeEventListener("mouseup", end)
      document.removeEventListener("touchmove", move)
      document.removeEventListener("touchend", end)
    }
    document.addEventListener("mousemove", move)
    document.addEventListener("mouseup", end)
    document.addEventListener("touchmove", move, { passive: true })
    document.addEventListener("touchend", end)
  }

  // Stable identity: MapView rebuilds its result layers whenever this callback changes.
  const selectStation = useCallback((id) => {
    setStationId(id)
    if (isDashboard) {
      setDockTab("detail")
      setDockOpen(true)
      setResultView("hasil")
    }
  }, [isDashboard])

  async function runWhatIf(id, overrides) {
    if (!Object.keys(overrides).length) return setWhatIf(null)
    setWhatIf(await api.todWhatIf(id, overrides))
  }

  if (!roleChosen) {
    return (
      <RoleSelect
        onSelect={(id) => {
          setPersona(id)
          setUseCaseId(USE_CASES.find((u) => u.persona === id).id)
          setResult(null)
          setRoleChosen(true)
        }}
      />
    )
  }

  return (
    <div className={`app mobile-${resultView}`}>
      <button
        className={sidebarOpen ? "sidebar-toggle open" : "sidebar-toggle"}
        onClick={() => setSidebarOpen((v) => !v)}
      >
        {sidebarOpen ? "‹" : "›"}
      </button>

      <button className="panel-back" onClick={() => setRoleChosen(false)} title="Kembali" aria-label="Kembali">
        ←
      </button>

      <div className="sheet-bar">
        <div className="sheet-handle" onMouseDown={startSheetDrag} onTouchStart={startSheetDrag} />
        <div className="sheet-tabs">
          <button
            className={resultView === "analisis" ? "sheet-tab active" : "sheet-tab"}
            onClick={() => { setResultView("analisis"); setSidebarOpen(true) }}
          >
            Analisis
          </button>
          <button
            className={resultView === "hasil" ? "sheet-tab active" : "sheet-tab"}
            onClick={() => { setResultView("hasil"); setDockOpen(true) }}
          >
            Hasil
          </button>
          <button
            className={resultView === "ai" ? "sheet-tab active" : "sheet-tab"}
            onClick={() => { setResultView("ai"); setDockOpen(true) }}
          >
            AI
          </button>
        </div>
      </div>

      <aside className={sidebarOpen ? "sidebar open" : "sidebar"}>

        <div className="section">
          <label>Use case</label>
          {personaUseCases.map((u) => (
            <button
              key={u.id}
              className={u.id === useCaseId ? "card active" : "card"}
              onClick={() => {
                setUseCaseId(u.id); setResult(null)
                setMapMode(u.layers?.find((l) => l.mode)?.mode || "isochrone")
              }}
            >
              <b>{u.id} — {u.title}</b>
              <span>{u.description}</span>
            </button>
          ))}
        </div>

        <MethodologyInfo methodology={useCase.methodology} />

        <div className="section">
          {useCase.dashboard ? (
            <>
              <label>Cakupan moda</label>
              <div className="mode-toggles">
                {tod.MODES.map((m) => (
                  <label key={m} className="filter-option">
                    <input
                      type="radio"
                      name="scope-mode"
                      checked={scopeMode === m}
                      onChange={() => setScopeMode(m)}
                    />
                    {m}
                  </label>
                ))}
              </div>
              <p className="note">Satu moda per analisis - gabungan beberapa moda (terutama TJ, halte-nya banyak) bikin Overpass lambat.</p>
              {scopeMode === "TJ" && (
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
              <StationPicker stations={stations} value={stationId} onChange={setStationId} />
              {useCase.options?.businessType && (
                <>
                  <label>Tipe bisnis yang mau dibangun</label>
                  <select value={category} onChange={(e) => setCategory(e.target.value)}>
                    {useCase.options.businessType.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  {subtypeOptions.length > 0 && (
                    <>
                      <label>Sub-tipe</label>
                      <select value={subtype} onChange={(e) => setSubtype(e.target.value)}>
                        <option value="">— semua sub-tipe —</option>
                        {subtypeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </>
                  )}
                </>
              )}
              {useCase.options?.radius && (
                <>
                  <label>Radius jangkauan jalan kaki</label>
                  <div className="mode-toggles">
                    {useCase.options.radius.map((r) => (
                      <button key={r} className={r === radius ? "mini active" : "mini"} onClick={() => setRadius(r)}>
                        {r} m
                      </button>
                    ))}
                  </div>
                </>
              )}
              {useCase.options?.dataSource && (
                <>
                  <label>Sumber data risiko</label>
                  <div className="mode-toggles">
                    {useCase.options.dataSource.map((opt) => (
                      <label key={String(opt.id)} className="filter-option">
                        <input
                          type="radio"
                          name="data-source"
                          checked={useInarisk === opt.id}
                          onChange={() => setUseInarisk(opt.id)}
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
          <button className="primary" onClick={run} disabled={loading}>Jalankan analisis</button>
          {loading && (
            <div className="loading-status">
              <span className="spinner" />
              <span className="loading-text">
                <b>Menjalankan analisis… {loadingSeconds}s</b>
                {useCase.expectedWait && <span className="note">Perkiraan: {useCase.expectedWait}</span>}
              </span>
            </div>
          )}
          {!loading && status && <p className="note">{status}</p>}
        </div>

        {useCase.dashboard && todRows.length > 0 && (
          <div className="section">
            <label>Ringkasan</label>
            <p className="note">{todRows.length} stasiun terhitung.</p>
            <button className="secondary" onClick={() => { setDockOpen(true); setResultView("hasil") }}>Buka dashboard</button>
          </div>
        )}

        {!useCase.dashboard && !["equity", "walk", "site", "resilience"].includes(useCase.extras) && result?.summary && (
          <div className="section">
            <label>Ringkasan</label>
            <pre className="summary">{JSON.stringify(result.summary, null, 2)}</pre>
            <button className="secondary" onClick={explain}>Jelaskan dengan AI</button>
            {insight && <p className="insight">{insight}</p>}
          </div>
        )}

        {["equity", "walk", "site", "resilience"].includes(useCase.extras) && result && (
          <div className="section">
            <button className="secondary" onClick={() => { setDockOpen(true); setResultView("hasil") }}>Buka panel detail</button>
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
            result={useCase.dashboard ? dashboardResult : mapResult}
            useCase={useCase}
            mapMode={mapMode}
            onPickStation={selectStation}
            picking={picking}
            onMapPick={pickDestination}
          />
        )}

        {useCase.dashboard && todRows.length > 0 && (
          <FilterBar
            groups={TOD_GROUPS}
            emptyFilters={tod.EMPTY_FILTERS}
            filters={filters}
            onChange={(f) => { setFilters(f); setFiltersFromChat(false) }}
            fromChat={filtersFromChat}
            matched={visibleRows.length}
            total={todRows.length}
          />
        )}

        {(useCase.dashboard ? dashboardResult : result) && (() => {
          const activeLegend = useCase.legends ? useCase.legends[mapMode] : useCase.legend
          return (
            <div className="legend">
              <b>{activeLegend.title}</b>
              {activeLegend.stops.map(([value, color]) => (
                <div key={value} className="legend-row">
                  <span className="swatch" style={{ background: color }} />
                  {value}
                </div>
              ))}
              {activeLegend.note && <p className="legend-note">{activeLegend.note}</p>}
            </div>
          )
        })()}

        {useCase.dashboard && (
          <Chatbot
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
      </main>

      {dockOpen && (useCase.dashboard ? todRows.length > 0 : result) && (
        <div className="dock-view-switch">
          <button className={resultView === "hasil" ? "active" : ""} onClick={() => setResultView("hasil")}>Hasil</button>
          <button className={resultView === "ai" ? "active" : ""} onClick={() => setResultView("ai")}>AI</button>
        </div>
      )}

      {useCase.dashboard && resultView === "hasil" && (
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

      {useCase.extras === "equity" && result && station && resultView === "hasil" && (
        <EquityDock
          open={dockOpen}
          onToggle={() => setDockOpen((v) => !v)}
          tab={dockTab}
          onTab={setDockTab}
          station={station}
          result={result}
          radius={radius}
          stations={stations}
          categoryFilter={poiCategoryFilter}
          onCategoryFilter={setPoiCategoryFilter}
          onFocusPoi={(f) => setFocusPoint({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })}
          onRoutePoi={routeToPoi}
          routingId={routingId}
          mapMode={mapMode}
          onMapMode={setMapMode}
        />
      )}

      {useCase.extras === "walk" && result && station && resultView === "hasil" && (
        <WalkDock
          open={dockOpen}
          onToggle={() => setDockOpen((v) => !v)}
          tab={dockTab}
          onTab={setDockTab}
          result={result}
          stationId={stationId}
          picking={picking}
          onTogglePick={() => setPicking((v) => !v)}
          preference={routePreference}
          onPreference={setRoutePreference}
          routeResult={routeStats}
          routeStatus={routeStatus}
          onFocus={focusTransferPoint}
          onRouteGreen={routeToGreenPoi}
          greenRoutingId={greenRoutingId}
          mapMode={mapMode}
          onMapMode={setMapMode}
        />
      )}

      {useCase.extras === "site" && result && station && resultView === "hasil" && (
        <SiteDock
          open={dockOpen}
          onToggle={() => setDockOpen((v) => !v)}
          tab={dockTab}
          onTab={setDockTab}
          result={result}
          onFocus={focusTransferPoint}
          mapMode={mapMode}
          onMapMode={setMapMode}
        />
      )}

      {useCase.extras === "resilience" && result && station && resultView === "hasil" && (
        <ResilienceDock
          open={dockOpen}
          onToggle={() => setDockOpen((v) => !v)}
          tab={dockTab}
          onTab={setDockTab}
          result={result}
          onFocus={focusPolygon}
          mapMode={mapMode}
          onMapMode={setMapMode}
        />
      )}

      {resultView === "ai" && (useCase.dashboard ? todRows.length > 0 : result) && (
        <AiDock
          open={dockOpen}
          onToggle={() => setDockOpen((v) => !v)}
          useCaseId={useCaseId}
          label={useCase.title}
          persona={persona}
          result={useCase.dashboard ? aiDashboardResult : result}
        />
      )}

      {(resultView === "hasil" || resultView === "ai") && !loading && !(useCase.dashboard ? todRows.length > 0 : result) && (
        <div className="sheet-empty">
          <p className="note">
            Belum ada hasil. Buka tab "Analisis", pilih stasiun, lalu jalankan analisis dulu.
          </p>
        </div>
      )}
    </div>
  )
}
