export type ChapterInfo = {
  index: number;
  name: string;
  link: string;
};

export type MangaInfoResult = {
  title: string;
  cover: string;
  authors: string;
  artists: string;
  genres: string;
  alt_titles: string;
  status: string;
  summary: string;
  chapters: ChapterInfo[];
  module_id: string;
  module_name: string;
  root_url: string;
};

export type QueueItem = {
  id: number;
  manga_title: string;
  root_url: string;
  manga_url?: string;
  module_id: string;
  chapter_index: number;
  chapter_name: string;
  chapter_link: string;
  output_dir: string;
  status: string;
  error: string;
  created_at: string;
  updated_at: string;
  position?: number;
  retry_count?: number;
};

export type QueueAddRequest = {
  manga_title: string;
  root_url: string;
  manga_url?: string;
  module_id: string;
  output_dir: string;
  chapters: ChapterInfo[];
  /** If false, enqueue without starting the worker (tarea detenida). Default true. */
  start?: boolean;
};

export type ModuleMeta = {
  id: string;
  name: string;
  root_url: string;
  category: string;
  file_path?: string;
  mtime?: number | null;
};

export type Favorite = {
  id: number;
  module_id: string;
  module_name: string;
  root_url: string;
  manga_url: string;
  title: string;
  last_chapter_link: string;
  last_chapter_name: string;
  chapter_count: number;
  updated_at: string;
  enabled?: boolean;
  last_checked_at?: string;
};

export type FavoriteAddRequest = {
  module_id: string;
  module_name: string;
  root_url: string;
  manga_url: string;
  title: string;
  chapters: ChapterInfo[];
};

export type FavoriteCheckResult = {
  favorite: Favorite;
  new_chapters: ChapterInfo[];
  enqueued: number;
};

export type QueueProgressEvent = {
  item_id: number;
  manga_title: string;
  chapter_name: string;
  message: string;
  pending_left: number;
  page_current: number;
  page_total: number;
  bytes_per_sec?: number;
  bytes_current?: number;
};

export type CatalogEntry = {
  link: string;
  title: string;
  alttitles: string;
  authors: string;
  artists: string;
  genres: string;
  status: string;
  summary: string;
  numchapter: number;
  jdn: number;
  cover: string;
  /** GetInfo failed / inaccessible (`manga_cache.title = 'N/A'`). */
  info_failed?: boolean;
  /** Module that owns this catalog row (all-sites filter / search). */
  module_id?: string;
  module_name?: string;
};

export type MangaCacheRow = {
  link: string;
  title?: string;
  alt_titles?: string;
  authors: string;
  artists: string;
  genres: string;
  status: string;
  summary: string;
  numchapter: number;
  cover: string;
  updated_at: string;
};

export type CatalogStats = {
  module_id: string;
  path: string;
  count: number;
};

export type GenreTri = "ignore" | "include" | "exclude";
export type InfoMode = "search" | "filter";

export type AdvFilterState = {
  genres: Record<string, GenreTri>;
  customGenres: string;
  title: string;
  authors: string;
  artists: string;
  summary: string;
  status: 0 | 1 | 2 | 3 | 4;
  matchMode: "all" | "one";
  onlyNew: boolean;
  allSites: boolean;
  useRegex: boolean;
};

export type UpdateListStats = {
  module_id: string;
  inserted: number;
  total_in_db: number;
  pages_fetched: number;
};

export type NavId = "downloads" | "info" | "favorites" | "about" | "options";

export type CatalogProgressEvent = {
  module_id: string;
  page: number;
  page_total: number;
  inserted_total: number;
  batch_rows: number;
  directory_index?: number;
};

export type CatalogFetchProgressEvent = {
  module_id: string;
  phase: string;
  bytes_done: number;
  bytes_total: number;
  message: string;
};

export type CatalogJobMode = "update" | "fetch";
export type CatalogJobScope = "one" | "all";

export type CatalogJobState = {
  mode: CatalogJobMode;
  scope: CatalogJobScope;
  moduleId: string;
  moduleName: string;
  index: number;
  total: number;
  page: number;
  pageTotal: number;
  bytesDone: number;
  bytesTotal: number;
  message: string;
  cancelling: boolean;
};

export type LiveProgress = {
  page_current: number;
  page_total: number;
  message: string;
  chapter_name: string;
  bytes_per_sec?: number;
};
