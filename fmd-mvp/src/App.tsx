import { useEffect } from "react";
import { CatalogJobBar } from "./components/CatalogJobBar";
import { Icon } from "./components/Icon";
import { ICO } from "./icons";
import { AppConfirmProvider, appConfirm } from "./components/AppConfirm";
import { AppToastProvider } from "./components/AppToast";
import { AppProvider, useApp } from "./context/AppContext";
import type { NavId } from "./types";
import * as api from "./api/tauri";
import { DownloadsView } from "./views/DownloadsView";
import { FavoritesView } from "./views/FavoritesView";
import { AboutView } from "./views/AboutView";
import { OptionsView } from "./views/OptionsView";
import { InfoView } from "./views/info/InfoView";
import "./styles/index.css";

const NAV_ITEMS: { id: NavId; label: string; icon: keyof typeof ICO; title: string }[] = [
  { id: "downloads", label: "Descargas", icon: "download", title: "Descargas" },
  { id: "info", label: "Información", icon: "info", title: "Información" },
  { id: "favorites", label: "Favoritos", icon: "heart", title: "Favoritos" },
  { id: "about", label: "Sobre", icon: "about", title: "Sobre" },
];

function LogDrawer() {
  const { logOpen, logLines } = useApp();
  const text = logLines
    .map((l) => {
      const prefix = l.kind === "ok" ? "✓ " : l.kind === "err" ? "✗ " : "";
      return prefix + l.text;
    })
    .join("\n");

  return (
    <div className={`log-drawer${logOpen ? " open" : ""}`} id="log-drawer">
      <pre id="log" className="log">
        {text}
      </pre>
    </div>
  );
}

function ExitConfirmBridge() {
  useEffect(() => {
    let cancelled = false;
    let busy = false;
    let un: (() => void) | undefined;
    void api.onAskExitConfirm(() => {
      if (busy || cancelled) return;
      busy = true;
      void (async () => {
        try {
          const ok = await appConfirm({
            title: "Confirmar salida",
            message: "¿Seguro que deseas salir de FMD3?",
            okLabel: "Salir",
            cancelLabel: "Cancelar",
          });
          if (cancelled) {
            await api.appCancelExit();
            return;
          }
          if (ok) await api.appConfirmExit();
          else await api.appCancelExit();
        } catch {
          await api.appCancelExit().catch(() => {});
        } finally {
          busy = false;
        }
      })();
    }).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);
  return null;
}

function Shell() {
  const {
    activeNav,
    setActiveNav,
    darkTheme,
    toggleTheme,
    logOpen,
    toggleLog,
    log,
    setModules,
    setOutputDir,
    narrow,
    hideInfo,
    showMangaInfo,
  } = useApp();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const saved = ((await api.settingsGet("default_output_dir")) ?? "").trim();
        if (!cancelled) {
          if (saved) setOutputDir(saved);
          else setOutputDir(await api.defaultSaveDir());
        }
        const mods = await api.modulesList();
        if (cancelled) return;
        setModules(mods);
        // Fuente/módulo: InfoView restaura ui.selected_module; no pisar aquí.
        log("DB lista (favoritos/cola en AppData/fmd-mvp).", "ok");
      } catch (e) {
        log(String(e), "err");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [log, setModules, setOutputDir]);

  const appClass = [
    "app",
    darkTheme ? "dark" : "",
    narrow ? "narrow" : "",
    hideInfo ? "hide-info" : "",
    showMangaInfo ? "show-manga-info" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={appClass}>
      <AppConfirmProvider>
      <AppToastProvider>
      <ExitConfirmBridge />
      <svg className="svg-filters" aria-hidden="true" focusable="false" width={0} height={0}>
        <filter id="cover-sharpen" colorInterpolationFilters="sRGB">
          <feConvolveMatrix
            order="3"
            kernelMatrix="0 -0.35 0 -0.35 2.4 -0.35 0 -0.35 0"
            preserveAlpha="true"
          />
        </filter>
      </svg>
      <div className="shell-body">
        <nav className="nav-rail" aria-label="Principal">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item${activeNav === item.id ? " active" : ""}`}
              data-nav={item.id}
              title={item.title}
              onClick={() => setActiveNav(item.id)}
            >
              <Icon name={item.icon} className="ico ico-lg" />
              <span>{item.label}</span>
            </button>
          ))}
          <div className="nav-spacer" />
          <button
            type="button"
            className={`nav-item icon-only${activeNav === "options" ? " active" : ""}`}
            data-nav="options"
            title="Opciones"
            onClick={() => setActiveNav("options")}
          >
            <Icon name="settings" className="ico ico-lg" />
          </button>
          <button
            type="button"
            className="nav-item icon-only"
            id="theme-toggle"
            title="Tema"
            onClick={toggleTheme}
          >
            <Icon name={darkTheme ? "sun" : "moon"} className="ico ico-lg" />
          </button>
          <button
            type="button"
            className={`nav-item icon-only${logOpen ? " is-on" : ""}`}
            id="log-toggle"
            title="Log"
            onClick={toggleLog}
          >
            <Icon name="terminal" className="ico ico-lg" />
          </button>
        </nav>

        <div className="main-region">
          <InfoView />
          <DownloadsView />
          <FavoritesView />
          <OptionsView />
          <AboutView />
          <CatalogJobBar />
          <LogDrawer />
        </div>
      </div>
      <select id="module-sel" hidden>
        <option value="">Auto</option>
      </select>
      </AppToastProvider>
      </AppConfirmProvider>
    </div>
  );
}

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
