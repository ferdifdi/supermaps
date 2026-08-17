import { useRef, useState } from "react"
import { PERSONAS } from "../usecases"

// Simple self-contained line icons (not fetched assets - no license/network dependency,
// renders instantly, matches the app's rounded/friendly style).
const ICONS = {
  walker: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="13" cy="4" r="1.8" />
      <path d="M10 8l3-1 2.5 2.5L18 11" />
      <path d="M13 7l-1 5-3.5 3M12 12l1.5 2L13 20M9.5 15l-2.5 1.5" />
    </svg>
  ),
  storefront: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9l1-4h14l1 4" />
      <path d="M4 9a2 2 0 004 0 2 2 0 004 0 2 2 0 004 0 2 2 0 004 0" />
      <path d="M5 9v9h14V9" />
      <path d="M10 18v-5h4v5" />
    </svg>
  ),
  landmark: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21h18" />
      <path d="M4 21V10M8 21V10M12 21V10M16 21V10M20 21V10" />
      <path d="M2 10l10-6 10 6" />
    </svg>
  ),
}

// Hand-drawn (not fetched) transit-themed illustration - fills the empty space on wide
// screens without pulling in a stock photo (no license to track, no network dependency).
function Illustration() {
  return (
    <svg className="role-illustration" viewBox="0 0 420 340" fill="none" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="210" cy="300" rx="170" ry="18" fill="#5b4bdb" opacity=".06" />
      <g opacity=".9">
        <rect x="30" y="150" width="46" height="140" rx="6" fill="#eef0ff" />
        <rect x="86" y="110" width="46" height="180" rx="6" fill="#f3ecfb" />
        <rect x="142" y="170" width="46" height="120" rx="6" fill="#eef0ff" />
        <rect x="290" y="130" width="46" height="160" rx="6" fill="#f3ecfb" />
        <rect x="346" y="165" width="46" height="125" rx="6" fill="#eef0ff" />
        {[30, 86, 142, 290, 346].map((x, gi) =>
          Array.from({ length: 6 }).map((_, i) => (
            <rect key={`${gi}-${i}`} x={x + 10 + (i % 2) * 20} y={190 + Math.floor(i / 2) * 24} width="8" height="10" rx="1.5" fill="#b87cf6" opacity=".35" />
          )),
        )}
      </g>
      <path d="M20 260 C 90 220, 150 240, 210 200 S 340 150, 400 190" stroke="#5b4bdb" strokeWidth="4" strokeLinecap="round" strokeDasharray="1 14" opacity=".5" />
      <circle cx="90" cy="228" r="6" fill="#4a90e2" />
      <circle cx="210" cy="201" r="6" fill="#f06fae" />
      <circle cx="340" cy="163" r="6" fill="#4a90e2" />
      <g transform="translate(188, 130)">
        <path
          d="M22 2C12.5 2 5 9.5 5 19c0 12 15.5 24.6 16.2 25.15a1 1 0 001.6 0C23.5 43.6 39 31 39 19c0-9.5-7.5-17-17-17z"
          fill="#5b4bdb"
        />
        <g fill="#fff">
          <ellipse cx="22" cy="23.5" rx="5.6" ry="4.5" />
          <circle cx="14.7" cy="16.2" r="2.7" />
          <circle cx="22" cy="13.6" r="2.9" />
          <circle cx="29.3" cy="16.2" r="2.7" />
        </g>
      </g>
      <circle cx="70" cy="70" r="5" fill="#f06fae" opacity=".5" />
      <circle cx="360" cy="80" r="4" fill="#b87cf6" opacity=".5" />
      <circle cx="340" cy="240" r="4" fill="#4a90e2" opacity=".4" />
    </svg>
  )
}

export default function RoleSelect({ onSelect }) {
  const trackRef = useRef(null)
  const [active, setActive] = useState(0)

  // Mobile: cards scroll-snap horizontally (native touch swipe, no gesture lib needed) -
  // this just tracks which card is centered so the dots below stay in sync.
  function onScroll() {
    const el = trackRef.current
    if (!el) return
    const i = Math.round(el.scrollLeft / el.clientWidth)
    setActive(Math.max(0, Math.min(PERSONAS.length - 1, i)))
  }

  function goTo(i) {
    const el = trackRef.current
    if (!el) return
    el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" })
  }

  return (
    <div className="role-select">
      <div className="role-illustration-pane">
        <Illustration />
      </div>

      <div className="role-select-content">
        <header className="role-brand">
          <svg className="role-brand-mark" viewBox="0 0 24 26" fill="none">
            <path
              d="M12 1C6.75 1 2.5 5.25 2.5 10.5c0 6.5 8.16 13.4 8.51 13.69a1.5 1.5 0 001.98 0c.35-.29 8.51-7.19 8.51-13.69C21.5 5.25 17.25 1 12 1z"
              fill="#5b4bdb"
            />
            <g fill="#fff">
              <ellipse cx="12" cy="13.2" rx="3.1" ry="2.5" />
              <circle cx="7.6" cy="9.4" r="1.5" />
              <circle cx="12" cy="7.8" r="1.6" />
              <circle cx="16.4" cy="9.4" r="1.5" />
            </g>
          </svg>
          <h1>SuperMaps</h1>
          <p>Selamat datang di SuperMaps</p>
          <p className="role-brand-sub">Silakan pilih role Anda</p>
        </header>

        <div className="role-cards" ref={trackRef} onScroll={onScroll}>
          {PERSONAS.map((p) => (
            <button key={p.id} className="role-card" onClick={() => onSelect(p.id)}>
              <span className="role-icon">{ICONS[p.icon]}</span>
              <span className="role-card-text">
                <b>{p.label}</b>
                <span>{p.tagline}</span>
              </span>
              <span className="role-arrow">→</span>
            </button>
          ))}
        </div>

        <div className="role-dots">
          {PERSONAS.map((p, i) => (
            <button key={p.id} className={i === active ? "role-dot active" : "role-dot"} onClick={() => goTo(i)} aria-label={p.label} />
          ))}
        </div>
      </div>
    </div>
  )
}
