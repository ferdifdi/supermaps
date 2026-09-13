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
  stations: (mode) =>
    get(`/api/stations${mode ? `?mode=${mode}` : ""}`),
  railLines: () => get("/api/rail-lines"),
  walkAccess: (id, radiusM) =>
    get(`/api/analysis/walk-access?station_id=${id}&radius_m=${radiusM}`),
  amenityEquity: (id, radius) =>
    get(`/api/analysis/amenity-equity?station_id=${id}&radius=${radius}`),
  route: (id, lon, lat, preference) =>
    get(`/api/analysis/route?station_id=${id}&lon=${lon}&lat=${lat}&preference=${preference}`),
  siteSelection: (id, businessType, subtype, subtype2) =>
    get(`/api/analysis/site-selection?station_id=${id}&business_type=${encodeURIComponent(businessType)}${subtype ? `&subtype=${encodeURIComponent(subtype)}` : ""}${subtype2 ? `&subtype2=${encodeURIComponent(subtype2)}` : ""}`),
  businessTypes: () => get("/api/analysis/business-types"),
  businessSubtypes: (prefix) => get(`/api/analysis/business-subtypes?prefix=${encodeURIComponent(prefix)}`),
  businessSubtypes2: (prefix, subtype) =>
    get(`/api/analysis/business-subtypes2?prefix=${encodeURIComponent(prefix)}${subtype ? `&subtype=${encodeURIComponent(subtype)}` : ""}`),
  resilience: (id) => get(`/api/analysis/resilience?station_id=${id}`),
  surveyForStation: (id) => get(`/api/survey/station/${id}`),
  todDashboard: (modes) => get(`/api/analysis/tod-dashboard?modes=${modes}`),
  todMetadata: () => get("/api/analysis/tod-metadata"),
  todWhatIf: (stationId, overrides) => post("/api/analysis/tod-whatif", { station_id: stationId, overrides }),
  askAi: async (useCaseId, label, messages, result, model) =>
    (await post("/api/ai/ask", { use_case_id: useCaseId, label, messages, result, model })).answer,
  insight: async (useCase, audience, summary) =>
    (await post("/api/ai/insight", { use_case: useCase, audience, summary })).text,
}
