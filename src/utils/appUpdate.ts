import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { appConfirm } from "../components/AppConfirm";
import { safeRelaunch } from "./restartGuard";

export type AppUpdateLog = (msg: string, kind?: "ok" | "err" | "") => void;

export type AppUpdateCheckOptions = {
  /** Show a modal for “up to date” / errors (manual check). Startup stays log-only. */
  notifyResult?: boolean;
};

/**
 * Structured outcome so the caller can react. `installing` matters most: the
 * process is about to be replaced, so no other startup work should begin.
 */
export type AppUpdateResult = {
  message: string;
  current: string;
  /** A newer version exists on the endpoint. */
  available: boolean;
  version?: string;
  /** Available but the user chose «Más tarde». */
  deferred: boolean;
  /** Installed successfully; a relaunch has been requested. */
  installing: boolean;
};

function friendlyCheckError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (
    lower.includes("404") ||
    lower.includes("not found") ||
    lower.includes("failed to fetch") ||
    lower.includes("error sending request") ||
    lower.includes("no release") ||
    lower.includes("could not fetch")
  ) {
    return "No hay actualización disponible.";
  }
  return raw;
}

async function notify(title: string, message: string): Promise<void> {
  await appConfirm({ title, message, alert: true, okLabel: "Entendido" });
}

/**
 * Check allydevper/FMD3 updater endpoint. If newer, confirm → download/install → relaunch.
 * Returns a short status message for the log.
 */
export async function runAppUpdateCheck(
  log?: AppUpdateLog,
  opts?: AppUpdateCheckOptions,
): Promise<AppUpdateResult> {
  const notifyResult = opts?.notifyResult === true;
  const current = await getVersion();
  const idle = (message: string, extra?: Partial<AppUpdateResult>): AppUpdateResult => ({
    message,
    current,
    available: false,
    deferred: false,
    installing: false,
    ...extra,
  });
  let update;
  try {
    update = await check();
  } catch (e) {
    const msg = friendlyCheckError(e);
    log?.(`Comprobar actualización: ${msg}`, "err");
    if (notifyResult) {
      await notify("Actualizaciones", msg);
    }
    throw new Error(msg);
  }

  if (!update) {
    const msg = `Al día (v${current})`;
    log?.(msg, "ok");
    if (notifyResult) {
      await notify("Actualizaciones", `Ya tienes la última versión (v${current}).`);
    }
    return idle(msg);
  }

  const notes = (update.body || "").trim();
  const noteBlock = notes ? `\n\n${notes.slice(0, 800)}${notes.length > 800 ? "…" : ""}` : "";
  const ok = await appConfirm({
    title: "Actualización disponible",
    message: `Hay una versión nueva.\n\nActual: v${current}\nNueva: v${update.version}${noteBlock}\n\n¿Descargar e instalar ahora? La app se reiniciará.`,
    okLabel: "Actualizar",
    cancelLabel: "Más tarde",
  });

  if (!ok) {
    const msg = `Actualización v${update.version} pospuesta`;
    log?.(msg, "");
    // Postponing used to leave no trace at all, so the app forgot until the
    // next launch. The caller surfaces this the same way as pending modules.
    return idle(msg, { available: true, version: update.version, deferred: true });
  }

  log?.(`Descargando v${update.version}…`, "");
  let downloaded = 0;
  let contentLength = 0;
  try {
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          contentLength = event.data.contentLength ?? 0;
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          if (contentLength > 0 && downloaded % (512 * 1024) < event.data.chunkLength) {
            const pct = Math.min(100, Math.round((downloaded / contentLength) * 100));
            log?.(`Descarga ${pct}%`, "");
          }
          break;
        case "Finished":
          log?.("Descarga terminada; instalando…", "");
          break;
      }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log?.(`Error al instalar actualización: ${msg}`, "err");
    if (notifyResult) {
      await notify("Error al actualizar", msg);
    }
    throw new Error(msg);
  }

  log?.("Reiniciando…", "ok");
  const relaunched = await safeRelaunch(`Se instaló la versión v${update.version}.`);
  if (!relaunched) {
    log?.("Reinicio pospuesto; la nueva versión se usará al cerrar la app.", "");
  }
  return idle(`Actualizado a v${update.version}`, {
    available: true,
    version: update.version,
    installing: true,
  });
}
