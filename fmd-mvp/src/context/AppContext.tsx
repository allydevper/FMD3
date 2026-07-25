import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { THEME_KEY } from "../constants";
import type { ModuleMeta, NavId } from "../types";
import * as api from "../api/tauri";

export type LogKind = "ok" | "err" | "";

type AppContextValue = {
  activeNav: NavId;
  setActiveNav: (nav: NavId) => void;
  darkTheme: boolean;
  toggleTheme: () => void;
  logOpen: boolean;
  setLogOpen: (open: boolean) => void;
  toggleLog: () => void;
  logLines: { text: string; kind: LogKind }[];
  log: (msg: string, kind?: LogKind) => void;
  clearLog: () => void;
  modules: ModuleMeta[];
  setModules: (mods: ModuleMeta[]) => void;
  selectedModuleId: string | null;
  setSelectedModuleId: (id: string | null) => void;
  currentModule: ModuleMeta | undefined;
  outputDir: string;
  setOutputDir: (dir: string) => void;
  /** Layout: search panel compact (< 860px). */
  narrow: boolean;
  /** Layout: hide right info sidebar (< 1040px). */
  hideInfo: boolean;
  /** Layout: show right info sidebar when manga/stub is open. */
  showMangaInfo: boolean;
  setShowMangaInfo: (open: boolean) => void;
  refreshModules: () => Promise<ModuleMeta[]>;
};

const AppContext = createContext<AppContextValue | null>(null);

function layoutFromWidth(w: number) {
  return {
    narrow: w < 860,
    hideInfo: w < 1040,
  };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [activeNav, setActiveNav] = useState<NavId>("info");
  const [darkTheme, setDarkTheme] = useState(
    () => localStorage.getItem(THEME_KEY) === "1",
  );
  const [logOpen, setLogOpen] = useState(false);
  const [logLines, setLogLines] = useState<{ text: string; kind: LogKind }[]>([
    { text: "Listo.", kind: "" },
  ]);
  const [modules, setModules] = useState<ModuleMeta[]>([]);
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  const [outputDir, setOutputDir] = useState("");
  const [showMangaInfo, setShowMangaInfo] = useState(false);
  const [{ narrow, hideInfo }, setLayout] = useState(() =>
    layoutFromWidth(typeof window !== "undefined" ? window.innerWidth : 1280),
  );

  useEffect(() => {
    const onResize = () => setLayout(layoutFromWidth(window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    let un: (() => void) | undefined;
    void api
      .onLuaLog((msg) => {
        setLogLines((prev) => [...prev.slice(-400), { text: msg, kind: "" }]);
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, []);

  const log = useCallback((msg: string, kind: LogKind = "") => {
    setLogLines((prev) => [...prev.slice(-400), { text: msg, kind }]);
  }, []);

  const clearLog = useCallback(() => {
    setLogLines([{ text: "Listo.", kind: "" }]);
  }, []);

  const toggleTheme = useCallback(() => {
    setDarkTheme((d) => {
      const next = !d;
      localStorage.setItem(THEME_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  const toggleLog = useCallback(() => setLogOpen((o) => !o), []);

  const currentModule = useMemo(
    () => modules.find((m) => m.id === selectedModuleId),
    [modules, selectedModuleId],
  );

  const refreshModules = useCallback(async () => {
    const mods = await api.modulesList();
    setModules(mods);
    if (mods.length && !mods.some((m) => m.id === selectedModuleId)) {
      setSelectedModuleId(mods[0]?.id ?? null);
    }
    return mods;
  }, [selectedModuleId]);

  const value: AppContextValue = {
    activeNav,
    setActiveNav,
    darkTheme,
    toggleTheme,
    logOpen,
    setLogOpen,
    toggleLog,
    logLines,
    log,
    clearLog,
    modules,
    setModules,
    selectedModuleId,
    setSelectedModuleId,
    currentModule,
    outputDir,
    setOutputDir,
    narrow,
    hideInfo,
    showMangaInfo,
    setShowMangaInfo,
    refreshModules,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
