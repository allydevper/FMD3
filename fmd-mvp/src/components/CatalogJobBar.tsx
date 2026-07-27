import { Icon } from "./Icon";
import { useApp } from "../context/AppContext";

export function CatalogJobBar() {
  const { catalogJob, cancelCatalogJob } = useApp();
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
    <div className="catalog-job-bar" id="catalog-job-bar" role="status">
      <div className="catalog-job-bar-main">
        <div className="catalog-job-bar-text" title={label}>
          {label}
        </div>
        <div className="catalog-job-bar-track" aria-hidden="true">
          <div className="catalog-job-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <button
        type="button"
        className="catalog-job-bar-cancel"
        disabled={catalogJob.cancelling}
        title="Cancelar"
        aria-label="Cancelar"
        onClick={() => void cancelCatalogJob()}
      >
        <Icon name="x" className="ico ico-sm" />
      </button>
    </div>
  );
}
