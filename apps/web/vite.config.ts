import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function normalizeBasePath(value: string | undefined): string {
  const fallback = "/ocp/";
  const base = (value ?? "").trim() || fallback;
  const start = base.startsWith("/") ? base : `/${base}`;
  return start.endsWith("/") ? start : `${start}/`;
}

export default defineConfig({
  plugins: [react()],
  base: normalizeBasePath(process.env.VITE_BASE_PATH),
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    sourcemap: true
  }
});
