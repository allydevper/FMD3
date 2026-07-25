import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Icon } from "../components/Icon";
import { ICO } from "../icons";
import { useApp } from "../context/AppContext";

const GITHUB_URL = "https://github.com/dazedcat19/FMD2";
const GPL_URL = "https://www.gnu.org/licenses/gpl-2.0.html";

const CHANGELOG = `FMD Host
Cliente Tauri + módulos Lua de Free Manga Downloader 2

Changelog:
([!] Importante, [+] Añadido, [-] Eliminado, [*] Cambio/corrección)

0.1.0 (MVP)
[+] Shell OmniManga: Descargas, Información, Favoritos, Opciones, Sobre
[+] Cola de descarga con SQLite y progreso en vivo
[+] Favoritos: revisar capítulos nuevos y encolar
[+] Catálogo + filtro avanzado (UI) + GetInfo
[+] Opciones alineadas a FMD2 (guardar en, renombrado, sitios, módulos)
[+] Bypass Cloudflare básico / websitebypass de FMD2
[*] Mismos módulos Lua que FMD2 (recursos empaquetados)

— Historial completo de FMD2 —
https://github.com/dazedcat19/FMD2`;

type AboutTab = "fmd" | "log";

function AboutLink({ url, children }: { url: string; children: string }) {
  return (
    <button type="button" className="lnk about-link" onClick={() => void openUrl(url)}>
      {children}
    </button>
  );
}

export function AboutView() {
  const { modules, log, activeNav } = useApp();
  const [tab, setTab] = useState<AboutTab>("fmd");

  const modulesCount = modules.length;
  const modulesLabel = modulesCount === 1 ? "1 módulo" : `${modulesCount} módulos`;
  const runtimeLabel = `Tauri 2 · Rust · ${navigator.platform || "web"}`;

  return (
    <section id="view-about" className="view" hidden={activeNav !== "about"}>
      <div className="about-shell">
        <header className="about-header">
          <div>
            <div className="about-eyebrow">Información del cliente</div>
            <h1 className="about-title">Sobre</h1>
          </div>
          <div className="about-header-actions">
            <div className="about-meta-block">
              <div className="about-meta-row">
                <span className="about-meta-k">Versión</span>
                <span className="mono">0.1.0</span>
              </div>
              <div className="about-meta-row">
                <span className="about-meta-k">Revisión</span>
                <span className="mono">MVP</span>
              </div>
            </div>
            <div className="about-header-sep"></div>
            <button
              type="button"
              className="about-btn-p"
              onClick={() => log("Comprobar actualizaciones: próximamente", "ok")}
            >
              <Icon ico={ICO.refresh} className="ico ico-sm" />
              Revisar última versión
            </button>
            <button type="button" className="about-btn-ghost" onClick={() => void openUrl(GITHUB_URL)}>
              <Icon ico={ICO.globe} className="ico ico-sm" />
              Proyecto FMD2
            </button>
          </div>
        </header>

        <div className="about-tabs" role="tablist" aria-label="Sobre">
          <button
            type="button"
            className={`about-tab${tab === "fmd" ? " on" : ""}`}
            role="tab"
            aria-selected={tab === "fmd"}
            onClick={() => setTab("fmd")}
          >
            Sobre FMD
          </button>
          <button
            type="button"
            className={`about-tab${tab === "log" ? " on" : ""}`}
            role="tab"
            aria-selected={tab === "log"}
            onClick={() => setTab("log")}
          >
            Historial de cambios
          </button>
        </div>

        <div className="about-body">
          <div className="about-pane" hidden={tab !== "fmd"}>
            <div className="about-scroll">
              <div className="about-card">
                <div className="about-kv">
                  <span className="about-kv-k">Proyecto</span>
                  <span className="about-kv-v">FMD Host</span>
                </div>
                <div className="about-kv">
                  <span className="about-kv-k">Basado en</span>
                  <span className="about-kv-v">Free Manga Downloader 2 (módulos Lua)</span>
                </div>
                <div className="about-kv">
                  <span className="about-kv-k">Página</span>
                  <AboutLink url={GITHUB_URL}>{GITHUB_URL}</AboutLink>
                </div>
                <div className="about-kv">
                  <span className="about-kv-k">Licencia</span>
                  <AboutLink url={GPL_URL}>GPLv2</AboutLink>
                </div>
              </div>

              <p className="about-lead">
                Cliente moderno (Rust + Tauri) que reutiliza los módulos Lua de Free Manga Downloader 2:
                misma sesión HTTP, hooks por imagen y catálogo/favoritos/cola en SQLite.
              </p>

              <h2 className="about-h">Desarrolladores FMD2</h2>
              <ul className="about-list">
                <li>NhKPaNdA</li>
                <li>dazedcat19</li>
              </ul>

              <h2 className="about-h">Desarrolladores anteriores</h2>
              <ul className="about-list about-list-inline">
                <li>Akarin-K</li>
                <li>Anastasiadinara</li>
                <li>SDXC</li>
                <li>kavin-90</li>
                <li>kmvi</li>
                <li>riderkick</li>
              </ul>

              <h2 className="about-h">Stack de este cliente</h2>
              <ul className="about-list">
                <li>Rust + Tauri 2</li>
                <li>Lua 5.4 (mlua) — módulos y plantillas FMD2</li>
                <li>SQLite — cola y favoritos</li>
                <li>reqwest — HTTP / cookies / compresión</li>
              </ul>

              <h2 className="about-h">Bibliotecas y herramientas (línea FMD2)</h2>
              <ul className="about-list about-list-compact">
                <li>Lua · SQLite · OpenSSL · LibWebp · Brotli · Zstd · 7-Zip</li>
                <li>Plantillas y módulos del árbol FMD2 empaquetados con la app</li>
              </ul>
            </div>
          </div>

          <div className="about-pane" hidden={tab !== "log"}>
            <pre className="about-changelog">{CHANGELOG}</pre>
          </div>
        </div>

        <footer className="about-footer">
          <span className="about-footer-stat">
            <span className="fav-dot" style={{ background: "var(--accent)" }}></span>
            <span>FMD Host</span>
          </span>
          <span className="about-footer-muted mono">{runtimeLabel}</span>
          <span className="about-footer-muted mono">{modulesLabel}</span>
          <div className="about-footer-spacer"></div>
          <span className="about-footer-muted">Compatible con módulos Lua de FMD2</span>
        </footer>
      </div>
    </section>
  );
}
