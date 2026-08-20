export const MODES = ["KRL", "MRT", "LRT", "TJ"]
export const CLASSIFICATIONS = ["tinggi", "sedang", "rendah"]
export const TYPOLOGIES = ["mixed-use", "retail cepat", "housing-support", "pembenahan dasar"]

export const CLASS_COLORS = { tinggi: "#f06fae", sedang: "#b87cf6", rendah: "#4a90e2" }

export const EMPTY_FILTERS = { modes: [], classifications: [], typologies: [] }

export const CRITERIA_LABELS = {
  density: "Kepadatan",
  land_use_diversity: "Keragaman guna lahan",
  walk_access: "Akses jalan kaki",
  economy: "Ekonomi",
  station_capacity: "Kapasitas stasiun",
  station_facility: "Fasilitas stasiun",
  accessibility: "Aksesibilitas dari & ke stasiun",
  parking: "Ketersediaan parkir",
}

export const QUADRANTS = [
  "quick win",
  "dampak tinggi, effort besar",
  "sudah baik, rawat saja",
  "prioritas rendah",
]

/** A row passes when every non-empty filter group contains its value. */
export function applyFilters(rows, filters) {
  return rows.filter(
    (r) =>
      (!filters.modes.length || filters.modes.includes(r.mode_label)) &&
      (!filters.classifications.length || filters.classifications.includes(r.classification)) &&
      (!filters.typologies.length || filters.typologies.includes(r.typology)),
  )
}
