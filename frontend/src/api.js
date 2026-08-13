const API = (import.meta.env.VITE_API_URL || "http://localhost:8000").replace(/\/$/, "")

async function errorText(r) {
  const text = await r.text()
  try {
    return JSON.parse(text).detail || text
  } catch {
    return text
  }
}

async function get(path) {
  const r = await fetch(`${API}${path}`)
  if (!r.ok) throw new Error(await errorText(r))
  return r.json()
}

async function post(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(await errorText(r))
  return r.json()
}

export const api = {
  base: API,
  styles: () => get("/api/basemap/styles"),
  stations: () => get("/api/stations"),
  walkAccess: (id, minutes) => get(`/api/analysis/walk-access?station_id=${id}&minutes=${minutes}`),
  amenityEquity: (id, radius) => get(`/api/analysis/amenity-equity?station_id=${id}&radius=${radius}`),
  siteSelection: (id, category) => get(`/api/analysis/site-selection?station_id=${id}&category=${category}`),
  resilience: (id) => get(`/api/analysis/resilience?station_id=${id}`),
  todDashboard: (modes) => get(`/api/analysis/tod-dashboard?modes=${modes}`),
  todMetadata: () => get("/api/analysis/tod-metadata"),
  todWhatIf: (stationId, overrides) => post("/api/analysis/tod-whatif", { station_id: stationId, overrides }),
  chat: (messages) => post("/api/ai/chat", { messages }),
  insight: async (useCase, audience, summary) =>
    (await post("/api/ai/insight", { use_case: useCase, audience, summary })).text,
}
