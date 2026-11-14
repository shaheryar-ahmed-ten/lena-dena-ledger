import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// React lives in client/. In development, /api calls go to the Express server on port 3001.
export default defineConfig({
  root: "client",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/api": "http://localhost:3001" } },
});
