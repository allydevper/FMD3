import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Icon } from "../components/Icon";
import { ICO } from "../icons";
import { useApp } from "../context/AppContext";
import { runAppUpdateCheck } from "../utils/appUpdate";
import { t, tPlural, useLanguage } from "../i18n";

const GITHUB_URL = "https://github.com/allydevper/FMD3";
const FMD2_URL = "https://github.com/dazedcat19/FMD2";
const GPL_URL = "https://www.gnu.org/licenses/gpl-2.0.html";

type AboutTab = "fmd" | "log";

function AboutLink({ url, children }: { url: string; children: string }) {
  return (
    <button type="button" className="lnk about-link" onClick={() => void openUrl(url)}>
      {children}
    </button>
  );
}

export function AboutView() {
  useLanguage();
  const { modules, log, activeNav, setAppUpdatePending } = useApp();
  const [tab, setTab] = useState<AboutTab>("fmd");
  const [version, setVersion] = useState("…");
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion("—"));
  }, []);

  const modulesCount = modules.length;
  const modulesLabel = tPlural("about.modules", modulesCount);
  const runtimeLabel = `Tauri 2 · Rust · ${navigator.platform || "web"}`;

  return (
    <section id="view-about" className="view" hidden={activeNav !== "about"}>
      <div className="about-shell">
        <header className="about-header">
          <div>
            <div className="about-eyebrow">{t("about.eyebrow")}</div>
            <h1 className="about-title">{t("about.title")}</h1>
          </div>
          <div className="about-header-actions">
            <div className="about-meta-block">
              <div className="about-meta-row">
                <span className="about-meta-k">{t("about.version")}</span>
                <span className="mono">{version}</span>
              </div>
              <div className="about-meta-row">
                <span className="about-meta-k">{t("about.license")}</span>
                <span className="mono">GPLv2</span>
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
                    const r = await runAppUpdateCheck(log, { notifyResult: true });
                    if (r.deferred) setAppUpdatePending(r.version ?? null);
                    else setAppUpdatePending(null);
                  } catch {
                    // already logged
                  } finally {
                    setChecking(false);
                  }
                })();
              }}
            >
              <Icon ico={ICO.refresh} className="ico ico-sm" />
              {checking ? t("about.checking") : t("about.checkVersion")}
            </button>
            <button type="button" className="about-btn-ghost" onClick={() => void openUrl(GITHUB_URL)}>
              <Icon ico={ICO.globe} className="ico ico-sm" />
              {t("about.project")}
            </button>
          </div>
        </header>

        <div className="about-tabs" role="tablist" aria-label={t("about.tabsAria")}>
          <button
            type="button"
            className={`about-tab${tab === "fmd" ? " on" : ""}`}
            role="tab"
            aria-selected={tab === "fmd"}
            onClick={() => setTab("fmd")}
          >
            {t("about.tabFmd")}
          </button>
          <button
            type="button"
            className={`about-tab${tab === "log" ? " on" : ""}`}
            role="tab"
            aria-selected={tab === "log"}
            onClick={() => setTab("log")}
          >
            {t("about.tabLog")}
          </button>
        </div>

        <div className="about-body">
          <div className="about-pane" hidden={tab !== "fmd"}>
            <div className="about-scroll">
              <div className="about-card">
                <div className="about-kv">
                  <span className="about-kv-k">{t("about.kvProject")}</span>
                  <span className="about-kv-v">FMD3</span>
                </div>
                <div className="about-kv">
                  <span className="about-kv-k">{t("about.kvBased")}</span>
                  <span className="about-kv-v">{t("about.basedOn")}</span>
                </div>
                <div className="about-kv">
                  <span className="about-kv-k">{t("about.kvPage")}</span>
                  <AboutLink url={GITHUB_URL}>{GITHUB_URL}</AboutLink>
                </div>
                <div className="about-kv">
                  <span className="about-kv-k">{t("about.kvLua")}</span>
                  <AboutLink url={FMD2_URL}>{FMD2_URL}</AboutLink>
                </div>
                <div className="about-kv">
                  <span className="about-kv-k">Licencia</span>
                  <AboutLink url={GPL_URL}>GPLv2</AboutLink>
                </div>
              </div>

              <p className="about-lead">{t("about.lead")}</p>

              <h2 className="about-h">{t("about.devFmd3")}</h2>
              <ul className="about-list">
                <li>allydevper</li>
              </ul>

              <h2 className="about-h">{t("about.devFmd2")}</h2>
              <ul className="about-list">
                <li>NhKPaNdA</li>
                <li>dazedcat19</li>
              </ul>

              <h2 className="about-h">{t("about.devPrev")}</h2>
              <ul className="about-list about-list-inline">
                <li>Akarin-K</li>
                <li>Anastasiadinara</li>
                <li>SDXC</li>
                <li>kavin-90</li>
                <li>kmvi</li>
                <li>riderkick</li>
              </ul>

              <h2 className="about-h">{t("about.stack")}</h2>
              <ul className="about-list">
                <li>Rust + Tauri 2 + React</li>
                <li>Lua 5.4 (mlua) — módulos y plantillas FMD2</li>
                <li>SQLite — cola, favoritos y catálogo</li>
                <li>reqwest — HTTP / cookies / compresión</li>
                <li>Duktape — challenges websitebypass (paridad FMD2)</li>
              </ul>

              <h2 className="about-h">{t("about.luaMods")}</h2>
              <ul className="about-list about-list-compact">
                <li>{t("about.lua1")}</li>
                <li>{t("about.lua2")}</li>
                <li>{t("about.lua3")}</li>
              </ul>
            </div>
          </div>

          <div className="about-pane" hidden={tab !== "log"}>
            <pre className="about-changelog">{t("about.changelog")}</pre>
          </div>
        </div>

        <footer className="about-footer">
          <span className="about-footer-stat">
            <span className="fav-dot" style={{ background: "var(--accent)" }}></span>
            <span>FMD3</span>
          </span>
          <span className="about-footer-muted mono">{runtimeLabel}</span>
          <span className="about-footer-muted mono">{modulesLabel}</span>
          <div className="about-footer-spacer"></div>
          <span className="about-footer-muted">{t("about.compatible")}</span>
        </footer>
      </div>
    </section>
  );
}
