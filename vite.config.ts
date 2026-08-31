import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Root by default — what Vercel, Netlify, a custom domain and `npm run dev` all
// serve from. GitHub Pages is the exception, since a project page lives under
// /<repo>/, so the Pages workflow sets BASE_PATH explicitly.
//
// Getting this wrong fails silently and totally: index.html loads, every asset
// 404s, and the page renders blank with nothing on screen to explain why.
const base = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 1200 },
});
