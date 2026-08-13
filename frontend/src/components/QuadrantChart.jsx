import { CLASS_COLORS } from "../tod"

const SIZE = 320
const PAD = 28

const median = (values) => {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Impact on Y, benefit on X. Axes are fixed 0..1 so stations stay comparable between filters. */
export default function QuadrantChart({ rows, selected, onSelect }) {
  if (!rows.length) return <p className="note">Tidak ada stasiun yang cocok dengan filter.</p>

  const midImpact = median(rows.map((r) => r.impact))
  const midBenefit = median(rows.map((r) => r.benefit))
  const x = (v) => PAD + v * (SIZE - 2 * PAD)
  const y = (v) => SIZE - PAD - v * (SIZE - 2 * PAD)

  return (
    <>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="quadrant">
        <line x1={PAD} y1={SIZE - PAD} x2={SIZE - PAD} y2={SIZE - PAD} stroke="#e5e7eb" />
        <line x1={PAD} y1={PAD} x2={PAD} y2={SIZE - PAD} stroke="#e5e7eb" />
        <line x1={x(midBenefit)} y1={PAD} x2={x(midBenefit)} y2={SIZE - PAD} stroke="#d1d5db" strokeDasharray="3 3" />
        <line x1={PAD} y1={y(midImpact)} x2={SIZE - PAD} y2={y(midImpact)} stroke="#d1d5db" strokeDasharray="3 3" />

        <text x={x(midBenefit) + 6} y={PAD + 12} className="quadrant-label">quick win</text>
        <text x={PAD + 4} y={PAD + 12} className="quadrant-label">effort besar</text>
        <text x={x(midBenefit) + 6} y={SIZE - PAD - 6} className="quadrant-label">rawat saja</text>
        <text x={PAD + 4} y={SIZE - PAD - 6} className="quadrant-label">prioritas rendah</text>

        {rows.map((r) => (
          <circle
            key={r.station_id}
            cx={x(r.benefit)}
            cy={y(r.impact)}
            r={r.station_id === selected ? 7 : 4}
            fill={CLASS_COLORS[r.classification]}
            stroke={r.station_id === selected ? "#111827" : "#fff"}
            onClick={() => onSelect(r.station_id)}
          >
            <title>{`${r.station} — dampak ${r.impact}, keuntungan ${r.benefit}`}</title>
          </circle>
        ))}

        <text x={SIZE / 2} y={SIZE - 6} textAnchor="middle" className="quadrant-axis">
          keuntungan / kemudahan →
        </text>
        <text x={10} y={SIZE / 2} transform={`rotate(-90 10 ${SIZE / 2})`} textAnchor="middle" className="quadrant-axis">
          dampak →
        </text>
      </svg>

      <p className="note">
        Dampak = 1 − SCI. Keuntungan = rata-rata akses jalan kaki, aksesibilitas, dan fasilitas
        stasiun. Garis putus-putus adalah median tiap sumbu.
      </p>

      <div className="board">
        {rows
          .filter((r) => r.quadrant === "quick win")
          .map((r) => (
            <button key={r.station_id} className="board-row" onClick={() => onSelect(r.station_id)}>
              <span className="board-name">{r.station}</span>
              <span className="board-value">quick win</span>
            </button>
          ))}
      </div>
    </>
  )
}
