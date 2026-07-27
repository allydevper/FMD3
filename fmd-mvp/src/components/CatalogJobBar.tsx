import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useApp } from "../context/AppContext";

export function CatalogJobBar() {
  const { catalogJob, cancelCatalogJob } = useApp();
  const [minimized, setMinimized] = useState(false);
  const hadJobRef = useRef(false);

  useEffect(() => {
    const has = !!catalogJob;
    if (has && !hadJobRef.current) setMinimized(false);
    hadJobRef.current = has;
  }, [catalogJob]);

  if (!catalogJob) return null;

  const isFetch = catalogJob.mode === "fetch";
  const pct =
    catalogJob.pageTotal > 0
      ? Math.min(100, Math.round(((catalogJob.page + 1) / catalogJob.pageTotal) * 100))
      : catalogJob.getinfoTotal && catalogJob.getinfoTotal > 0
        ? Math.min(
            100,
            Math.round(((catalogJob.getinfoIndex ?? 0) / catalogJob.getinfoTotal) * 100),
          )
        : catalogJob.bytesTotal > 0
          ? Math.min(100, Math.round((catalogJob.bytesDone / catalogJob.bytesTotal) * 100))
          : catalogJob.total > 0
            ? Math.min(100, Math.round(((catalogJob.index - 1) / catalogJob.total) * 100))
            : 0;

  // FMD2-style: "Actualizando lista [1/1] MangaOni | [T:1] [195/421] | …"
  const body =
    catalogJob.message?.trim() ||
    (isFetch && catalogJob.bytesTotal > 0
      ? `${(catalogJob.bytesDone / 1_048_576).toFixed(1)}/${(catalogJob.bytesTotal / 1_048_576).toFixed(1)} MB`
      : "");

  const label = isFetch
    ? `Descargando lista [${catalogJob.index}/${catalogJob.total}] ${catalogJob.moduleName}${
        body ? ` | ${body}` : ""
      }${catalogJob.cancelling ? " · cancelando…" : ""}`
    : `Actualizando lista [${catalogJob.index}/${catalogJob.total}] ${catalogJob.moduleName}${
        body ? ` | ${body}` : ""
      }${catalogJob.cancelling ? " · cancelando…" : ""}`;

  return (
    <div
      className={`catalog-job-bar${minimized ? " is-minimized" : ""}`}
      id="catalog-job-bar"
      role="status"
    >
      {!minimized ? (
        <div className="catalog-job-bar-main">
          <div className="catalog-job-bar-text" title={label}>
            {label}
          </div>
          <div className="catalog-job-bar-track" aria-hidden="true">
            <div className="catalog-job-bar-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="catalog-job-bar-notch"
          title={`Mostrar barra · ${pct}%`}
          aria-label="Mostrar barra de progreso"
          aria-expanded={false}
          onClick={() => setMinimized(false)}
        >
          <span className="catalog-job-bar-notch-fill" style={{ width: `${pct}%` }} />
          <Icon name="arrowUp" className="ico ico-sm" />
          <span className="catalog-job-bar-notch-pct">{pct}%</span>
        </button>
      )}
      <div className="catalog-job-bar-actions">
        {!minimized ? (
          <button
            type="button"
            className="catalog-job-bar-btn"
            title="Minimizar"
            aria-label="Minimizar barra"
            aria-expanded={true}
            onClick={() => setMinimized(true)}
          >
            <Icon name="arrowDown" className="ico ico-sm" />
          </button>
        ) : null}
        <button
          type="button"
          className="catalog-job-bar-btn catalog-job-bar-cancel"
          disabled={catalogJob.cancelling}
          title="Cancelar"
          aria-label="Cancelar"
          onClick={() => void cancelCatalogJob()}
        >
          <Icon name="x" className="ico ico-sm" />
        </button>
      </div>
    </div>
  );
}
