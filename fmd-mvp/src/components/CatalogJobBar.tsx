import { Icon } from "./Icon";
import { useApp } from "../context/AppContext";

export function CatalogJobBar() {
  const { catalogJob, cancelCatalogJob } = useApp();
  if (!catalogJob) return null;

  const verb = catalogJob.mode === "fetch" ? "Descargando" : "Actualizando";
  const pct =
    catalogJob.pageTotal > 0
      ? Math.min(100, Math.round((catalogJob.page / catalogJob.pageTotal) * 100))
      : catalogJob.bytesTotal > 0
        ? Math.min(100, Math.round((catalogJob.bytesDone / catalogJob.bytesTotal) * 100))
        : catalogJob.total > 0
          ? Math.min(100, Math.round(((catalogJob.index - 1) / catalogJob.total) * 100))
          : 0;

  const detail =
    catalogJob.message ||
    (catalogJob.pageTotal > 0
      ? `página ${catalogJob.page + 1}/${catalogJob.pageTotal}`
      : catalogJob.bytesTotal > 0
        ? `${(catalogJob.bytesDone / 1_048_576).toFixed(1)}/${(catalogJob.bytesTotal / 1_048_576).toFixed(1)} MB`
        : "");

  const label = `${verb} [${catalogJob.index}/${catalogJob.total}] ${catalogJob.moduleName}${
    detail ? ` · ${detail}` : ""
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
        onClick={() => void cancelCatalogJob()}
      >
        <Icon name="x" className="ico ico-sm" />
        Cancelar
      </button>
    </div>
  );
}
