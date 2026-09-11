import AiPanel from "./AiPanel"

// One shared AI dock for every use case - same .dock shell as EquityDock/WalkDock/etc,
// but there's only ever one "ask about the result" panel, so it doesn't need per-use-case
// variants like the real docks do. Per-use-case behavior lives in the backend system
// prompt (ai.py ASK_CONTEXT), not here.
export default function AiDock({ hidden, open, onToggle, useCaseId, label, persona, result }) {
  // `hidden` keeps this mounted (so AiPanel's chat state survives switching to "Hasil"
  // and back) while removing it from layout/paint - display:none directly on the two
  // flex-row-level elements themselves, not a wrapping <div>, so .dock stays a direct
  // flex sibling and its height-from-stretching still works when it's shown again.
  const style = hidden ? { display: "none" } : undefined
  return (
    <>
      <button className={open ? "dock-toggle open" : "dock-toggle"} onClick={onToggle} style={style}>
        {open ? "›" : "‹"}
      </button>
      <aside className={open ? "dock open" : "dock"} style={style}>
        <div className="tabs">
          <span className="tab active">Tanya AI</span>
        </div>
        <div className="dock-body">
          <AiPanel useCaseId={useCaseId} label={label} persona={persona} result={result} />
        </div>
      </aside>
    </>
  )
}
