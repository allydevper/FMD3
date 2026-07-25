import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const el = document.querySelector("#app");
if (!el) throw new Error("#app not found");

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
