import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useApp } from "../context/AppContext";
import type { CatalogJobState } from "../types";

function phaseHeadline(job: CatalogJobState): string {
  if (job.mode === "favorites") {
    if (job.cancelling) return "Cancelando revisión de favoritos";
    if (job.phase === "done") return "Revisión de favoritos lista";
    return `Revisando favoritos [${job.index}/${job.total}] ${job.moduleName}`;
  }
  const site = `[${job.index}/${job.total}] ${job.moduleName}`;
  if (job.cancelling) return `Cancelando · ${job.moduleName}`;
  if (job.mode === "fetch") return `Descargando lista ${site}`;
  switch (job.phase) {
    case "scrape":
      return `Explorando el catálogo del sitio ${site}`;
    case "getinfo":
      return `Importando metadatos de obras nuevas ${site}`;
    case "done":
      return `Lista actualizada · ${job.moduleName}`;
    default:
      return `Actualizando lista ${site}`;
  }
}

function phaseShort(job: CatalogJobState): string {
  if (job.mode === "favorites") {
    if (job.cancelling) return "Cancelando favoritos";
    if (job.phase === "done") return "Favoritos · listo";
    return `Favoritos · ${job.index}/${job.total}`;
  }
  if (job.cancelling) return `Cancelando · ${job.moduleName}`;
  if (job.mode === "fetch") return `Descarga · ${job.moduleName}`;
  switch (job.phase) {
    case "scrape": {
      if (job.pageTotal > 0) {
        return `Catálogo · pág. ${job.page + 1}/${job.pageTotal}`;
      }
      return `Explorando catálogo · ${job.moduleName}`;
    }
    case "getinfo": {
      if (job.getinfoTotal && job.getinfoTotal > 0) {
        return `Metadatos · ${job.getinfoIndex ?? 0}/${job.getinfoTotal}`;
      }
      return `Importando metadatos · ${job.moduleName}`;
    }
    case "done":
      return `Listo · ${job.moduleName}`;
    default:
      return `Actualizando · ${job.moduleName}`;
  }
}

/** Keep counters; drop verbs already shown in the title. */
function phaseMeta(message: string, phase?: string): string {
  const raw = message.trim();
  if (!raw) return "";

  const m = raw.match(/^(\[T:\d+\]\s*\[[^\]]+\])\s*(?:\|\s*)?(.*)$/s);
  const counters = m?.[1]?.trim() ?? "";
  let rest = (m?.[2] ?? raw).trim();

  rest = rest
    .replace(/^Obteniendo info\s*·\s*/i, "")
    .replace(/^Buscando títulos nuevos\s*·\s*/i, "")
    .replace(/^Obteniendo directorio\s*·\s*/i, "")
    .replace(/^Preparando\s*·\s*/i, "")
    .replace(/^Insertando\s+/i, "Insertando ")
    .replace(/^listo\s*·\s*/i, "")
    .replace(/^\·\s*/, "");

  if (phase === "scrape" && rest) {
    // e.g. "dir 1/1 · +18 (acum 36)" or "76 páginas"
    return counters ? `${counters} · ${rest}` : rest;
  }
  if (phase === "getinfo" && rest) {
    return counters ? `${counters} · ${rest}` : rest;
  }
  if (counters && rest) return `${counters} · ${rest}`;
  return counters || rest;
}

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
  const isFavorites = catalogJob.mode === "favorites";
  const pct = isFavorites
    ? catalogJob.total > 0
      ? Math.min(100, Math.round((catalogJob.index / catalogJob.total) * 100))
      : 0
    : catalogJob.pageTotal > 0 &&
        (catalogJob.phase === "scrape" || !catalogJob.getinfoTotal)
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

  const body =
    catalogJob.message?.trim() ||
    (isFetch && catalogJob.bytesTotal > 0
      ? `${(catalogJob.bytesDone / 1_048_576).toFixed(1)}/${(catalogJob.bytesTotal / 1_048_576).toFixed(1)} MB`
      : "");

  const title = phaseHeadline(catalogJob);
  const meta = isFavorites
    ? body
    : isFetch
      ? body
      : phaseMeta(body, catalogJob.phase);
  const short = phaseShort(catalogJob);
  const pctLabel = `${pct}%`;
  const spinning = !catalogJob.cancelling && catalogJob.phase !== "done";

  return (
    <div
      className={`catalog-job-bar${minimized ? " is-minimized" : ""}`}
      id="catalog-job-bar"
      role="status"
      aria-label={title}
    >
      <div
        className="catalog-job-bar-wash"
        aria-hidden="true"
        style={{ width: pctLabel }}
      />

      {!minimized ? (
        <div className="catalog-job-bar-row">
          <Icon
            name="refresh"
            className={`ico ico-sm catalog-job-bar-spin${spinning ? " is-spinning" : ""}`}
          />
          <div className="catalog-job-bar-copy">
            <span className="catalog-job-bar-title" title={title}>
              {title}
            </span>
            {meta ? (
              <span className="catalog-job-bar-meta" title={meta}>
                {meta}
              </span>
            ) : null}
          </div>
          <span className="catalog-job-bar-pct">{pctLabel}</span>
          <button
            type="button"
            className="catalog-job-bar-icon-btn"
            title="Contraer"
            aria-label="Contraer barra"
            aria-expanded={true}
            onClick={() => setMinimized(true)}
          >
            <Icon name="chevron" className="ico ico-sm" />
          </button>
          <button
            type="button"
            className="catalog-job-bar-icon-btn catalog-job-bar-cancel"
            disabled={catalogJob.cancelling}
            title="Cancelar"
            aria-label="Cancelar"
            onClick={() => void cancelCatalogJob()}
          >
            <Icon name="x" className="ico ico-sm" />
          </button>
        </div>
      ) : (
        <div
          className="catalog-job-bar-row is-compact"
          role="button"
          tabIndex={0}
          title={title}
          aria-label="Expandir barra de progreso"
          aria-expanded={false}
          onClick={() => setMinimized(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setMinimized(false);
            }
          }}
        >
          <Icon
            name="refresh"
            className={`ico ico-sm catalog-job-bar-spin${spinning ? " is-spinning" : ""}`}
          />
          <span className="catalog-job-bar-short" title={short}>
            {short}
          </span>
          <span className="catalog-job-bar-pct">{pctLabel}</span>
          <button
            type="button"
            className="catalog-job-bar-icon-btn"
            title="Expandir"
            aria-label="Expandir barra"
            onClick={(e) => {
              e.stopPropagation();
              setMinimized(false);
            }}
          >
            <Icon name="chevron" className="ico ico-sm catalog-job-bar-chevron-up" />
          </button>
          <button
            type="button"
            className="catalog-job-bar-icon-btn catalog-job-bar-cancel"
            disabled={catalogJob.cancelling}
            title="Cancelar"
            aria-label="Cancelar"
            onClick={(e) => {
              e.stopPropagation();
              void cancelCatalogJob();
            }}
          >
            <Icon name="x" className="ico ico-sm" />
          </button>
        </div>
      )}

      <div className="catalog-job-bar-track" aria-hidden="true">
        <div className="catalog-job-bar-fill" style={{ width: pctLabel }} />
      </div>
    </div>
  );
}
