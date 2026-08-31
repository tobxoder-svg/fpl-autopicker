import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import Landing from "./routes/Landing";
import Builder from "./routes/Builder";
import Method from "./routes/Method";
import "./index.css";

// HashRouter, not BrowserRouter: GitHub Pages serves static files, so a deep
// link like /builder would 404 on refresh without a server-side rewrite.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Landing />} />
          <Route path="/builder" element={<Builder />} />
          <Route path="/method" element={<Method />} />
          <Route path="*" element={<Landing />} />
        </Route>
      </Routes>
    </HashRouter>
  </StrictMode>,
);
