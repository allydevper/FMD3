# FMD MVP (Rust + Tauri + Lua)

Host mínimo que **reutiliza** los módulos Lua de FMD2 sin compilar Lazarus.

**Pilotos:** LeerCapitulo, MangaOni, NiAddES (`es.niadd.com`). Auto-match por host + selector manual de módulo.

Flujo:

1. Pegar URL → Auto elige módulo (o selector) → `GetInfo`  
2. Encolar selección → worker descarga un capítulo a la vez (`GetPageNumber` / `GetImageURL`)  
3. Favoritos + Check usan `module_id` del favorito  

Datos en `%AppData%/fmd-mvp/fmd-mvp.db` (SQLite). **No** hay catálogo `.db` por sitio ni FMD2-DB en este MVP.

## Setup (Windows)

### 1. Rust

```powershell
winget install Rustlang.Rustup
# Reinicia la terminal, luego:
rustc --version
```

### 2. Node.js LTS

```powershell
node --version
npm --version
```

### 3. Build Tools (C++)

Tauri y las crates nativas (Lua vendored) necesitan el linker de MSVC:

- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)  
- Workload: **Desktop development with C++**

### 4. WebView2

En Windows 10/11 suele venir instalado. Si falta: [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

### 5. Dependencias del proyecto

```powershell
cd fmd-mvp
npm install
```

### Variable opcional

Por defecto los Lua se leen desde `../lua` (modules + templates).

```powershell
$env:FMD_LUA_ROOT = "C:\ruta\a\FMD3\lua"
```

## Desarrollo

```powershell
cd fmd-mvp
npm run tauri dev
```

### Smoke tests (sin UI)

Desde `fmd-mvp/src-tauri`:

```powershell
# Regresión LeerCapitulo
cargo run --example smoke_info -- --module LeerCapitulo "https://www.leercapitulo.co/manga/one-piece/"
cargo run --example smoke_pages -- --module LeerCapitulo "https://www.leercapitulo.co/leer/f8nq66m5nm/one-piece/1/" "$env:TEMP\fmd-mvp-smoke"

# MangaOni
cargo run --example smoke_info -- --module MangaOni "https://manga-oni.com/manga/one-piece/"
cargo run --example smoke_pages -- --module MangaOni "<chapter_url>" "$env:TEMP\fmd-mvp-oni"

# NiAddES (es.niadd.com) — GetInfo + template NiAdd; capítulos en CDN ninemanga
cargo run --example smoke_info -- --module NiAddES "https://es.niadd.com/manga/One_Piece.html"
cargo run --example smoke_niadd -- "https://es.niadd.com/manga/One_Piece.html"

> **Nota NiAdd:** `GetInfo` está validado (título + capítulos, `module_id=482deba…`). El lector de páginas vive en `es.ninemanga.com` y puede devolver **403/Cloudflare** desde algunos entornos; el bridge (`PageContainerLinks` / `GetImageURL` / `WORKID` / Referer) está implementado y se ejercita cuando el CDN responde. Cloudflare/FlareSolverr queda fuera de este sprint.

cargo run --example smoke_queue
```

Sin `--module`, el host hace auto-match por host de la URL.

## Build / “deploy dist”

```powershell
cd fmd-mvp
npm run tauri build
```

El instalador empaqueta `lua/modules` y `lua/templates` como resources del exe.

Salida típica:

- Exe: `src-tauri/target/release/fmd-mvp.exe`  
- Instalador NSIS: `src-tauri/target/release/bundle/nsis/`

## Fuera de este MVP

- Catálogo / `GetNameAndLink` / DB FMD2-DB por sitio  
- Madara masivo y otros templates (salvo NiAdd)  
- Cloudflare / FlareSolverr  

## Estructura

```
fmd-mvp/
  src/                 UI (Auto + selector de módulo)
  src-tauri/src/
    lua_host/          registry + bridge mlua
    xpath.rs           CreateTXQuery (subset + contexto)
    download.rs        imágenes (+ Referer)
    queue.rs / db.rs   cola con module_id
../lua/modules/        módulos FMD
../lua/templates/      plantillas (NiAdd, …)
```
