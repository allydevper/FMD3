import { relaunch } from "@tauri-apps/plugin-process";
import * as api from "../api/tauri";
import { appConfirm } from "../components/AppConfirm";
import { SK } from "../constants";
import type { ModulesUpdateReport } from "../types";

export type ModulesUpdateLog = (msg: string, kind?: "ok" | "err" | "") => void;

function parseBool(raw: string | null | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function summarize(report: ModulesUpdateReport): string {
  const parts: string[] = [];
  if (report.new_count) parts.push(`${report.new_count} nuevos`);
  if (report.update_count) parts.push(`${report.update_count} actualizados`);
  if (report.delete_count) parts.push(`${report.delete_count} eliminados`);
  if (report.failed_count) parts.push(`${report.failed_count} fallidos`);
  return parts.length ? parts.join(", ") : "sin cambios pendientes";
}

async function maybeRestart(log: ModulesUpdateLog): Promise<void> {
  const auto = parseBool(await api.settingsGet(SK.MODULES_UPDATER_AUTO_RESTART), false);
  if (auto) {
    log("Módulos actualizados — reiniciando…", "ok");
    await relaunch();
    return;
  }
  const ok = await appConfirm({
    title: "Módulos actualizados",
    message: "Se actualizaron módulos Lua. ¿Reiniciar ahora?",
    okLabel: "Reiniciar",
    cancelLabel: "Más tarde",
  });
  if (ok) {
    await relaunch();
  }
}

/**
 * FMD2 modules updater flow: check GitHub → optional confirm → download → refresh.
 * Returns the final report (or null if cancelled / no network apply).
 */
export async function runModulesGithubUpdate(
  log: ModulesUpdateLog,
  opts?: { silent?: boolean },
): Promise<ModulesUpdateReport | null> {
  const silent = opts?.silent ?? false;
  let report = await api.updateModulesFromGithub(null);

  if (report.awaiting_confirm) {
    const ok = await appConfirm({
      title: "Actualización de módulos",
      message:
        "Hay cambios en los módulos de GitHub. Los cambios locales en esos archivos se perderán. ¿Continuar?",
      okLabel: "Actualizar",
      cancelLabel: "Cancelar",
      items: report.status_lines.length > 0 ? report.status_lines : [summarize(report)],
    });
    if (!ok) {
      await api.updateModulesFromGithub(false);
      if (!silent) log("Actualización de módulos cancelada", "");
      return null;
    }
    report = await api.updateModulesFromGithub(true);
  }

  if (!report.found_updates) {
    if (!silent) log("Módulos: sin actualizaciones en GitHub", "ok");
    return report;
  }

  if (!report.applied) {
    return report;
  }

  log(`Módulos actualizados: ${summarize(report)} (${report.refreshed_count} cargados)`, "ok");
  await maybeRestart(log);
  return report;
}
