import { useEffect, useRef } from "react"
import maplibregl from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"

const JAKARTA = [106.8271129, -6.1754398]

export default function MapView({ styleUrl, stations, activeStation, result, useCase, onPickStation }) {
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
        const props = e.features[0].properties
        const html = useCase.popup
          .filter((k) => props[k] !== undefined)
          .map((k) => `<div><b>${k}</b>: ${props[k]}</div>`)
          .join("")
        new maplibregl.Popup().setLngLat(e.lngLat).setHTML(html).addTo(m)
      })
    })
    return () => {
      ids.forEach(({ sourceId, layerId }) => {
        if (m.getLayer(layerId)) m.removeLayer(layerId)
        if (m.getSource(sourceId)) m.removeSource(sourceId)
      })
    }
  }, [result, useCase])

  // fly to station
  useEffect(() => {
    if (map.current && activeStation) map.current.flyTo({ center: [activeStation.lon, activeStation.lat], zoom: 14.5 })
  }, [activeStation])

  return <div ref={container} className="map" />
}
