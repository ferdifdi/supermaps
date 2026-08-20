import { useEffect, useRef } from "react"
import maplibregl from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"

const JAKARTA = [106.8271129, -6.1754398]

export default function MapView({ styleUrl, stations, activeStation, focusPoint, result, useCase, mapMode, layerToggles, onPickStation, picking, onMapPick }) {
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
      const data = {
        type: "FeatureCollection",
        features: stations.map((s) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [s.lon, s.lat] },
          properties: { id: s.id, name: s.name, mode: s.mode },
        })),
      }
      if (m.getSource("stations")) m.getSource("stations").setData(data)
      else {
        m.addSource("stations", { type: "geojson", data })
        m.addLayer({
          id: "stations", type: "circle", source: "stations",
          paint: { "circle-radius": 4, "circle-color": "#5b4bdb", "circle-stroke-width": 1, "circle-stroke-color": "#fff" },
        })
        m.on("click", "stations", (e) => onPickStation(e.features[0].properties.id))
        m.on("mouseenter", "stations", () => { m.getCanvas().style.cursor = "pointer" })
        m.on("mouseleave", "stations", () => { m.getCanvas().style.cursor = "" })
      }
    }
    if (loaded.current) draw()
    m.on("styledata", draw)
    return () => m.off("styledata", draw)
  }, [stations, onPickStation])

  // result layers
  useEffect(() => {
    const m = map.current
    if (!m || !loaded.current || !useCase) return
    const ids = []
    useCase.layers.forEach((layer, i) => {
      if (layer.mode && layer.mode !== mapMode) return
      if (layer.toggle && layerToggles?.[layer.toggle] === false) return
      const data = result?.[layer.source]
      if (!data) return
      const sourceId = `res-${layer.source}`
      const layerId = `res-${layer.source}-${i}`
      ids.push({ sourceId, layerId })
      if (!m.getSource(sourceId)) m.addSource(sourceId, { type: "geojson", data })
      else m.getSource(sourceId).setData(data)
      m.addLayer({ id: layerId, type: layer.type, source: sourceId, paint: layer.paint }, "stations")
      // noPopup: layers whose properties are constant across the whole feature (e.g. the
      // isochrone fill/line's "minutes" - same number everywhere inside one polygon) don't
      // get a click popup - it looked like a bug ("kenapa menitnya sama terus") since it's
      // not location-specific info, and now that isochrone/grid/etc overlap by default
      // (independent toggles, not one-at-a-time modes) it fired on almost every click.
      if (layer.type !== "heatmap" && !layer.noPopup) {
        m.on("click", layerId, (e) => {
          // Only one popup alive at a time - overlapping layers (isochrone fill + grid
          // fill + a POI circle can all sit under the same pixel now) used to each spawn
          // their own maplibregl.Popup() and stack, so closing the top one left others
          // stuck underneath looking unclosable. Removing the previous one first means a
          // click always leaves exactly one popup, with a working X.
          activePopup.current?.remove()
          const props = e.features[0].properties
          const html = useCase.popup
            .filter((k) => props[k] !== undefined)
            .map((k) => `<div><b>${k}</b>: ${props[k]}</div>`)
            .join("")
          activePopup.current = new maplibregl.Popup().setLngLat(e.lngLat).setHTML(html).addTo(m)
        })
      }
    })

    // The dashboard draws its own station symbols, so the plain point layer would just clutter them.
    if (m.getLayer("stations")) {
      m.setLayoutProperty("stations", "visibility", useCase.dashboard ? "none" : "visible")
    }
    return () => {
      // Remove every layer first - a source can't be removed while a layer still uses it,
      // and several layer defs (e.g. heatmap + circle) can share the same source.
      ids.forEach(({ layerId }) => { if (m.getLayer(layerId)) m.removeLayer(layerId) })
      new Set(ids.map((x) => x.sourceId)).forEach((sourceId) => {
        if (m.getSource(sourceId)) m.removeSource(sourceId)
      })
    }
  }, [result, useCase, mapMode, layerToggles, onPickStation])

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

  return <div ref={container} className="map" />
}
