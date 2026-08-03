# FMD3 — Host de descargas (Rust + Tauri + Lua)

Host de escritorio que **reutiliza** los módulos Lua de FMD2 sin Lazarus.

**Pilotos:** LeerCapitulo, MangaOni, NiAddES, catálogo LoliVault.

## Stack

- UI: Tauri 2 + React + TypeScript  
- Backend: Rust + mlua + reqwest + SQLite  
- Módulos: `lua/modules` + `lua/templates`  
- **Cloudflare:** mismos scripts que FMD2 (`lua/websitebypass/`) + **Duktape** embebido

## Flujo

1. Manga / Catálogo / Cola / Favoritos.  
2. Tras `GetInfo`, los `chapter.link` se normalizan **sin host** (como FMD2 `RemoveHostFromURLsPair`); `GetPageNumber` recibe path relativo y el Lua hace `MaybeFillHost(RootURL, URL)`.  
3. Ante antibot: WebsiteBypass + Duktape (`use_webdriver: false` por defecto).

Datos: `%AppData%/FMD3/fmd3.db` y `data/<module_id>.db`.

## Setup (Windows)

```powershell
npm install
npm run tauri dev
```

En builds de **debug** el árbol Lua se resuelve solo al `lua/` de este repo
(`src-tauri/src/lua_host/paths.rs`), así que no hace falta configurar nada.
Para apuntar a otro árbol:

```powershell
$env:FMD_LUA_ROOT = "C:\ruta\a\otro\lua"
```

## Cloudflare (paridad FMD2)

FMD2 **no** usa FlareSolverr por defecto. Solo intenta el challenge IUAM legacy con Duktape. Sitios con Cloudflare moderno (Turnstile / `challenge-platform`) fallan igual en FMD2 y en este host si no hay cookies válidas.

Opcional (avanzado, como FMD2 con webdriver): pon `"use_webdriver": true` en `lua/websitebypass/websitebypass_config.json` y ten Python + FlareSolverr en `:8191`.

## Smoke

```powershell
cd src-tauri
cargo test --lib lua_host::duktape_js
cargo run --example smoke_niadd
```

## Build

```powershell
npm run tauri build
```

El instalador **no** empaqueta `lua/`. El modules-updater descarga el árbol
completo a `%AppData%\FMD3\userdata\lua` en el primer arranque y esa es la
única copia que existe en una instalación — así una actualización de la app no
pisa los módulos que el usuario ya sincronizó. Ver `docs/RELEASE-UPDATER.md`.

## Créditos y licencia

Los módulos de `lua/` provienen de [FMD2](https://github.com/dazedcat19/FMD2)
(dazedcat19) y el modules-updater se sincroniza contra ese repositorio.

GPL-2.0 — ver `license.txt`.
