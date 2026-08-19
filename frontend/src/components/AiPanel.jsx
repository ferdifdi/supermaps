import { useEffect, useRef, useState } from "react"
import { api } from "../api"

// Per use case, not per persona - M-UC1 (walk access/isochrone) and M-UC2 (amenity
// equity) share the "komuter" persona but analyze completely different things, same for
// K-UC1 (TOD scoring) vs K-UC2 (climate resilience) under "kebijakan". Each question
// here maps to something that use case's result actually contains, not a generic prompt.
const SUGGESTIONS_BY_USECASE = {
  "M-UC1": [
    "Rute mana yang paling aman buat kursi roda?",
    "Titik transfer terdekat dari isochrone ini apa aja?",
    "Kualitas udara di sekitar sini gimana?",
  ],
  "M-UC2": [
    "Kategori kebutuhan dasar apa yang paling kurang di sini?",
    "Kalau radiusnya diperbesar ke 800m, banyak berubah gak?",
    "Area mana dalam isochrone ini paling minim akses POI?",
  ],
  "U-UC1": [
    "Lokasi ini cocok buat bisnis yang saya pilih gak?",
    "Siapa aja kompetitor terdekat dan seberapa ramai?",
    "Traffic generator (kantor/kebutuhan dasar/transit) apa yang paling deket?",
  ],
  "K-UC1": [
    "Kenapa skor TOD stasiun ini segini?",
    "Indikator mana yang paling lemah di stasiun ini?",
    "Stasiun ini rankingnya kalah dari stasiun sekitar karena apa?",
  ],
  "K-UC2": [
    "Ada berapa koridor risiko banjir tinggi di sekitar sini?",
    "Rute paling aman buat hindarin zona banjir gimana?",
    "Kondisi UHI/curah hujan/ekologi kawasan ini gimana?",
  ],
}

const MODELS = [
  { id: "smart", label: "Pintar (120b)" },
  { id: "fast", label: "Cepat (20b)" },
]

// The LLM answers in markdown (**bold**, # heading, - list, ---) but chat bubbles were
// rendering that as raw text with the symbols still in it. No markdown library added -
// this is a small enough subset (bold/italic/code, headings, bullet/numbered lists, hr)
// that a plain parser is simpler than pulling in a dependency for a chat bubble.
function renderInline(text, keyPrefix) {
  const parts = []
  const re = /\*\*(.+?)\*\*|`(.+?)`|\*(.+?)\*/g
  let last = 0
  let match
  let i = 0
  while ((match = re.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    if (match[1] !== undefined) parts.push(<strong key={`${keyPrefix}-${i++}`}>{match[1]}</strong>)
    else if (match[2] !== undefined) parts.push(<code key={`${keyPrefix}-${i++}`}>{match[2]}</code>)
    else parts.push(<em key={`${keyPrefix}-${i++}`}>{match[3]}</em>)
    last = re.lastIndex
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

function renderMarkdown(text) {
  const lines = text.split("\n")
  const blocks = []
  let list = null
  let para = []

  function flushPara() {
    if (para.length) {
      blocks.push(<p key={blocks.length}>{renderInline(para.join(" "), `p${blocks.length}`)}</p>)
      para = []
    }
  }
  function flushList() {
    if (list) {
      const Tag = list.type
      const key = blocks.length
      blocks.push(
        <Tag key={key}>
          {list.items.map((item, i) => <li key={i}>{renderInline(item, `li${key}-${i}`)}</li>)}
        </Tag>
      )
      list = null
    }
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      flushPara()
      flushList()
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)/)
    if (heading) {
      flushPara()
      flushList()
      // Demoted so a chat-bubble "heading" never outsizes the surrounding UI.
      const HeadingTag = heading[1].length <= 2 ? "strong" : "em"
      blocks.push(<p key={blocks.length}><HeadingTag>{renderInline(heading[2], `h${blocks.length}`)}</HeadingTag></p>)
      continue
    }
    if (/^-{3,}$/.test(line)) {
      flushPara()
      flushList()
      blocks.push(<hr key={blocks.length} />)
      continue
    }
    const bullet = line.match(/^[-*]\s+(.*)/)
    if (bullet) {
      flushPara()
      if (!list || list.type !== "ul") {
        flushList()
        list = { type: "ul", items: [] }
      }
      list.items.push(bullet[1])
      continue
    }
    const numbered = line.match(/^\d+\.\s+(.*)/)
    if (numbered) {
      flushPara()
      if (!list || list.type !== "ol") {
        flushList()
        list = { type: "ol", items: [] }
      }
      list.items.push(numbered[1])
      continue
    }
    flushList()
    para.push(line)
  }
  flushPara()
  flushList()
  return blocks
}

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
            {(SUGGESTIONS_BY_USECASE[useCaseId] || []).map((s) => (
              <button key={s} className="mini" onClick={() => send(s)}>{s}</button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.role === "assistant" ? renderMarkdown(m.content) : m.content}
          </div>
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
