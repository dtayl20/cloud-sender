import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [react(), tailwindcss(), tsconfigPaths()],
  server: {
    host: "::",
    port: 8080,
    strictPort: true,
    proxy: {
      // Without the Worker running, UI work still loads.
      // Locally with `wrangler dev` on :8787, uncomment to proxy:
      // "/api": "http://localhost:8787",
    },
  },
  build: {
    outDir: "dist",
  },
});
