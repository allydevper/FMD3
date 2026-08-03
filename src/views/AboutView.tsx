import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Icon } from "../components/Icon";
import { ICO } from "../icons";
import { useApp } from "../context/AppContext";
import { runAppUpdateCheck } from "../utils/appUpdate";

const GITHUB_URL = "https://github.com/allydevper/FMD3";
const FMD2_URL = "https://github.com/dazedcat19/FMD2";
const GPL_URL = "https://www.gnu.org/licenses/gpl-2.0.html";

const CHANGELOG = `FMD Host (FMD3)
Cliente Tauri + React + módulos Lua de Free Manga Downloader 2

Changelog:
([!] Importante, [+] Añadido, [-] Eliminado, [*] Cambio/corrección)

0.1.0 (01.08.2026)
[+] Favoritos: menú contextual, revisión de capítulos y miniatura
[+] Papelera de títulos ocultos (restaurar / eliminar)
[+] Confirmaciones al salir, borrar y vaciar listas
[+] Descargas: tag de formato, menú contextual y cola por prioridad
[+] Empaquetado / compresión de capítulos (ZIP·CBZ y afines)
[+] Self-updater vía GitHub Releases (allydevper/FMD3)
[+] Opciones: comprobar versión al iniciar
[*] Rutas largas, hilos de favoritos y reordenación de cola
[*] Borrar tareas completadas al cerrar (opción)
[*] «Información» pasa a llamarse «Explorar»
[*] Opciones reordenadas: Descargas y Red separadas, Diálogos dentro de General

0.1.0 (MVP · base)
[+] Shell: Descargas, Información, Favoritos, Opciones, Sobre
[+] Cola de descarga con SQLite y progreso en vivo
[+] Favoritos: revisar capítulos nuevos y encolar
[+] Catálogo + filtro avanzado (UI) + GetInfo
[+] Opciones alineadas a FMD2 (guardar en, renombrado, sitios, módulos)
[+] Bypass Cloudflare / websitebypass FMD2 (+ Duktape)
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
  const [version, setVersion] = useState("…");
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion("0.1.0"));
  }, []);

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
                <span className="mono">{version}</span>
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
              disabled={checking}
              onClick={() => {
                if (checking) return;
                setChecking(true);
                void (async () => {
                  try {
                    await runAppUpdateCheck(log, { notifyResult: true });
                  } catch {
                    // already logged
                  } finally {
                    setChecking(false);
                  }
                })();
              }}
            >
              <Icon ico={ICO.refresh} className="ico ico-sm" />
              {checking ? "Comprobando…" : "Revisar última versión"}
            </button>
            <button type="button" className="about-btn-ghost" onClick={() => void openUrl(GITHUB_URL)}>
              <Icon ico={ICO.globe} className="ico ico-sm" />
              Proyecto FMD3
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
                  <span className="about-kv-v">FMD Host (FMD3)</span>
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
                  <span className="about-kv-k">Lua (FMD2)</span>
                  <AboutLink url={FMD2_URL}>{FMD2_URL}</AboutLink>
                </div>
                <div className="about-kv">
                  <span className="about-kv-k">Licencia</span>
                  <AboutLink url={GPL_URL}>GPLv2</AboutLink>
                </div>
              </div>

              <p className="about-lead">
                Cliente de escritorio (Rust + Tauri + React) que reutiliza los módulos Lua de Free Manga
                Downloader 2: misma sesión HTTP, websitebypass/Duktape, y catálogo/favoritos/cola en SQLite.
              </p>

              <h2 className="about-h">Desarrollador FMD3</h2>
              <ul className="about-list">
                <li>allydevper</li>
              </ul>

              <h2 className="about-h">Desarrolladores FMD2</h2>
              <ul className="about-list">
                <li>NhKPaNdA</li>
                <li>dazedcat19</li>
              </ul>

              <h2 className="about-h">Desarrolladores anteriores (FMD)</h2>
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
                <li>Rust + Tauri 2 + React</li>
                <li>Lua 5.4 (mlua) — módulos y plantillas FMD2</li>
                <li>SQLite — cola, favoritos y catálogo</li>
                <li>reqwest — HTTP / cookies / compresión</li>
                <li>Duktape — challenges websitebypass (paridad FMD2)</li>
              </ul>

              <h2 className="about-h">Recursos FMD2 empaquetados</h2>
              <ul className="about-list about-list-compact">
                <li>Módulos, plantillas, utils y websitebypass del árbol FMD2</li>
                <li>Compatible con la misma API Lua que el cliente Lazarus</li>
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
            <span>FMD Host · FMD3</span>
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
