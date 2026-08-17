import AiPanel from "./AiPanel"

// One shared AI dock for every use case - same .dock shell as EquityDock/WalkDock/etc,
// but there's only ever one "ask about the result" panel, so it doesn't need per-use-case
// variants like the real docks do. Per-use-case behavior lives in the backend system
// prompt (ai.py ASK_CONTEXT), not here.
export default function AiDock({ open, onToggle, useCaseId, label, persona, result }) {
  return (
    <>
      <button className={open ? "dock-toggle open" : "dock-toggle"} onClick={onToggle}>
        {open ? "›" : "‹"}
      </button>
      <aside className={open ? "dock open" : "dock"}>
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
