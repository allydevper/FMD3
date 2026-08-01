# Dev fixtures (not shipped as release assets)

## TestCatalog mock (`/__test_catalog` on Vite :1420)

1. Titles: `dev/test-catalog-titles.json` (seed) + **10 downloadable** `dl-0001`…`dl-0010` (built into the Vite plugin).
2. Chapter images: repo `.plan/caps/{1..8}/*.jpg` (gitignored; not copied into `dev/`).
   Each image GET waits ~120ms (`IMAGE_DELAY_MS` in the Vite plugin) to simulate download latency; HTML stays ~50ms.
3. Run **`tauri dev`** — Vite middleware serves the mock (no extra port).
4. In the app: Ajustes → Sitios Web → enable **TestCatalog**.
5. Catálogo → Actualizar lista.
6. **Page 1** lists the 10 `dl-*` titles first as `01 · …` … `10 · …` (mixed short/long names; `dl-0001` has 12 chapters, the rest 8).
7. After changing the mock links, **reset** the TestCatalog DB and Actualizar lista again (old rows lack the correct `/series/...` paths).
8. Reset DB: delete `%AppData%\fmd-mvp\data\ffffffffffffffffffffffffffffffff.db`

### Downloads smoke test

1. Right-click a `dl-*` row → **Descargar todo**, or open info and enqueue selected chapters.
2. Descargas: pause/resume, collapse groups, clear finished.
3. Images come from `/__test_catalog/caps/{n}/…` (same folders for every title).

Browser check: http://localhost:1420/__test_catalog/directorio?p=1  
Chapter sample: http://localhost:1420/__test_catalog/series/dl-0001/ch-1/  
Optional delay: `?delay=120` (ms).

Lua module: `lua/modules/TestCatalog.lua` (RootURL uses `localhost`, not `127.0.0.1`).
