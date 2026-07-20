# FMD MVP (Rust + Tauri + Lua)

Host mínimo que **reutiliza** los módulos Lua de FMD2 (piloto: `LeerCapitulo.lua`) sin compilar Lazarus.

Flujo MVP:

1. Pegar URL de un manga en leercapitulo.co  
2. `GetInfo` (Lua) → título + capítulos  
3. Encolar selección → worker descarga un capítulo a la vez  
4. Favoritos + Check (capítulos nuevos) → opcional encolar  

Datos en `%AppData%/fmd-mvp/fmd-mvp.db` (SQLite).

## Setup (Windows)

### 1. Rust

```powershell
winget install Rustlang.Rustup
# Reinicia la terminal, luego:
rustc --version
```

Asegúrate de tener el target MSVC (lo instala rustup por defecto en Windows).

### 2. Node.js LTS

Ya puedes usar npm. Verifica:

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

> **XPath:** este MVP usa un motor HTML/XPath **puro en Rust** (crate `scraper`) para el subset que usa LeerCapitulo. No hace falta instalar libxml2. Más adelante se puede ampliar o sustituir por libxml si se necesitan XPath más exóticos.

### Variable opcional

Por defecto los Lua se leen desde `../lua/modules` (relativo al crate `src-tauri`).

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
cargo run --example smoke_info -- "https://www.leercapitulo.co/manga/one-piece/"
cargo run --example smoke_pages -- "https://www.leercapitulo.co/leer/f8nq66m5nm/one-piece/1/" "$env:TEMP\fmd-mvp-smoke"
cargo run --example smoke_queue
```

## Build / “deploy dist”

```powershell
cd fmd-mvp
npm run tauri build
```

Salida típica:

- Exe: `src-tauri/target/release/fmd-mvp.exe`  
- Instalador NSIS: `src-tauri/target/release/bundle/nsis/`

No usa Lazarus ni `make_release_win.bat`.

> Nota: en algunos entornos el `target/` de Cargo puede estar en otra ruta (caché). Lo importante es que el binario principal sea **`fmd-mvp.exe`**, no los ejemplos smoke.

## Fuera de este MVP

- Catálogo / `GetNameAndLink` / DB FMD2-DB  
- Favoritos, PDF/EPUB, proxy UI, updater de módulos  

## Estructura

```
fmd-mvp/
  src/                 UI
  src-tauri/src/
    lua_host/          bridge mlua (HTTP, MANGAINFO, TASK, crypto…)
    xpath.rs           CreateTXQuery (subset)
    download.rs        guardado de imágenes
    commands.rs        get_manga_info / download_chapters
../lua/modules/        módulos FMD originales (sin copiar)
```
