import { useEffect, useRef } from "react"
import maplibregl from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"

const JAKARTA = [106.8271129, -6.1754398]

// Station glyphs (🚇🚈🚆🚌🚉) as text-field in a GL symbol layer render as blank "tofu"
// boxes on most vector styles - the style's own glyph server only ships Latin ranges, not
// emoji. Rasterizing each emoji to a canvas once and registering it via addImage sidesteps
// that entirely (the browser's own emoji font draws it, GL just blits the bitmap).
const STATION_ICONS = { MRT: "🚇", LRT: "🚈", KRL: "🚆", TJ: "🚌", default: "🚉" }

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

export default function MapView({ styleUrl, stations, activeStation, focusPoint, result, useCase, mapMode, layerToggles, onPickStation, picking, onMapPick, showLabels = true }) {
  const container = useRef(null)
  const map = useRef(null)
  const loaded = useRef(false)
  const activePopup = useRef(null)

  useEffect(() => {
    if (!styleUrl || map.current) return
    map.current = new maplibregl.Map({ container: container.current, style: styleUrl, center: JAKARTA, zoom: 11 })
    map.current.addControl(new maplibregl.NavigationControl(), "top-right")
    map.current.on("load", () => { loaded.current = true })
  }, [styleUrl])

  useEffect(() => {
    if (map.current && loaded.current) map.current.setStyle(styleUrl)
  }, [styleUrl])

  // station points
  useEffect(() => {
    const m = map.current
    if (!m || !stations.length) return
    const draw = () => {
      ensureStationIcons(m)
      const data = {
        type: "FeatureCollection",
        features: stations.map((s) => ({
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
        // own color+glyph, always on top (no "stations" source line before it in addLayer
        // calls elsewhere). Kept as a GL circle+symbol pair (not DOM markers like the POI
        // pins below) because TJ mode alone can be thousands of halte - DOM markers at
        // that count visibly stutter panning, GL layers don't.
        m.addLayer({
          id: "stations", type: "circle", source: "stations",
          paint: {
            "circle-radius": 9,
            "circle-color": [
              "match", ["get", "mode"],
              "MRT", "#dc2626", "LRT", "#f97316", "KRL", "#2563eb", "TJ", "#16a34a",
              "#6b7280",
            ],
            "circle-stroke-width": 2.5,
            "circle-stroke-color": "#ffffff",
          },
        })
        m.addLayer({
          id: "stations-icon", type: "symbol", source: "stations",
          layout: {
            "icon-image": ["match", ["get", "mode"],
              "MRT", "station-icon-MRT", "LRT", "station-icon-LRT",
              "KRL", "station-icon-KRL", "TJ", "station-icon-TJ",
              "station-icon-default"],
            "icon-size": 0.32,
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          },
        })
        // Name label under the icon - real collision detection (not allow-overlap), so
        // dense TJ clusters thin themselves out instead of turning into an unreadable
        // wall of text.
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
        })
        m.on("click", "stations", (e) => onPickStation(e.features[0].properties.id))
        m.on("mouseenter", "stations", () => { m.getCanvas().style.cursor = "pointer" })
        m.on("mouseleave", "stations", () => { m.getCanvas().style.cursor = "" })
      }
      if (m.getLayer("stations-label")) m.setLayoutProperty("stations-label", "visibility", showLabels ? "visible" : "none")
    }
    if (loaded.current) draw()
    m.on("styledata", draw)
    return () => m.off("styledata", draw)
  }, [stations, onPickStation, showLabels])

  // result layers
  useEffect(() => {
    const m = map.current
    if (!m || !loaded.current || !useCase) return
    ensureStationIcons(m)
    const ids = []
    const markers = []
    const openPopup = (lngLat, props) => {
      activePopup.current?.remove()
      const html = useCase.popup
        .filter((k) => props[k] !== undefined)
        .map((k) => `<div><b>${k}</b>: ${props[k]}</div>`)
        .join("")
      activePopup.current = new maplibregl.Popup().setLngLat(lngLat).setHTML(html).addTo(m)
    }
    let hasStationPins = false
    useCase.layers.forEach((layer, i) => {
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
      const layout = layer.layout ? { ...layer.layout } : null
      if (layer.label && layout) layout.visibility = showLabels ? "visible" : "none"
      m.addLayer(
        { id: layerId, type: layer.type, source: sourceId, paint: layer.paint, ...(layout ? { layout } : {}) },
        "stations",
      )
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
    })

    // The dashboard draws its own station symbols, and a stationsLike pin layer with
    // actual data (M-UC1's transfer_points) already marks every station in range - either
    // way the plain point layer would just draw a second marker on the same spot. Before
    // that data exists (first load, no query run yet) the base dots stay visible so every
    // station/halte still shows.
    if (m.getLayer("stations")) {
      const vis = (useCase.dashboard || hasStationPins) ? "none" : "visible"
      m.setLayoutProperty("stations", "visibility", vis)
      m.setLayoutProperty("stations-icon", "visibility", vis)
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
  }, [result, useCase, mapMode, layerToggles, onPickStation, showLabels])

  // fly to station
  useEffect(() => {
    if (map.current && activeStation) map.current.flyTo({ center: [activeStation.lon, activeStation.lat], zoom: 14.5 })
  }, [activeStation])

  // fly to a searched point (e.g. a POI), without changing the selected station
  useEffect(() => {
    if (map.current && focusPoint) map.current.flyTo({ center: [focusPoint.lon, focusPoint.lat], zoom: 17 })
  }, [focusPoint])

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
