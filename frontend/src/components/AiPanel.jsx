import { useEffect, useRef, useState } from "react"
import { api } from "../api"

const SUGGESTIONS_BY_PERSONA = {
  komuter: ["Rute mana yang paling nyaman?", "Area ini ramah kursi roda gak?", "Kualitas udaranya gimana?"],
  usaha: ["Lokasi ini cocok buat usaha saya gak?", "Siapa kompetitor terdekat?", "Apa risiko buka di sini?"],
  kebijakan: ["Stasiun mana paling butuh prioritas?", "Apa risiko iklim di kawasan ini?", "Rekomendasi kebijakannya apa?"],
}

const MODELS = [
  { id: "smart", label: "Pintar (120b)" },
  { id: "fast", label: "Cepat (20b)" },
]

// Same result shape for every use case, but the questions people actually ask are
// business/practical, not "explain this grid cell" - the backend system prompt (ai.py
// ASK_CONTEXT/ASK_SYSTEM) is what varies per use case, this component is generic.
export default function AiPanel({ useCaseId, label, persona, result }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [model, setModel] = useState("smart")
  const bottom = useRef(null)
  const ready = Boolean(result)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" })
  }, [messages, busy])

  useEffect(() => {
    setMessages([])
  }, [useCaseId, result])

  async function send(text) {
    if (!text.trim() || busy || !ready) return
    const history = [...messages, { role: "user", content: text }]
    setMessages(history)
    setInput("")
    setBusy(true)
    try {
      const answer = await api.askAi(useCaseId, label, history, result, model)
      setMessages([...history, { role: "assistant", content: answer }])
    } catch (e) {
      const limited = e.message.includes("rate-limited")
      setMessages([...history, { role: "assistant", content: `${limited ? "⚠ " : "Gagal: "}${e.message}` }])
    }
    setBusy(false)
  }

  if (!ready) {
    return (
      <div className="section">
        <p className="note">
          Belum ada hasil untuk ditanya. Jalankan analisis dulu di tab "Analisis", baru AI bisa jawab
          pertanyaan seputar hasilnya.
        </p>
      </div>
    )
  }

  return (
    <div className="ai-panel">
      <div className="dock-actions" style={{ padding: "0 0 8px" }}>
        {MODELS.map((m) => (
          <button key={m.id} className={model === m.id ? "mini active" : "mini"} onClick={() => setModel(m.id)}>
            {m.label}
          </button>
        ))}
      </div>

      <div className="chat-body">
        {!messages.length && (
          <div className="chat-suggestions">
            {(SUGGESTIONS_BY_PERSONA[persona] || []).map((s) => (
              <button key={s} className="mini" onClick={() => send(s)}>{s}</button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>{m.content}</div>
        ))}
        {busy && <div className="bubble assistant">Menyusun jawaban…</div>}
        <div ref={bottom} />
      </div>

      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send(input) }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Tanya apa saja seputar hasil ini…"
        />
        <button className="primary" disabled={busy}>Kirim</button>
      </form>
    </div>
  )
}
