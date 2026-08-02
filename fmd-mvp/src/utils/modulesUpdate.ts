import * as api from "../api/tauri";
import { appConfirm } from "../components/AppConfirm";
import { SK } from "../constants";
import { safeRelaunch } from "./restartGuard";
import type { ModulesCheckReport, ModulesUpdateReport } from "../types";

export type ModulesUpdateLog = (msg: string, kind?: "ok" | "err" | "") => void;

export type ModulesUpdateResult = {
  check: ModulesCheckReport;
  report: ModulesUpdateReport | null;
  /** Changes were found but the automatic pass left them for the user. */
  deferred: boolean;
};

function parseBool(raw: string | null | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function summarizeCheck(c: ModulesCheckReport): string {
  const parts: string[] = [];
  if (c.new_count) parts.push(`${c.new_count} nuevos`);
  if (c.update_count) parts.push(`${c.update_count} actualizados`);
  if (c.delete_count) parts.push(`${c.delete_count} eliminados`);
  if (c.failed_count) parts.push(`${c.failed_count} con error`);
  return parts.length ? parts.join(", ") : "sin cambios pendientes";
}

function formatCheckBreakdown(c: ModulesCheckReport): string {
  const parts: string[] = [];
  if (c.update_count) parts.push(`${c.update_count} actualizados`);
  if (c.new_count) parts.push(`${c.new_count} nuevos`);
  if (c.delete_count) parts.push(`${c.delete_count} eliminados`);
  if (c.failed_count) parts.push(`${c.failed_count} con error`);
  return parts.length ? parts.join(" · ") : "sin cambios pendientes";
}

function summarizeApply(r: ModulesUpdateReport): string {
  const parts: string[] = [];
  if (r.downloaded) parts.push(`${r.downloaded} descargados`);
  if (r.deleted) parts.push(`${r.deleted} eliminados`);
  if (r.failed) parts.push(`${r.failed} con error`);
  return parts.length ? parts.join(", ") : "sin cambios";
}

async function maybeRestart(log: ModulesUpdateLog): Promise<void> {
  const auto = parseBool(await api.settingsGet(SK.MODULES_UPDATER_AUTO_RESTART), false);
  if (auto) {
    log("Módulos actualizados — reiniciando…", "ok");
    // Even auto-restart asks when it would kill a download in flight.
    await safeRelaunch("Se actualizaron los módulos Lua.");
    return;
  }
  const ok = await appConfirm({
    title: "Módulos actualizados",
    message: "Se actualizaron módulos Lua. ¿Reiniciar ahora?",
    okLabel: "Reiniciar",
    cancelLabel: "Más tarde",
  });
  if (ok) await safeRelaunch("Se actualizaron los módulos Lua.");
}

/**
 * Check → optional confirm → apply → refresh.
 *
 * In `silent` mode (startup and the favorites timer) nothing is ever prompted
 * and the app is never relaunched: the result is logged and surfaced as a badge
 * so the user decides when to interrupt what they are doing.
 */
export async function runModulesGithubUpdate(
  log: ModulesUpdateLog,
  opts?: { silent?: boolean },
): Promise<ModulesUpdateResult> {
  const silent = opts?.silent ?? false;
  // A manual check reports the truth: dismissals and backoff do not apply.
  const check = await api.modulesUpdateCheck(!silent);

  if (!check.found_updates) {
    if (!silent) log("Módulos: sin actualizaciones", "ok");
    return { check, report: null, deferred: false };
  }

  if (silent) {
    log(`Módulos: hay actualizaciones (${summarizeCheck(check)})`, "");
    return { check, report: null, deferred: true };
  }

  // The warning is about losing local edits, so it only earns a modal when
  // something is actually being overwritten or removed. A first sync — or any
  // pure addition — has nothing to lose and should not interrogate the user.
  const overwrites = check.update_count + check.delete_count;
  const warn =
    overwrites > 0 && parseBool(await api.settingsGet(SK.MODULES_UPDATER_SHOW_WARNING), true);
  if (warn) {
    const files = check.status_lines.length
      ? check.status_lines
      : [summarizeCheck(check)];
    const fileCount = check.new_count + check.update_count + check.delete_count;
    const ok = await appConfirm({
      title: "Actualización de módulos",
      message:
        "La versión actual de cada archivo se guarda en la copia de seguridad antes de sobrescribirse, así que puedes deshacer.",
      okLabel: "Actualizar",
      cancelLabel: "Cancelar",
      items: files,
      meta: `${fileCount || files.length} archivos`,
      listTitle: "Archivos afectados",
      listMeta: formatCheckBreakdown(check),
      footerHint: "Copia de seguridad automática",
    });
    if (!ok) {
      // Frees the parked plan; the same changes are reported again next time.
      await api.modulesUpdateDismiss(check.token);
      log("Actualización de módulos cancelada", "");
      return { check, report: null, deferred: false };
    }
  }

  await api.modulesUpdateBegin();
  const report = await api.modulesUpdateApply(check.token);

  if (report.cancelled) {
    log(`Actualización de módulos cancelada (${summarizeApply(report)})`, "");
    return { check, report, deferred: false };
  }
  for (const line of report.status_lines.slice(0, 20)) log(`Módulos: ${line}`, "err");
  if (!report.applied) {
    log("Módulos: no se aplicó ningún cambio", "err");
    return { check, report, deferred: false };
  }

  log(
    `Módulos actualizados: ${summarizeApply(report)} (${report.refreshed_count} cargados)`,
    "ok",
  );
  await maybeRestart(log);
  return { check, report, deferred: false };
}
