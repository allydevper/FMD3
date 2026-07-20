# FMD Host (Rust + Tauri + Lua)

Host de escritorio que **reutiliza** los módulos Lua de FMD2 sin Lazarus.

**Pilotos de scraping:** LeerCapitulo, MangaOni, NiAddES (GetInfo).  
**Piloto de catálogo:** LoliVault (`lector.lolivault.net`) — UpdateList rápido / pocos títulos.

## Flujo

1. **Manga:** pegar URL → Auto/módulo → `GetInfo` → encolar capítulos.  
2. **Catálogo:** elegir sitio → Actualizar lista o Importar `.db` → buscar → clic → GetInfo.  
3. **Cola / Favoritos:** descarga y check de capítulos nuevos (`module_id` correcto).

Datos:

- App: `%AppData%/fmd-mvp/fmd-mvp.db`
- Catálogo por sitio: `%AppData%/fmd-mvp/data/<module_id>.db` (`masterlist`, compatible FMD2)

## Setup (Windows)

```powershell
cd fmd-mvp
npm install
npm run tauri dev
```

Variable opcional:

```powershell
$env:FMD_LUA_ROOT = "C:\ruta\a\FMD3\lua"
```

## Smoke tests

Desde `fmd-mvp/src-tauri`:

```powershell
# Catálogo LoliVault (GetNameAndLink → .db)
cargo run --example smoke_catalog

# O importar un .db FMD2 local
cargo run --example smoke_catalog -- --import "C:\ruta\a\218b722b1eb34f2aa3863f84538c5b08.db"

# GetInfo
cargo run --example smoke_info -- --module LeerCapitulo "https://www.leercapitulo.co/manga/one-piece/"
cargo run --example smoke_pages -- --module MangaOni "https://manga-oni.com/lector/one-piece/80/" "$env:TEMP\fmd-smoke"
```

## Build

```powershell
cd fmd-mvp
npm run tauri build
```

Empaqueta `lua/modules` y `lua/templates` como resources.

## Fuera de alcance (por ahora)

- FMD2-DB remoto (`.7z`)
- Cloudflare / FlareSolverr
- `json(*)` en FoOlSlide `GetPageNumber` (descarga de páginas LoliVault)
- Rename de la carpeta `fmd-mvp`
