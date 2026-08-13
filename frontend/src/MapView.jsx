import { useEffect, useRef } from "react"
import maplibregl from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"

const JAKARTA = [106.8271129, -6.1754398]

function polygonCentroid(coords) {
  // coords: outer ring of a GeoJSON Polygon, [[lon,lat],...]. Plain average is fine
  // for the near-rectangular grid cells this is used on.
  const [lon, lat] = coords.reduce(([sx, sy], [x, y]) => [sx + x, sy + y], [0, 0])
  return [lon / coords.length, lat / coords.length]
}

function circlePolygon(lon, lat, radiusMeters, steps = 64) {
  const latRad = (lat * Math.PI) / 180
  const dLat = radiusMeters / 111320
  const dLon = radiusMeters / (111320 * Math.cos(latRad))
  const ring = []
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI
    ring.push([lon + dLon * Math.cos(t), lat + dLat * Math.sin(t)])
  }
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: {} }
}

export default function MapView({ styleUrl, stations, activeStation, focusPoint, result, useCase, onPickStation }) {
  const container = useRef(null)
  const map = useRef(null)
  const loaded = useRef(false)

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
          paint: { "circle-radius": 4, "circle-color": "#0f766e", "circle-stroke-width": 1, "circle-stroke-color": "#fff" },
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
      const data = result?.[layer.source]
      if (!data) return
      const sourceId = `res-${layer.source}`
      const layerId = `res-${layer.source}-${i}`
      ids.push({ sourceId, layerId })
      if (!m.getSource(sourceId)) m.addSource(sourceId, { type: "geojson", data })
      else m.getSource(sourceId).setData(data)
      m.addLayer({ id: layerId, type: layer.type, source: sourceId, paint: layer.paint }, "stations")
      m.on("click", layerId, (e) => {
        const feat = e.features[0]
        const props = feat.properties
        if (props.station_id) onPickStation(props.station_id)
        const html = useCase.popup
          .filter((k) => props[k] !== undefined)
          .map((k) => `<div><b>${k}</b>: ${props[k]}</div>`)
          .join("")
        new maplibregl.Popup().setLngLat(e.lngLat).setHTML(html).addTo(m)

        if (layer.reachRadius && feat.geometry.type === "Polygon") {
          const [lon, lat] = polygonCentroid(feat.geometry.coordinates[0])
          m.getSource("reach-circle").setData({
            type: "FeatureCollection",
            features: [circlePolygon(lon, lat, layer.reachRadius)],
          })
        } else if (m.getSource("reach-circle")) {
          m.getSource("reach-circle").setData({ type: "FeatureCollection", features: [] })
        }
      })
    })

    if (!m.getSource("reach-circle")) {
      m.addSource("reach-circle", { type: "geojson", data: { type: "FeatureCollection", features: [] } })
      m.addLayer({
        id: "reach-circle-line", type: "line", source: "reach-circle",
        paint: { "line-color": "#111827", "line-width": 1.5, "line-dasharray": [2, 2] },
      })
    } else {
      m.getSource("reach-circle").setData({ type: "FeatureCollection", features: [] })
    }

    // The dashboard draws its own station symbols, so the plain point layer would just clutter them.
    if (m.getLayer("stations")) {
      m.setLayoutProperty("stations", "visibility", useCase.dashboard ? "none" : "visible")
    }
    return () => {
      ids.forEach(({ sourceId, layerId }) => {
        if (m.getLayer(layerId)) m.removeLayer(layerId)
        if (m.getSource(sourceId)) m.removeSource(sourceId)
      })
      if (m.getLayer("reach-circle-line")) m.removeLayer("reach-circle-line")
      if (m.getSource("reach-circle")) m.removeSource("reach-circle")
    }
  }, [result, useCase, onPickStation])

  // fly to station
  useEffect(() => {
    if (map.current && activeStation) map.current.flyTo({ center: [activeStation.lon, activeStation.lat], zoom: 14.5 })
  }, [activeStation])

  // fly to a searched point (e.g. a POI), without changing the selected station
  useEffect(() => {
    if (map.current && focusPoint) map.current.flyTo({ center: [focusPoint.lon, focusPoint.lat], zoom: 17 })
  }, [focusPoint])

  return <div ref={container} className="map" />
}
