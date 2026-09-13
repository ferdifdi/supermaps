import { useEffect, useRef, useState } from "react"
import maplibregl from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"

const JAKARTA = [106.8271129, -6.1754398]

// Station glyphs (🚇🚈🚆🚌🚉) as text-field in a GL symbol layer render as blank "tofu"
// boxes on most vector styles - the style's own glyph server only ships Latin ranges, not
// emoji. Rasterizing each emoji to a canvas once and registering it via addImage sidesteps
// that entirely (the browser's own emoji font draws it, GL just blits the bitmap).
export const STATION_ICONS = { MRT: "🚇", LRT: "🚈", KRL: "🚆", TJ: "🚌", default: "🚉" }

// Legend order top-to-bottom (MRT, LRT, KRL, TJ) - reused by App.jsx's always-on station
// legend so the list order there matches this, not the bottom-to-top draw order above.
export const STATION_LEGEND_ORDER = ["MRT", "LRT", "KRL", "TJ"]

// Formal per-mode palette (high-contrast, chosen so TJ - by far the densest mode - never
// reads as the same color as the green POI pins). Exported so App.jsx's always-on station
// legend stays in sync with what the map actually draws.
export const STATION_COLORS = { MRT: "#0D47A1", LRT: "#6A1B9A", KRL: "#D32F2F", TJ: "#E65100", default: "#6b7280" }

// Draw order bottom-to-top: TJ is the densest mode by far and was burying MRT/LRT/KRL
// under it, so it always draws first (bottom) and the rarer/more-important modes stack
// on top in this order - matches the top-to-bottom reading order in the legend (MRT, LRT,
// KRL, TJ).
const STATION_DRAW_ORDER = { TJ: 0, KRL: 1, LRT: 2, MRT: 3, default: -1 }

function emojiImageData(emoji, size = 48) {
  const canvas = document.createElement("canvas")
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext("2d")
  ctx.font = `${Math.floor(size * 0.75)}px "Segoe UI Emoji", "Noto Color Emoji", sans-serif`
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(emoji, size / 2, size / 2 + size * 0.04)
  return ctx.getImageData(0, 0, size, size)
}

function ensureStationIcons(m) {
  Object.entries(STATION_ICONS).forEach(([mode, emoji]) => {
    const id = `station-icon-${mode}`
    if (!m.hasImage(id)) m.addImage(id, emojiImageData(emoji))
  })
}

const DEFAULT_STATION_TOGGLES = { MRT: true, LRT: true, KRL: true, TJ: true, RUTE: true }

export default function MapView({ styleUrl, stations, railLines, activeStation, focusPoint, result, useCase, mapMode, layerToggles, stationToggles = DEFAULT_STATION_TOGGLES, onPickStation, picking, onMapPick, showLabels = true, onMapStatus }) {
  const container = useRef(null)
  const map = useRef(null)
  const activePopup = useRef(null)
  // Real state, not a ref - a ref's mutation doesn't retrigger the result-layer effect
  // below, so if `result` arrived before the map's own "load" fired, that effect would
  // bail out once and never get another chance to draw once the map actually finished
  // loading (layers silently missing, no error). State makes "just finished loading"
  // itself a dependency the effect reacts to.
  const [loaded, setLoaded] = useState(false)
  const [mapError, setMapError] = useState(false)

  useEffect(() => {
    if (!styleUrl) return
    // setStyle() + waiting for some "is it really done" event (style.load, idle - both
    // tried, both had timing edge cases where the button/redraw fired before the map
    // was actually visibly ready) kept being fragile. Tearing the whole map down and
    // building a fresh one is what a real page reload does and isn't ambiguous about
    // when it's done - "load" on the new instance is the same one-shot, reliable signal
    // the very first mount already used. Keeps the current center/zoom instead of
    // snapping back to the Jakarta default, so switching basemap doesn't also relocate
    // the view.
    const prev = map.current
    const center = prev ? prev.getCenter() : JAKARTA
    const zoom = prev ? prev.getZoom() : 11
    if (prev) {
      prev.remove()
      map.current = null
      setLoaded(false)
    }
    const m = new maplibregl.Map({ container: container.current, style: styleUrl, center, zoom })
    map.current = m
    m.addControl(new maplibregl.NavigationControl(), "top-right")
    m.on("load", () => setLoaded(true))
    // A style/tile fetch failure fires "error", not a rejected promise - without this the
    // map just sits blank forever with no signal to the user. Reported once as a status
    // flag; the caller decides how to surface it (e.g. "reload manually"), we do NOT
    // auto-retry here - a broken network/style URL retried in a loop just spams requests.
    m.on("error", () => setMapError(true))
  }, [styleUrl])

  useEffect(() => {
    // Merge, not replace - the flyTo effect below also writes to this same status object
    // (its "moving" field) via the same setter, and a plain-object call here would wipe
    // that field out every time load/error state ticks.
    onMapStatus?.((s) => ({ ...s, loaded, error: mapError }))
  }, [loaded, mapError, onMapStatus])

  // Full-line MRT/KRL/LRT rail track geometry (api.railLines(), see backend's
  // static_transit.rail_lines_geojson) - an always-on background layer, not tied to any
  // query result. Added before the station-points effect below so it lands at the very
  // bottom of the stations stack (under stations-tj too) - it's context under the
  // markers, not another thing competing with them for top billing. Colored per mode
  // with the same STATION_COLORS as the station dots/legend so a line and the dots along
  // it read as the same mode at a glance.
  useEffect(() => {
    const m = map.current
    if (!m || !railLines) return
    const draw = () => {
      // RUTE is the master switch for the rail-line layer itself (users read the track
      // alignment as "rute") - unchecking it hides every line regardless of which mode
      // checkboxes are on. MRT/LRT/KRL still narrow which lines show while RUTE is on.
      const allowed = stationToggles.RUTE === false
        ? []
        : ["MRT", "LRT", "KRL"].filter((mode) => stationToggles[mode] !== false)
      const filter = ["in", ["get", "mode_label"], ["literal", allowed]]
      if (m.getSource("rail-lines")) {
        m.getSource("rail-lines").setData(railLines)
      } else {
        m.addSource("rail-lines", { type: "geojson", data: railLines })
        // No beforeId needed - this effect is declared (and so mounts/redraws on
        // "styledata") before the station-points effect below, so it's always added to
        // the style first and the station layers naturally stack on top of it.
        m.addLayer({
          id: "rail-lines", type: "line", source: "rail-lines",
          filter,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": [
              "match", ["get", "mode_label"],
              "MRT", STATION_COLORS.MRT, "LRT", STATION_COLORS.LRT, "KRL", STATION_COLORS.KRL,
              STATION_COLORS.default,
            ],
            "line-width": 2.5,
            "line-opacity": 0.75,
          },
        })
      }
      if (m.getLayer("rail-lines")) m.setFilter("rail-lines", filter)
    }
    if (loaded) draw()
    m.on("styledata", draw)
    return () => m.off("styledata", draw)
  }, [railLines, loaded, stationToggles])

  // station points
  useEffect(() => {
    const m = map.current
    if (!m || !stations.length) return
    const draw = () => {
      ensureStationIcons(m)
      // Per-mode visibility checkboxes (sidebar) - MRT/LRT/KRL/TJ each hide their own
      // markers via a source filter (not layer visibility, since stations-main holds all
      // three in one layer). Labels follow whichever modes are currently allowed too, so
      // an unchecked mode's name doesn't linger on screen with no marker under it.
      const mainAllowed = ["MRT", "LRT", "KRL"].filter((mode) => stationToggles[mode] !== false)
      const tjOn = stationToggles.TJ !== false
      const mainFilter = ["in", ["get", "mode"], ["literal", mainAllowed]]
      const tjFilter = ["all", ["==", ["get", "mode"], "TJ"], tjOn]
      const labelFilter = ["in", ["get", "mode"], ["literal", [...mainAllowed, ...(tjOn ? ["TJ"] : [])]]]
      const data = {
        type: "FeatureCollection",
        // Sorted (not just mapped) - a GL circle layer paints features in array order, so
        // this ordering IS the on-map stacking order (see STATION_DRAW_ORDER above).
        features: [...stations]
          .sort((a, b) => (STATION_DRAW_ORDER[a.mode_label] ?? -1) - (STATION_DRAW_ORDER[b.mode_label] ?? -1))
          .map((s) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [s.lon, s.lat] },
            // mode_label is the normalized MRT/LRT/KRL/TJ classification - "mode" instead
            // holds the raw OSM tag (railway=subway, station=light_rail, etc), which never
            // matches any of those 4 values and left every station falling through to the
            // same default color/icon.
            properties: { id: s.id, name: s.name, mode: s.mode_label },
          })),
      }
      if (m.getSource("stations")) m.getSource("stations").setData(data)
      else {
        m.addSource("stations", { type: "geojson", data })
        // Station/halte points need to stay distinct from every POI/result layer at a
        // glance, AND distinct from each other by mode - each of MRT/LRT/KRL/TJ gets its
        // own color+glyph. Split into two GL layer pairs (not one) so the walking route
        // line (added between them, see the result-layers effect below) can sit visually
        // between TJ (bottommost - by far the densest mode) and MRT/LRT/KRL (topmost):
        // stations-tj-* draw first/bottom, the route slots in above them, then
        // stations-main-* (MRT/LRT/KRL) draw last/top. Kept as GL circle+symbol pairs (not
        // DOM markers like the POI pins below) because TJ mode alone can be thousands of
        // halte - DOM markers at that count visibly stutter panning, GL layers don't.
        const circlePaint = {
          "circle-radius": 9,
          "circle-color": [
            "match", ["get", "mode"],
            "MRT", STATION_COLORS.MRT, "LRT", STATION_COLORS.LRT,
            "KRL", STATION_COLORS.KRL, "TJ", STATION_COLORS.TJ,
            STATION_COLORS.default,
          ],
          "circle-stroke-width": 2.5,
          "circle-stroke-color": "#ffffff",
        }
        m.addLayer({
          id: "stations-tj", type: "circle", source: "stations",
          filter: tjFilter,
          paint: circlePaint,
        })
        const iconLayout = {
          "icon-image": ["match", ["get", "mode"],
            "MRT", "station-icon-MRT", "LRT", "station-icon-LRT",
            "KRL", "station-icon-KRL", "TJ", "station-icon-TJ",
            "station-icon-default"],
          // TJ has by far the most halte of any mode - a smaller glyph keeps dense TJ
          // clusters from drowning out the rarer MRT/LRT/KRL icons around them.
          "icon-size": ["match", ["get", "mode"], "TJ", 0.16, 0.24],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        }
        m.addLayer({
          id: "stations-tj-icon", type: "symbol", source: "stations",
          filter: tjFilter,
          layout: iconLayout,
        })
        // The result-layers effect below inserts the walking-route line with
        // beforeId: "stations-main" - it lands right here, above the TJ pair and below
        // MRT/LRT/KRL, matching the requested stacking (MRT, LRT, KRL, RUTE, TJ top-to-
        // bottom).
        m.addLayer({
          id: "stations-main", type: "circle", source: "stations",
          filter: mainFilter,
          paint: circlePaint,
        })
        m.addLayer({
          id: "stations-main-icon", type: "symbol", source: "stations",
          filter: mainFilter,
          layout: iconLayout,
        })
        // Name label under the icon - real collision detection (not allow-overlap), so
        // dense TJ clusters thin themselves out instead of turning into an unreadable
        // wall of text. Covers every mode, always topmost.
        m.addLayer({
          id: "stations-label", type: "symbol", source: "stations",
          layout: {
            "text-field": ["get", "name"],
            "text-size": 10,
            "text-offset": [0, 1.3],
            "text-anchor": "top",
            visibility: showLabels ? "visible" : "none",
          },
          paint: {
            "text-color": "#111827",
            "text-halo-color": "#ffffff",
            "text-halo-width": 1.4,
          },
          filter: labelFilter,
        })
        ;["stations-tj", "stations-main"].forEach((id) => {
          m.on("click", id, (e) => onPickStation(e.features[0].properties.id))
          m.on("mouseenter", id, () => { m.getCanvas().style.cursor = "pointer" })
          m.on("mouseleave", id, () => { m.getCanvas().style.cursor = "" })
        })
      }
      if (m.getLayer("stations-label")) {
        m.setLayoutProperty("stations-label", "visibility", showLabels ? "visible" : "none")
        m.setFilter("stations-label", labelFilter)
      }
      // Re-applied every draw (not just at creation) so toggling a checkbox after the
      // layers already exist still takes effect.
      if (m.getLayer("stations-tj")) {
        m.setFilter("stations-tj", tjFilter)
        m.setFilter("stations-tj-icon", tjFilter)
      }
      if (m.getLayer("stations-main")) {
        m.setFilter("stations-main", mainFilter)
        m.setFilter("stations-main-icon", mainFilter)
      }
    }
    if (loaded) draw()
    m.on("styledata", draw)
    return () => m.off("styledata", draw)
  }, [stations, onPickStation, showLabels, loaded, stationToggles])

  // result layers
  useEffect(() => {
    const m = map.current
    if (!m || !loaded || !useCase) return
    ensureStationIcons(m)
    const ids = []
    const markers = []
    const openPopup = (lngLat, props) => {
      activePopup.current?.remove()
      const html = useCase.popup
        .filter((field) => field.test(props))
        .map((field) => `<div>${field.render(props)}</div>`)
        .join("") || "<div>Tidak ada info tambahan untuk titik ini.</div>"
      activePopup.current = new maplibregl.Popup().setLngLat(lngLat).setHTML(html).addTo(m)
    }
    let hasStationPins = false
    // try/catch per layer - one bad layer throwing (e.g. an unexpected maplibre error)
    // used to abort this whole forEach partway through, which skipped the station-
    // visibility fix-up code after the loop and left the base station dots stuck hidden
    // with no way to recover short of a full page reload.
    useCase.layers.forEach((layer, i) => { try { drawLayer(layer, i) } catch (err) { console.error("layer draw failed:", layer.source, err) } })
    function drawLayer(layer, i) {
      if (layer.mode && layer.mode !== mapMode) return
      if (layer.toggle && layerToggles?.[layer.toggle] === false) return
      const data = result?.[layer.source]
      if (!data) return

      // POI-style layers (modest counts - tens to a couple hundred, never TJ-sized)
      // render as real pin markers (icon + color + text label) instead of GL circles -
      // stations/halte stay GL layers above since those can run into the thousands.
      if (layer.pin) {
        if (layer.stationsLike && data.features.length) hasStationPins = true
        data.features.forEach((f) => {
          const props = f.properties
          const [lng, lat] = f.geometry.coordinates
          const el = document.createElement("div")
          el.className = "poi-pin"
          el.style.opacity = layer.pin.opacity ? layer.pin.opacity(props) : 1
          el.innerHTML = `
            <span class="poi-pin-icon" style="background:${layer.pin.color(props)}">${layer.pin.icon(props)}</span>
            <span class="poi-pin-label">${layer.pin.label(props)}</span>
          `
          el.addEventListener("click", (e) => { e.stopPropagation(); openPopup([lng, lat], props) })
          markers.push(new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([lng, lat]).addTo(m))
        })
        return
      }

      const sourceId = `res-${layer.source}`
      const layerId = `res-${layer.source}-${i}`
      ids.push({ sourceId, layerId })
      if (!m.getSource(sourceId)) m.addSource(sourceId, { type: "geojson", data })
      else m.getSource(sourceId).setData(data)
      let layout = layer.layout ? { ...layer.layout } : null
      if (layer.label && layout) layout.visibility = showLabels ? "visible" : "none"
      // The walking-route line is colored to match the active station's mode instead of
      // its own static line-color, so a KRL trip's route reads red, an MRT trip's navy,
      // etc. It's also inserted before "stations-main" (not "stations-tj") so it stacks
      // above TJ but below MRT/LRT/KRL, per the requested MRT/LRT/KRL/RUTE/TJ order.
      // Unrelated to the sidebar's "RUTE" checkbox - that one only gates the rail-line
      // (garis rel) layer above, not this walking route.
      const isRoute = layer.source === "route"
      const paint = isRoute && activeStation
        ? { ...layer.paint, "line-color": STATION_COLORS[activeStation.mode_label] || layer.paint["line-color"] }
        : layer.paint
      // beforeId only used if that layer actually exists yet - addLayer throws
      // synchronously on a missing beforeId, which used to abort this whole forEach
      // partway through and skip the station-visibility fix-up below it entirely
      // (stations stuck hidden with no way to recover except a full page reload).
      const wantedBefore = isRoute ? "stations-main" : "stations-tj"
      const beforeId = m.getLayer(wantedBefore) ? wantedBefore : undefined
      // layerId is fresh every render in normal operation (the cleanup below always
      // removes the previous run's ids first) - this check is just a safety net so a
      // stray leftover from an earlier failed render can't crash addLayer with a
      // "layer already exists" error.
      if (!m.getLayer(layerId)) {
        m.addLayer({ id: layerId, type: layer.type, source: sourceId, paint, ...(layout ? { layout } : {}) }, beforeId)
      }
      // noPopup: layers whose properties are constant across the whole feature (e.g. the
      // isochrone fill/line's "minutes" - same number everywhere inside one polygon) don't
      // get a click popup - it looked like a bug ("kenapa menitnya sama terus") since it's
      // not location-specific info, and now that isochrone/grid/etc overlap by default
      // (independent toggles, not one-at-a-time modes) it fired on almost every click.
      if (layer.type !== "heatmap" && !layer.noPopup) {
        // Only one popup alive at a time - overlapping layers (isochrone fill + grid
        // fill + a POI circle can all sit under the same pixel now) used to each spawn
        // their own maplibregl.Popup() and stack, so closing the top one left others
        // stuck underneath looking unclosable. Removing the previous one first means a
        // click always leaves exactly one popup, with a working X.
        m.on("click", layerId, (e) => openPopup(e.lngLat, e.features[0].properties))
      }
    }

    // The dashboard draws its own station symbols, and a stationsLike pin layer with
    // actual data (M-UC1's transfer_points) already marks every station in range - either
    // way the plain point layer would just draw a second marker on the same spot. Before
    // that data exists (first load, no query run yet) the base dots stay visible so every
    // station/halte still shows.
    if (m.getLayer("stations-main")) {
      const vis = (useCase.dashboard || hasStationPins) ? "none" : "visible"
      ;["stations-tj", "stations-tj-icon", "stations-main", "stations-main-icon"].forEach((id) => {
        m.setLayoutProperty(id, "visibility", vis)
      })
      m.setLayoutProperty("stations-label", "visibility", showLabels && vis === "visible" ? "visible" : "none")
    }
    return () => {
      // Remove every layer first - a source can't be removed while a layer still uses it,
      // and several layer defs (e.g. heatmap + circle) can share the same source.
      ids.forEach(({ layerId }) => { if (m.getLayer(layerId)) m.removeLayer(layerId) })
      new Set(ids.map((x) => x.sourceId)).forEach((sourceId) => {
        if (m.getSource(sourceId)) m.removeSource(sourceId)
      })
      markers.forEach((mk) => mk.remove())
    }
  }, [result, useCase, mapMode, layerToggles, onPickStation, showLabels, loaded, activeStation, stationToggles])

  // fly to station - reports "moving" via onMapStatus while the flyTo animation is in
  // flight, so the caller can hold off letting the user run an analysis until the view
  // has actually settled on the newly picked station instead of mid-flight. "moveend"
  // only means the camera stopped moving - if the new station is far from the old one
  // (e.g. picking a station from a different mode/area), the tiles for that area may
  // still be loading and the map reads as blank right after moveend fires. "idle" only
  // fires once the map has nothing left to load/render, so it naturally resolves fast
  // for a nearby station (tiles already cached) and waits longer for a distant one -
  // exactly the "instant if close, wait if far" behavior wanted, with no separate
  // distance check needed.
  useEffect(() => {
    const m = map.current
    if (!m || !activeStation) return
    onMapStatus?.((s) => ({ ...s, moving: true }))
    const onSettled = () => onMapStatus?.((s) => ({ ...s, moving: false }))
    m.once("idle", onSettled)
    m.flyTo({ center: [activeStation.lon, activeStation.lat], zoom: 14.5 })
    return () => m.off("idle", onSettled)
  }, [activeStation])

  // fly to a searched point (e.g. a POI), without changing the selected station
  useEffect(() => {
    if (map.current && focusPoint) map.current.flyTo({ center: [focusPoint.lon, focusPoint.lat], zoom: 17 })
  }, [focusPoint])

  // Auto-zoom to fit a newly computed route (M-UC1/M-UC2 "Rute" - result.route is a
  // FeatureCollection with one LineString) - a route to a far destination often falls
  // partly or fully outside the current view, so the line just silently drew off-screen
  // without this.
  const routeCoords = result?.route?.features?.[0]?.geometry?.coordinates
  useEffect(() => {
    if (!map.current || !routeCoords?.length) return
    const bounds = routeCoords.reduce(
      (b, c) => b.extend(c),
      new maplibregl.LngLatBounds(routeCoords[0], routeCoords[0]),
    )
    map.current.fitBounds(bounds, { padding: 80, maxZoom: 17, duration: 800 })
  }, [routeCoords])

  // destination picking mode (M-UC1 route tab) - click anywhere on the map to set the target
  useEffect(() => {
    const m = map.current
    if (!m) return
    m.getCanvas().style.cursor = picking ? "crosshair" : ""
    if (!picking) return
    const handler = (e) => onMapPick({ lon: e.lngLat.lng, lat: e.lngLat.lat })
    m.on("click", handler)
    return () => m.off("click", handler)
  }, [picking, onMapPick])

  return <div ref={container} className={showLabels ? "map" : "map hide-poi-labels"} />
}
