import type { AdvFilterState, GenreTri } from "./types";

/** Same as FMD2 `UserAgentDefault` (httpsendthread.pas). */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

/** Canonical EN keys (FMD2 defaultGenres) + ES labels for UI. */
export const DEFAULT_GENRES: { id: string; label: string }[] = [
  { id: "Action", label: "Acción" },
  { id: "Adult", label: "Adulto" },
  { id: "Adventure", label: "Aventura" },
  { id: "Comedy", label: "Comedia" },
  { id: "Doujinshi", label: "Doujinshi" },
  { id: "Drama", label: "Drama" },
  { id: "Ecchi", label: "Ecchi" },
  { id: "Fantasy", label: "Fantasía" },
  { id: "Gender Bender", label: "Cambio de sexo" },
  { id: "Harem", label: "Harem" },
  { id: "Hentai", label: "Hentai" },
  { id: "Historical", label: "Historico" },
  { id: "Horror", label: "Horror" },
  { id: "Josei", label: "Josei" },
  { id: "Lolicon", label: "Lolicon" },
  { id: "Martial Arts", label: "Artes Marciales" },
  { id: "Mature", label: "Maduro" },
  { id: "Mecha", label: "Mecha" },
  { id: "Musical", label: "Musical" },
  { id: "Mystery", label: "Misterio" },
  { id: "Psychological", label: "Psicológico" },
  { id: "Romance", label: "Romance" },
  { id: "School Life", label: "Vida Escolar" },
  { id: "Sci-fi", label: "Sci-Fi (Ciencia Ficción)" },
  { id: "Seinen", label: "Seinen" },
  { id: "Shotacon", label: "Shotacon" },
  { id: "Shoujo", label: "Shoujo" },
  { id: "Shoujo Ai", label: "Shoujo Ai" },
  { id: "Shounen", label: "Shounen" },
  { id: "Shounen Ai", label: "Shounen Ai" },
  { id: "Slice of Life", label: "Recuentos de la Vida" },
  { id: "Smut", label: "Smut (Atrevido)" },
  { id: "Sports", label: "Deportes" },
  { id: "Supernatural", label: "Sobrenatural" },
  { id: "Tragedy", label: "Tragedia" },
  { id: "Yaoi", label: "Yaoi" },
  { id: "Yuri", label: "Yuri" },
  { id: "Webtoons", label: "Webtoons" },
];

export const FILTER_CUSTOM_HINT =
  "Géneros:\n" +
  "- Incluir: el manga debe tener este género.\n" +
  "- Excluir (X): el manga no debe tenerlo.\n" +
  "- Vacío: no importa.\n\n" +
  "Géneros extra:\n" +
  "- Separa varios con coma.\n" +
  "- Antepone ! o - para excluir.\n" +
  "- Ejemplo: Aventura, !Ecchi, Comedia.";

export function emptyAdvFilter(): AdvFilterState {
  const genres: Record<string, GenreTri> = {};
  for (const g of DEFAULT_GENRES) genres[g.id] = "ignore";
  return {
    genres,
    customGenres: "",
    title: "",
    authors: "",
    artists: "",
    summary: "",
    status: 4,
    matchMode: "all",
    onlyNew: false,
    allSites: false,
    useRegex: false,
  };
}

export const CATALOG_BATCH = 500;
export const LOLI_VAULT_ID = "218b722b1eb34f2aa3863f84538c5b08";
export const THEME_KEY = "fmd-theme-dark";
export const CH_ROW_H = 52;
export const CH_ROW_GAP = 8;
export const CH_ROW_STRIDE = CH_ROW_H + CH_ROW_GAP;
export const CH_OVERSCAN = 8;
export const CAT_ROW_H = 44;
export const CAT_OVERSCAN = 12;

export const DL_HIST = [
  { id: "hoy", label: "Hoy", maxH: 24 },
  { id: "ayer", label: "Ayer", maxH: 48 },
  { id: "d7", label: "Últimos 7 días", maxH: 24 * 7 },
  { id: "mes", label: "Este mes", maxH: 24 * 31 },
  { id: "m6", label: "Últimos 6 meses", maxH: 24 * 183 },
  { id: "old", label: "Más de 6 meses", maxH: Number.POSITIVE_INFINITY },
] as const;

export const DL_ST: Record<
  string,
  { id: string; label: string; color: string; bg: string; bar: string }
> = {
  running: {
    id: "active",
    label: "En progreso",
    color: "var(--text)",
    bg: "transparent",
    bar: "var(--accent)",
  },
  pending: {
    id: "queued",
    label: "En cola",
    color: "var(--muted)",
    bg: "transparent",
    bar: "var(--muted)",
  },
  cancelled: {
    id: "paused",
    label: "Detenido",
    color: "var(--warn)",
    bg: "var(--warn-bg)",
    bar: "var(--warn)",
  },
  failed: {
    id: "failed",
    label: "Falló",
    color: "var(--bad)",
    bg: "var(--bad-bg)",
    bar: "var(--bad)",
  },
  done: {
    id: "done",
    label: "Completado",
    color: "var(--ok)",
    bg: "var(--ok-bg)",
    bar: "var(--ok)",
  },
};

export const RENAME_SAMPLE: Record<string, string> = {
  "%MANGA%": "One Piece",
  "%WEBSITE%": "MangaDex",
  "%AUTHOR%": "Eiichiro Oda",
  "%ARTIST%": "Eiichiro Oda",
  "%NUMBERING%": "003",
  "%CHAPTER%": "Chapter 3",
  "%FILENAME%": "003",
};

export const PACK_EXT: Record<string, string> = {
  none: "",
  zip: ".zip",
  cbz: ".cbz",
  pdf: ".pdf",
  epub: ".epub",
};

export const GENRE_TRI_CYCLE: GenreTri[] = ["ignore", "include", "exclude"];
