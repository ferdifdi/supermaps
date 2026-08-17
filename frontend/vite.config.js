import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// sourcemap: true so a prod-build crash's stack trace points at real file/line, not
// minified bundle positions - otherwise ErrorBoundary's stack dump is unreadable.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: { sourcemap: true },
})
