import { useEffect, useMemo, useState } from "react"
import MapView from "./MapView"
import { api } from "./api"
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

  useEffect(() => {
    api.styles().then((s) => { setStyles(s); setStyleUrl(s[0].url) })
    api.stations().then(setStations)
  }, [])

  const useCase = USE_CASES.find((u) => u.id === useCaseId)
  const station = stations.find((s) => s.id === stationId)
  const personaUseCases = USE_CASES.filter((u) => u.persona === persona)

  const nearbyIds = useMemo(() => {
    if (!station) return []
    return stations
      .map((s) => ({ s, d: (s.lon - station.lon) ** 2 + (s.lat - station.lat) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 10)
      .map((x) => x.s.id)
  }, [station, stations])

  async function run() {
    if (!station) return setStatus("Pilih stasiun dulu.")
    setStatus("Menjalankan analisis…")
    setResult(null)
    setInsight("")
    try {
      const data = await useCase.run(station, { category, stationIds: nearbyIds })
      setResult(data)
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

  return (
    <div className="app">
      <aside className="sidebar">
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
          <label>Stasiun</label>
          <select value={stationId} onChange={(e) => setStationId(e.target.value)}>
            <option value="">— pilih stasiun —</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.mode})</option>
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
          {useCase.multiStation && station && (
            <p className="note">Indeks dihitung relatif terhadap 10 stasiun terdekat.</p>
          )}
          <button className="primary" onClick={run}>Jalankan analisis</button>
          {status && <p className="note">{status}</p>}
        </div>

        {result?.summary && (
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
            result={result}
            useCase={useCase}
            onPickStation={setStationId}
          />
        )}
        {result && (
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
      </main>
    </div>
  )
}
