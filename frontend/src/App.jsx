import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import MapView from "./MapView"
import AiDock from "./components/AiDock"
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

// Type-to-filter dropdown - same custom listbox pattern as StationPicker (search input +
// its own absolutely-positioned option list, not the browser's native <input list>/
// <datalist> combo). The native version raced blur against the datalist popup's own click
// selection (blur fires first in some browsers, so picking an option could get silently
// reverted a tick later - "susah keluar", reported twice). Picking an option here uses
// onMouseDown like StationPicker does, which fires before blur, so there's no race to lose.
function SearchableSelect({ value, onChange, options, allowEmpty }) {
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef(null)

  useEffect(() => {
    function onClickOutside(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener("mousedown", onClickOutside)
    return () => document.removeEventListener("mousedown", onClickOutside)
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = q ? options.filter((o) => o.toLowerCase().includes(q)) : options
    return allowEmpty ? ["", ...base] : base
  }, [options, query, allowEmpty])

  function pick(opt) {
    onChange(opt)
    setQuery("")
    setOpen(false)
  }

  function onKeyDown(e) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) { setOpen(true); return }
    if (!open) return
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, filtered.length - 1)) }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)) }
    else if (e.key === "Enter") { e.preventDefault(); if (filtered[highlight] !== undefined) pick(filtered[highlight]) }
    else if (e.key === "Escape") setOpen(false)
  }

  return (
    <div className="station-picker" ref={rootRef}>
      <input
        className="search-input"
        type="text"
        placeholder={allowEmpty || "Cari…"}
        value={open ? query : (value || (allowEmpty ? allowEmpty : ""))}
        onFocus={() => { setOpen(true); setQuery(""); setHighlight(0) }}
        onChange={(e) => { setQuery(e.target.value); setHighlight(0) }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div className="station-picker-list">
          {filtered.length === 0 && <div className="station-picker-empty">Tidak ada hasil</div>}
          {filtered.slice(0, 200).map((o, i) => (
            <div
              key={o || "__empty__"}
              className={`station-picker-item${i === highlight ? " active" : ""}${o === value ? " selected" : ""}`}
              onMouseDown={() => pick(o)}
              onMouseEnter={() => setHighlight(i)}
            >
              {o || allowEmpty}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

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
  const [subtype2, setSubtype2] = useState("")
  const [subtype2Options, setSubtype2Options] = useState([])
  const [radius, setRadius] = useState(800)
  const [result, setResult] = useState(null)
  const [insight, setInsight] = useState("")
  const [status, setStatus] = useState("")
  const [loading, setLoading] = useState(false)
  // MapView reports its own maplibre load/error state up here so "Jalankan analisis" can
  // wait for the map instead of racing it - running an analysis whose result then gets
  // handed to a still-loading map used to just draw nothing, silently. On error we do NOT
  // auto-reload (a broken style URL retried in a loop just spams requests) - we tell the
  // user to reload manually instead.
  const [mapStatus, setMapStatus] = useState({ loaded: false, error: false, moving: false })
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
  const [dockOpen, setDockOpen] = useState(false)
  const [dockTab, setDockTab] = useState("ringkasan")
  const [whatIf, setWhatIf] = useState(null)

  // M-UC2 extras (POI search/filter, compare, route)
  const [poiCategoryFilter, setPoiCategoryFilter] = useState([])
  // U-UC1's anchor-type filter (kantor/kebutuhan_dasar/transit) used to be local state
  // inside AnchorSearch - it filtered that panel's own search list but never touched
  // what MapView actually drew, so toggling it never added/removed anchor pins on the
  // map itself. Lifted here so mapResult below can apply it, same pattern as M-UC2's
  // poiCategoryFilter.
  const [anchorTypeFilter, setAnchorTypeFilter] = useState([])
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
  const [transferRoutingId, setTransferRoutingId] = useState(null)
  // Same 4 checkboxes in Ringkasan/Transfer/Hijau (WalkDock) - isochrone outline, transfer
  // POI, green POI and "whichever per-topic heatmap is active" are independent overlays
  // (see usecases.js's M-UC1 layer comments), not tied to which tab is open.
  const [showIsochrone, setShowIsochrone] = useState(true)
  const [showPoiTransfer, setShowPoiTransfer] = useState(true)
  const [showPoiHijau, setShowPoiHijau] = useState(true)
  const [showJalan, setShowJalan] = useState(true)
  const [showHeatmap, setShowHeatmap] = useState(true)
  // M-UC2 layer toggles (EquityDock) - same idea as M-UC1's checklist above, scoped to
  // what M-UC2 actually draws: isochrone outline/fill, basic-need POI pins, and the
  // heatmap_poi grid choropleth (+ its grid_id labels, toggled together with it).
  const [showEqIsochrone, setShowEqIsochrone] = useState(true)
  const [showEqPoi, setShowEqPoi] = useState(true)
  const [showEqHeatmap, setShowEqHeatmap] = useState(true)
  // U-UC1 layer toggles (SiteDock) - anchor pins, competitor pins, and the voronoi
  // catchment line are each independent overlays on top of whichever grid mode is picked.
  const [showSiteAnchor, setShowSiteAnchor] = useState(true)
  const [showSiteCompetitor, setShowSiteCompetitor] = useState(true)
  const [showSiteCatchment, setShowSiteCatchment] = useState(true)
  // The grid fill itself (walk_score/kompetitor/anchor, whichever mode is picked) had no
  // toggle at all - always on, unlike every other overlay here.
  const [showSiteHeatmap, setShowSiteHeatmap] = useState(true)
  // K-UC2 layer toggle (ResilienceDock) - unlike M-UC1/M-UC2, every K-UC2 fill is
  // mode-gated (one topic visible at a time via the TOPICS picker), so there's just one
  // "hide whichever topic fill is active" checkbox to add, shared across all of them.
  const [showResilienceHeatmap, setShowResilienceHeatmap] = useState(true)
  // Off by default - POI/station name pills are opaque DOM markers that always float
  // above the map canvas (browser stacking, not a maplibre layer-order thing), so with
  // labels on they visually bury the isochrone/heatmap coloring underneath. Icon badges
  // alone stay small enough not to.
  const [showPoiLabels, setShowPoiLabels] = useState(false)
  const layerToggles = useMemo(
    () => ({
      isochrone: showIsochrone, poi_transfer: showPoiTransfer, poi_hijau: showPoiHijau, jalan: showJalan, heatmap: showHeatmap,
      poi_isochrone: showEqIsochrone, poi_pins: showEqPoi, poi_heatmap: showEqHeatmap,
      site_anchor: showSiteAnchor, site_competitor: showSiteCompetitor, site_catchment: showSiteCatchment,
      site_heatmap: showSiteHeatmap,
      resilience_heatmap: showResilienceHeatmap,
    }),
    [
      showIsochrone, showPoiTransfer, showPoiHijau, showJalan, showHeatmap,
      showEqIsochrone, showEqPoi, showEqHeatmap,
      showSiteAnchor, showSiteCompetitor, showSiteCatchment, showSiteHeatmap,
      showResilienceHeatmap,
    ],
  )

  useEffect(() => {
    api.styles().then((s) => { setStyles(s); setStyleUrl(s[0].url) })
    // TJ halte were missing from this list entirely (only StationPicker fetched them,
    // locally, for its own dropdown) - so picking a TJ halte set stationId to something
    // `stations.find()` below could never match, silently leaving `station` undefined:
    // no flyTo (map just sat wherever it was), and `run()` rejected with "Pilih stasiun
    // dulu" despite a halte visibly being selected. TJ comes from local GTFS (no
    // Overpass involved), so fetching it here too is instant - no lazy-load tradeoff
    // to preserve like there would be for an Overpass-backed mode.
    Promise.all([api.stations(), api.stations("TJ")]).then(([rail, tj]) => setStations([...rail, ...tj]))
  }, [])

  // Switching stations/halte used to leave the previous station's result layers drawn
  // on the map (isochrone/heatmap/POI pins from wherever was selected before) since
  // nothing ever cleared `result` - it looked like the map "didn't refresh" even though
  // the picker had moved on. Clearing on every stationId change forces a real re-run
  // before anything is shown for the new point, for both the map-click and dropdown
  // picker paths (both end up changing stationId).
  useEffect(() => {
    setResult(null)
    setRouteResult(null)
    setRouteStats(null)
    setRouteStatus("")
    setFocusPoint(null)
    setPoiCategoryFilter([])
    setInsight("")
    setStatus("")
  }, [stationId])

  // Loading feedback (Shneiderman: informative feedback) - ticks every second while an
  // analysis runs so the wait isn't a silent freeze, alongside expectedWait per use case.
  useEffect(() => {
    if (!loading) return
    setLoadingSeconds(0)
    const id = setInterval(() => setLoadingSeconds((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [loading])

  // U-UC1: MAPID's business categories have 2 levels of subcategory - TIPE_2 (coarse,
  // e.g. MAKANAN DAN MINUMAN -> RESTORAN/MINUMAN/ROTI DAN KUE/BAR) and TIPE_3 (fine, e.g.
  // RESTORAN -> RESTORAN PADANG/SEAFOOD/... or MINUMAN -> COFFEESHOP/...). Both refetch
  // whenever their parent selection changes.
  useEffect(() => {
    setSubtype(""); setSubtype2("")
    if (useCaseId !== "U-UC1") { setSubtypeOptions([]); return }
    // Guard against out-of-order responses - switching category fires a new fetch before
    // the previous one's response lands, and network timing doesn't guarantee the earlier
    // request resolves first. Without this, picking a new category quickly could have the
    // OLD category's subtype list win the race and stick (e.g. still showing APOTEK's
    // options - it has none, so this reads as "empty()" winning, but any category with a
    // slower response than the one after it hits the same bug).
    let current = true
    api.businessSubtypes(category).then((opts) => { if (current) setSubtypeOptions(opts) })
    return () => { current = false }
  }, [category, useCaseId])

  useEffect(() => {
    setSubtype2("")
    if (useCaseId !== "U-UC1") { setSubtype2Options([]); return }
    let current = true
    api.businessSubtypes2(category, subtype || undefined).then((opts) => { if (current) setSubtype2Options(opts) })
    return () => { current = false }
  }, [category, subtype, useCaseId])

  const useCase = USE_CASES.find((u) => u.id === useCaseId)
  const isDashboard = Boolean(useCase.dashboard)
  const station = stations.find((s) => s.id === stationId)
  const personaUseCases = USE_CASES.filter((u) => u.persona === persona)

  const visibleRows = useMemo(() => tod.applyFilters(todRows, filters), [todRows, filters])

  // Stable reference (not recreated every render) - AiPanel resets its chat whenever
  // this changes, so a fresh object each render would wipe the conversation constantly.
  //
  // Slimmed to the comparison-relevant fields only - a full row (raw indicators +
  // normalized indicators + priorities + typology_reason) runs ~4300 characters each,
  // so even 30 of them (~130k chars) blew straight through ai.py's 8000-char request
  // budget and got dropped as a whole ("kok ga ngumpulin json ... {}" - the backend was
  // silently omitting the entire "stations" key because it could never fit, not sending
  // a truncated version of it). Station/SCI/rank/classification/criteria is enough to
  // answer "why does this station rank behind its neighbors" without the per-indicator
  // raw values, source tags, and improvement-priority text that made each row so heavy.
  const aiDashboardResult = useMemo(() => {
    if (!todRows.length) return null
    const slim = todRows.map((r) => ({
      station: r.station, mode_label: r.mode_label, sci: r.sci, rank: r.rank,
      classification: r.classification, typology: r.typology, criteria: r.criteria,
    }))
    return { stations: slim }
  }, [todRows])

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
            mode: r.mode_label,
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
    if (useCase.extras === "site") {
      if (!result || !anchorTypeFilter.length) return result
      const anchors = {
        ...result.anchors,
        features: result.anchors.features.filter((f) => anchorTypeFilter.includes(f.properties.anchor_type)),
      }
      return { ...result, anchors }
    }
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
  }, [useCase, result, poiCategoryFilter, anchorTypeFilter, routeResult])

  async function run() {
    if (mapStatus.error) return setStatus("Peta gagal dimuat. Reload halaman (F5), lalu coba lagi.")
    if (!mapStatus.loaded) return setStatus("Peta masih memuat, tunggu sebentar lalu coba lagi.")
    if (mapStatus.moving) return setStatus("Peta masih pindah ke stasiun, tunggu sebentar lalu coba lagi.")
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
        setResult(await useCase.run(station, { category, businessType: category, subtype, subtype2, radius }))
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

  async function routeToTransferPoint(feature, index) {
    setTransferRoutingId(index)
    const [lon, lat] = feature.geometry.coordinates
    await pickDestination({ lon, lat })
    setTransferRoutingId(null)
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

      <button className="panel-back" onClick={() => setRoleChosen(false)} title="Ganti Peran" aria-label="Ganti Peran">
        <span className="panel-back-icon">←</span>
        <span className="panel-back-label">Ganti Peran</span>
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
              <p className="note">Satu moda per analisis - gabungan beberapa moda bikin Overpass lambat.</p>
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
                  <SearchableSelect
                    id="business-type" value={category} onChange={setCategory}
                    options={useCase.options.businessType}
                  />
                  {subtypeOptions.length > 0 && (
                    <>
                      <label>Sub-tipe (TIPE_2)</label>
                      <SearchableSelect
                        id="subtype" value={subtype} onChange={setSubtype}
                        options={subtypeOptions} allowEmpty="— semua sub-tipe —"
                      />
                    </>
                  )}
                  {subtype2Options.length > 0 && (
                    <>
                      <label>Sub-tipe detail (TIPE_3)</label>
                      <SearchableSelect
                        id="subtype2" value={subtype2} onChange={setSubtype2}
                        options={subtype2Options} allowEmpty="— semua sub-tipe detail —"
                      />
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
            </>
          )}
          <button
            className="primary" onClick={run}
            disabled={loading || !mapStatus.loaded || mapStatus.moving}
            title={
              mapStatus.error ? "Peta gagal dimuat - reload halaman"
                : !mapStatus.loaded ? "Menunggu peta selesai dimuat..."
                : mapStatus.moving ? "Menunggu peta selesai pindah ke stasiun..."
                : undefined
            }
          >
            {mapStatus.error ? "Peta gagal dimuat" : !mapStatus.loaded ? "Memuat peta..." : mapStatus.moving ? "Memindahkan peta..." : "Jalankan analisis"}
          </button>
          <label className="filter-option">
            <input type="checkbox" checked={showPoiLabels} onChange={(e) => setShowPoiLabels(e.target.checked)} />
            Tampilkan teks POI &amp; stasiun
          </label>
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
            layerToggles={layerToggles}
            onPickStation={selectStation}
            picking={picking}
            onMapPick={pickDestination}
            showLabels={showPoiLabels}
            onMapStatus={setMapStatus}
          />
        )}

        {useCase.dashboard && todRows.length > 0 && (
          <FilterBar
            groups={TOD_GROUPS}
            emptyFilters={tod.EMPTY_FILTERS}
            filters={filters}
            onChange={setFilters}
            matched={visibleRows.length}
            total={todRows.length}
          />
        )}

        {(useCase.dashboard ? dashboardResult : result) && (() => {
          const activeLegend = useCase.legends ? useCase.legends[mapMode] : useCase.legend
          if (!activeLegend) return null
          return (
            <div className="legend">
              <b>{activeLegend.title}</b>
              {activeLegend.stops?.map(([value, color]) => (
                <div key={value} className="legend-row">
                  <span className="swatch" style={{ background: color }} />
                  {value}
                </div>
              ))}
              {activeLegend.note && <p className="legend-note">{activeLegend.note}</p>}
            </div>
          )
        })()}

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
          showIsochrone={showEqIsochrone}
          onToggleIsochrone={() => setShowEqIsochrone((v) => !v)}
          showPoi={showEqPoi}
          onTogglePoi={() => setShowEqPoi((v) => !v)}
          showHeatmap={showEqHeatmap}
          onToggleHeatmap={() => setShowEqHeatmap((v) => !v)}
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
          onRouteTransfer={routeToTransferPoint}
          transferRoutingId={transferRoutingId}
          mapMode={mapMode}
          onMapMode={setMapMode}
          showIsochrone={showIsochrone}
          onToggleIsochrone={() => setShowIsochrone((v) => !v)}
          showPoiTransfer={showPoiTransfer}
          onTogglePoiTransfer={() => setShowPoiTransfer((v) => !v)}
          showPoiHijau={showPoiHijau}
          onTogglePoiHijau={() => setShowPoiHijau((v) => !v)}
          showJalan={showJalan}
          onToggleJalan={() => setShowJalan((v) => !v)}
          showHeatmap={showHeatmap}
          onToggleHeatmap={() => setShowHeatmap((v) => !v)}
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
          showAnchor={showSiteAnchor}
          onToggleAnchor={() => setShowSiteAnchor((v) => !v)}
          showCompetitor={showSiteCompetitor}
          onToggleCompetitor={() => setShowSiteCompetitor((v) => !v)}
          showCatchment={showSiteCatchment}
          onToggleCatchment={() => setShowSiteCatchment((v) => !v)}
          showHeatmap={showSiteHeatmap}
          onToggleHeatmap={() => setShowSiteHeatmap((v) => !v)}
          anchorTypeFilter={anchorTypeFilter}
          onAnchorTypeFilter={setAnchorTypeFilter}
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
          showHeatmap={showResilienceHeatmap}
          onToggleHeatmap={() => setShowResilienceHeatmap((v) => !v)}
        />
      )}

      {/* Kept mounted (hidden via a prop, not removed from the tree) whenever there's a
          result to ask about - conditionally rendering on resultView === "ai" used to
          unmount AiDock/AiPanel every time the user switched to "Hasil" and back, which
          destroyed the chat's useState history. A wrapping <div> around AiDock was tried
          first, but .dock is a direct flex-row sibling (its height comes from stretching
          against that row) - the extra wrapper broke that, so .dock-body/.chat-body's
          flex:1 had nothing bounded to size against and just grew with content forever
          instead of scrolling. `hidden` is applied inside AiDock itself instead, so no
          extra DOM node sits between it and the flex row. */}
      {(useCase.dashboard ? todRows.length > 0 : result) && (
        <AiDock
          hidden={resultView !== "ai"}
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
