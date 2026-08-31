import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// On GitHub Pages the site is served from /<repo>/, so assets need that prefix.
// Override with BASE_PATH=/ when using a custom domain or a user/org page.
const base = process.env.BASE_PATH ?? "/fantasy-drafter/";

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 1200 },
});
