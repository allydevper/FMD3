# Dev fixtures (not shipped as release assets)

## TestCatalog mock (`/__test_catalog` on Vite :1420)

1. Copy/update titles: `dev/test-catalog-titles.json` (schema: `titles`, `descriptions`, `genres`, `links`).
2. Run **`tauri dev`** — Vite middleware serves the mock (no extra port).
3. In the app: Ajustes → Sitios Web → enable **TestCatalog**.
4. Catálogo → Actualizar lista.
5. Reset DB: delete `%AppData%\fmd-mvp\data\ffffffffffffffffffffffffffffffff.db`

Browser check: http://localhost:1420/__test_catalog/directorio?p=1  
Optional delay: `?delay=120` (ms).

Lua module: `lua/modules/TestCatalog.lua` (RootURL uses `localhost`, not `127.0.0.1`).
