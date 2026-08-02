import { relaunch } from "@tauri-apps/plugin-process";
import * as api from "../api/tauri";
import { appConfirm } from "../components/AppConfirm";

/**
 * Nothing used to stand between `relaunch()` and a download in flight: both the
 * app updater and the modules updater called it outright, and the exit-confirm
 * dialog is bypassed entirely by a relaunch. Every restart now goes through
 * here.
 */

/** Returns a human reason when this subsystem is busy, else null. */
export type BusyProbe = () => string | null;

const probes = new Set<BusyProbe>();

/** Register an in-memory probe (React state the backend cannot see). */
export function registerBusyProbe(probe: BusyProbe): () => void {
  probes.add(probe);
  return () => {
    probes.delete(probe);
  };
}

/** All the reasons a restart would interrupt work, in-memory plus the queue. */
export async function busyReasons(): Promise<string[]> {
  const reasons: string[] = [];
  for (const probe of probes) {
    try {
      const r = probe();
      if (r) reasons.push(r);
    } catch {
      // A broken probe must not be able to block a restart forever.
    }
  }
  try {
    const running = (await api.queueList()).filter((i) => i.status === "running").length;
    if (running > 0) {
      reasons.push(running === 1 ? "1 descarga en curso" : `${running} descargas en curso`);
    }
  } catch {
    // Queue unreachable: fall back to whatever the in-memory probes said.
  }
  return reasons;
}

/**
 * Restart, asking first when it would interrupt something. Returns false when
 * the user declined — callers must not assume the process is gone.
 */
export async function safeRelaunch(reason: string): Promise<boolean> {
  const busy = await busyReasons();
  if (busy.length > 0) {
    const ok = await appConfirm({
      title: "Reiniciar ahora",
      message: `${reason}\n\nHay trabajo en curso que se interrumpirá:`,
      okLabel: "Reiniciar igualmente",
      cancelLabel: "Esperar",
      items: busy,
    });
    if (!ok) return false;
  }
  await relaunch();
  return true;
}
