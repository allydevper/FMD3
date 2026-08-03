import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

/** Block WebView native context menu (Reload/Print/Inspect) — custom menus use preventDefault too. */
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

const el = document.querySelector("#app");
if (!el) throw new Error("#app not found");

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
