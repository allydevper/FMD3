# FMD Host (Rust + Tauri + Lua)

Host de escritorio que **reutiliza** los módulos Lua de FMD2 sin Lazarus.

**Pilotos:** LeerCapitulo, MangaOni, NiAddES, catálogo LoliVault.

## Stack

- UI: Tauri + TypeScript  
- Backend: Rust + mlua + reqwest + SQLite  
- Módulos: `lua/modules` + `lua/templates`  
- **Cloudflare:** mismos scripts que FMD2 (`lua/websitebypass/`) + **Duktape** embebido

## Flujo

1. Manga / Catálogo / Cola / Favoritos.  
2. Tras `GetInfo`, los `chapter.link` se normalizan **sin host** (como FMD2 `RemoveHostFromURLsPair`); `GetPageNumber` recibe path relativo y el Lua hace `MaybeFillHost(RootURL, URL)`.  
3. Ante antibot: WebsiteBypass + Duktape (`use_webdriver: false` por defecto).

Datos: `%AppData%/fmd-mvp/fmd-mvp.db` y `data/<module_id>.db`.

## Setup (Windows)

```powershell
cd fmd-mvp
npm install
npm run tauri dev
```

```powershell
$env:FMD_LUA_ROOT = "C:\ruta\a\FMD3\lua"
```

## Cloudflare (paridad FMD2)

FMD2 **no** usa FlareSolverr por defecto. Solo intenta el challenge IUAM legacy con Duktape. Sitios con Cloudflare moderno (Turnstile / `challenge-platform`) fallan igual en FMD2 y en este host si no hay cookies válidas.

Opcional (avanzado, como FMD2 con webdriver): pon `"use_webdriver": true` en `lua/websitebypass/websitebypass_config.json` y ten Python + FlareSolverr en `:8191`.

## Smoke

```powershell
cd fmd-mvp/src-tauri
cargo test --lib lua_host::duktape_js
cargo run --example smoke_niadd
```

## Build

```powershell
cd fmd-mvp
npm run tauri build
```

Empaqueta `lua/modules`, `lua/templates`, `lua/websitebypass`, `lua/utils`.
