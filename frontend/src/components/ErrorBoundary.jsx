import { Component } from "react"

// Without this, an uncaught render error unmounts the whole tree and leaves a blank
// white page with nothing but a console stack trace - this at least shows something.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    this.setState({ info })
    console.error("Render error:", error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: "monospace", maxWidth: 720, margin: "40px auto", fontSize: 12 }}>
          <h2 style={{ color: "#ef4444", fontFamily: "sans-serif" }}>Terjadi error di tampilan</h2>
          <p style={{ fontWeight: "bold" }}>{String(this.state.error?.message || this.state.error)}</p>
          <pre style={{ whiteSpace: "pre-wrap", background: "#f3f4f6", padding: 12, borderRadius: 8, overflow: "auto" }}>
            {this.state.error?.stack}
          </pre>
          {this.state.info?.componentStack && (
            <>
              <p style={{ fontWeight: "bold", fontFamily: "sans-serif" }}>Component stack:</p>
              <pre style={{ whiteSpace: "pre-wrap", background: "#f3f4f6", padding: 12, borderRadius: 8, overflow: "auto" }}>
                {this.state.info.componentStack}
              </pre>
            </>
          )}
          <button onClick={() => this.setState({ error: null, info: null })} style={{ padding: "8px 16px", cursor: "pointer", fontFamily: "sans-serif" }}>
            Coba lagi
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
