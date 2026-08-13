export const RADII = [100, 200, 300, 400, 500]
export const DEFAULT_RADIUS = 500
export const MIN_RADIUS = 50
export const MAX_RADIUS = 2000

export const CATEGORIES = ["pangan", "minimarket", "kesehatan"]
export const CATEGORY_LABELS = {
  pangan: "Pangan & kuliner",
  minimarket: "Minimarket & toko",
  kesehatan: "Kesehatan",
}
export const CATEGORY_COLORS = { pangan: "#0f766e", minimarket: "#6baed6", kesehatan: "#f59e0b" }

export const EMPTY_FILTERS = { modes: [], missing_categories: [] }

export const SUGGESTIONS = [
  "Stasiun mana yang paling kekurangan kebutuhan dasar?",
  "Stasiun mana yang tidak ada apotek/klinik di sekitarnya?",
  "Tunjukkan stasiun KRL yang minimarket-nya kosong",
  "Bandingkan stasiun dengan pangan paling banyak",
]

/** A row passes when every non-empty filter group contains at least one match. */
export function applyFilters(rows, filters) {
  return rows.filter(
    (r) =>
      (!filters.modes.length || filters.modes.includes(r.mode_label)) &&
      (!filters.missing_categories.length ||
        filters.missing_categories.some((c) => r.missing_categories.includes(c))),
  )
}
