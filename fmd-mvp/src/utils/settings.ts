import { appConfirm } from "../components/AppConfirm";
import { SK } from "../constants";
import * as api from "../api/tauri";

export function parseSettingBool(raw: string | null | undefined, def = false): boolean {
  if (raw == null || raw === "") return def;
  return raw === "1" || raw.toLowerCase() === "true";
}

export async function settingBool(key: string, def = false): Promise<boolean> {
  return parseSettingBool(await api.settingsGet(key), def);
}

export async function settingNumber(key: string, def: number): Promise<number> {
  const n = Number((await api.settingsGet(key)) ?? String(def));
  return Number.isFinite(n) ? n : def;
}

/** Returns false if the user cancelled. */
export async function confirmIfEnabled(
  key: string,
  message: string,
  defEnabled = true,
  title = "Confirmar",
): Promise<boolean> {
  const on = await settingBool(key, defEnabled);
  if (!on) return true;
  return appConfirm({ title, message, okLabel: "Continuar", cancelLabel: "Cancelar" });
}

export { SK };
