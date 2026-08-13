import { useEffect, useRef, useState } from "react"

export default function Chatbot({ title, chatFn, suggestions, filterKeys, notReadyLabel, ready, onFilters, onFocus }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const bottom = useRef(null)

  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [messages, busy])

  async function send(text) {
    if (!text.trim() || busy) return
    const history = [...messages, { role: "user", content: text }]
    setMessages(history)
    setInput("")
    setBusy(true)
    try {
      const reply = await chatFn(history)
      setMessages([...history, { role: "assistant", content: reply.answer }])
      const filters = reply.filters || {}
      const any = filterKeys.some((k) => filters[k]?.length)
      if (any) onFilters(Object.fromEntries(filterKeys.map((k) => [k, filters[k] || []])))
      if (reply.focus_station) onFocus(reply.focus_station)
    } catch (e) {
      setMessages([...history, { role: "assistant", content: `Gagal: ${e.message}` }])
    }
    setBusy(false)
  }

  if (!open) {
    return (
      <button className="chat-bubble" onClick={() => setOpen(true)}>
        Tanya data
      </button>
    )
  }

  return (
    <div className="chat">
      <div className="chat-head">
        <b>{title}</b>
        <button className="mini" onClick={() => setOpen(false)}>
          Tutup
        </button>
      </div>

      <div className="chat-body">
        {!ready && <p className="note">{notReadyLabel}</p>}
        {ready && !messages.length && (
          <div className="chat-suggestions">
            {suggestions.map((s) => (
              <button key={s} className="mini" onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.content}
          </div>
        ))}
        {busy && <div className="bubble assistant">Menyusun jawaban…</div>}
        <div ref={bottom} />
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault()
          send(input)
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Tulis pertanyaan…"
          disabled={!ready}
        />
        <button className="primary" disabled={!ready || busy}>
          Kirim
        </button>
      </form>
    </div>
  )
}
