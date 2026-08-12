const API = import.meta.env.VITE_API_URL || "http://localhost:8000"

async function get(path) {
  const r = await fetch(`${API}${path}`)
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

export const api = {
  base: API,
  styles: () => get("/api/basemap/styles"),
  stations: () => get("/api/stations"),
  walkAccess: (id, minutes) => get(`/api/analysis/walk-access?station_id=${id}&minutes=${minutes}`),
  amenityEquity: (id) => get(`/api/analysis/amenity-equity?station_id=${id}`),
  siteSelection: (id, category) => get(`/api/analysis/site-selection?station_id=${id}&category=${category}`),
  todIndex: (ids) => get(`/api/analysis/tod-index?station_ids=${ids.join(",")}`),
  resilience: (id) => get(`/api/analysis/resilience?station_id=${id}`),
  insight: async (useCase, audience, summary) => {
    const r = await fetch(`${API}/api/ai/insight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ use_case: useCase, audience, summary }),
    })
    if (!r.ok) throw new Error(await r.text())
    return (await r.json()).text
  },
}
