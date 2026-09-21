import * as api from "../api/tauri";
import { appConfirm } from "../components/AppConfirm";
import { SK } from "../constants";
import type { ModulesCheckReport, ModulesUpdateReport } from "../types";
import { t } from "../i18n";

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
  if (c.new_count) parts.push(t("modules.new", { n: c.new_count }));
  if (c.update_count) parts.push(t("modules.updated", { n: c.update_count }));
  if (c.delete_count) parts.push(t("modules.deleted", { n: c.delete_count }));
  if (c.failed_count) parts.push(t("modules.failed", { n: c.failed_count }));
  return parts.length ? parts.join(", ") : t("modules.noPending");
}

function formatCheckBreakdown(c: ModulesCheckReport): string {
  const parts: string[] = [];
  if (c.update_count) parts.push(t("modules.updated", { n: c.update_count }));
  if (c.new_count) parts.push(t("modules.new", { n: c.new_count }));
  if (c.delete_count) parts.push(t("modules.deleted", { n: c.delete_count }));
  if (c.failed_count) parts.push(t("modules.failed", { n: c.failed_count }));
  return parts.length ? parts.join(" · ") : t("modules.noPending");
}

function summarizeApply(r: ModulesUpdateReport): string {
  const parts: string[] = [];
  if (r.downloaded) parts.push(t("modules.downloaded", { n: r.downloaded }));
  if (r.deleted) parts.push(t("modules.deleted", { n: r.deleted }));
  if (r.failed) parts.push(t("modules.failed", { n: r.failed }));
  return parts.length ? parts.join(", ") : t("modules.noChanges");
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
    if (!silent) log(t("modules.none"), "ok");
    return { check, report: null, deferred: false };
  }

  if (silent) {
    log(t("modules.pending", { summary: summarizeCheck(check) }), "");
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
      title: t("modules.title"),
      message: t("modules.warn"),
      okLabel: t("updates.update"),
      cancelLabel: t("common.cancel"),
      items: files,
      meta: t("modules.files", { n: fileCount || files.length }),
      listTitle: t("modules.filesTitle"),
      listMeta: formatCheckBreakdown(check),
      footerHint: t("modules.backupHint"),
    });
    if (!ok) {
      await api.modulesUpdateDismiss(check.token);
      log(t("modules.cancelled"), "");
      return { check, report: null, deferred: false };
    }
  }

  await api.modulesUpdateBegin();
  const report = await api.modulesUpdateApply(check.token);

  if (report.cancelled) {
    log(t("modules.cancelledApply", { summary: summarizeApply(report) }), "");
    return { check, report, deferred: false };
  }
  for (const line of report.status_lines.slice(0, 20)) log(t("modules.line", { msg: line }), "err");
  if (!report.applied) {
    log(t("modules.noneApplied"), "err");
    return { check, report, deferred: false };
  }

  // No restart: the registry is refreshed at the end of `apply`, and every
  // module call builds a fresh Lua VM that reads the file off disk, so new code
  // is live immediately. FMD2 needed a relaunch here; this port does not.
  log(
    t("modules.applied", { summary: summarizeApply(report), n: report.refreshed_count }),
    "ok",
  );
  return { check, report, deferred: false };
}
