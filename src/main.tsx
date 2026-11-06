import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import LeagueDesk from "./routes/LeagueDesk";
import Builder from "./routes/Builder";
import Method from "./routes/Method";
import Fixtures from "./routes/Fixtures";
import MyTeam from "./routes/MyTeam";
import Autopilot from "./routes/Autopilot";
import "./index.css";

// HashRouter, not BrowserRouter: GitHub Pages serves static files, so a deep
// link like /builder would 404 on refresh without a server-side rewrite.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<LeagueDesk />} />
          <Route path="/builder" element={<Builder />} />
          <Route path="/fixtures" element={<Fixtures />} />
          <Route path="/my-team" element={<MyTeam />} />
          <Route path="/autopilot" element={<Autopilot />} />
          <Route path="/method" element={<Method />} />
          <Route path="*" element={<LeagueDesk />} />
        </Route>
      </Routes>
    </HashRouter>
  </StrictMode>,
);

// Installed-app support: open instantly and work offline. Production only — a
// worker caching dev-server modules makes hot reload lie.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .catch(() => {
        /* unsupported context (e.g. private mode) — the site still works */
      });
  });
}
