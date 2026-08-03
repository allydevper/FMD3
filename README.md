<p align="center">
  <img src="src-tauri/icons/isologo.png" alt="FMD3" width="180">
</p>

<h1 align="center">FMD3</h1>

<p align="center">
  Cliente de escritorio para descargar manga, escrito en Rust + Tauri + React.<br>
  Reutiliza los módulos Lua de Free Manga Downloader 2 —<b>669 sitios</b>— sin arrastrar Lazarus.
</p>

<p align="center">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-2021-000000?logo=rust&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black">
  <img alt="Lua 5.4" src="https://img.shields.io/badge/Lua-5.4-2C2D72?logo=lua&logoColor=white">
  <img alt="GPL-2.0" src="https://img.shields.io/badge/licencia-GPL--2.0-blue">
</p>

---

## Estado

Versión `0.1.0`, en desarrollo activo. Funciona de punta a punta —catálogo,
descargas, favoritos, empaquetado— pero **todavía no hay ninguna release
publicada**, así que por ahora la única forma de usarlo es compilarlo.

> [!NOTE]
> **Pendiente para cuando se suba la primera release:**
> - [ ] Publicar el instalador `FMD3_<version>_x64-setup.exe` en [Releases](https://github.com/allydevper/FMD3/releases)
> - [ ] Sección **Instalación** con enlace de descarga directa
> - [ ] Badges de versión, descargas y build
> - [ ] Capturas de pantalla de la app (Explorar, Descargas, Favoritos)
> - [ ] `latest.json` firmado para el self-updater — ver [`docs/RELEASE-UPDATER.md`](docs/RELEASE-UPDATER.md)

## Qué hace

- **Explorar** — catálogo por sitio con filtro avanzado, portadas y `GetInfo`.
- **Descargas** — cola con SQLite, progreso en vivo, prioridades, reintentos y
  menú contextual.
- **Favoritos** — revisión automática de capítulos nuevos, encolado directo,
  ocultar sin borrar, e importar/exportar contra FMD2 u otro FMD3.
- **Empaquetado** — capítulos a ZIP/CBZ y afines, con renombrado configurable.
- **Módulos Lua** — 669 sitios (611 archivos), sincronizados desde GitHub por el
  updater interno.
- **Antibot** — websitebypass de FMD2 + Duktape embebido.
- **Self-updater** — comprobación de versión vía GitHub Releases.

## Instalación

> [!IMPORTANT]
> Pendiente: no hay release publicada todavía. Mientras tanto, compílalo
> siguiendo [Desarrollo](#desarrollo).

## Desarrollo

Requisitos: Node 20+, Rust estable y las
[dependencias de Tauri 2](https://tauri.app/start/prerequisites/).

```powershell
npm install
npm run tauri dev
```

En builds de **debug** el árbol Lua se resuelve solo al `lua/` de este repo
([`src-tauri/src/lua_host/paths.rs`](src-tauri/src/lua_host/paths.rs)), así que
no hace falta configurar nada. Para apuntar a otro árbol:

```powershell
$env:FMD_LUA_ROOT = "C:\ruta\a\otro\lua"
```

### Smoke tests

```powershell
cd src-tauri
cargo test --lib lua_host::duktape_js
cargo test --test registry_scan -- --ignored
cargo run --example smoke_niadd
```

`registry_scan` es el que confirma que el árbol Lua se resuelve bien: debe
escanear los 669 módulos. (`MangaPlus.lua` falla siempre: necesita el módulo C
`pb`, que no carga en modo seguro.)

Hay un catálogo de prueba servido por Vite para trabajar sin depender de sitios
reales — ver [`dev/README.md`](dev/README.md).

## Cómo funciona

1. El host de Lua (mlua 5.4) carga los módulos de `lua/modules` y las 40
   plantillas de `lua/templates`, exponiendo la misma API que el cliente
   Lazarus.
2. Tras `GetInfo`, los `chapter.link` se normalizan **sin host** (igual que
   `RemoveHostFromURLsPair` en FMD2); `GetPageNumber` recibe un path relativo y
   el Lua hace `MaybeFillHost(RootURL, URL)`.
3. Ante antibot: WebsiteBypass + Duktape (`use_webdriver: false` por defecto).

El HTTP lo hace `reqwest` desde Rust, no el WebView.

### Cloudflare (paridad con FMD2)

FMD2 **no** usa FlareSolverr por defecto: solo intenta el challenge IUAM legacy
con Duktape. Los sitios con Cloudflare moderno (Turnstile, `challenge-platform`)
fallan igual en FMD2 y aquí si no hay cookies válidas.

Opcional, como FMD2 con webdriver: pon `"use_webdriver": true` en
`lua/websitebypass/websitebypass_config.json` y ten Python + FlareSolverr
escuchando en `:8191`.

## Dónde viven los datos

| Ruta | Contenido |
|---|---|
| `%AppData%\FMD3\fmd3.db` | Ajustes, cola y caché de metadatos |
| `%AppData%\FMD3\userdata\favorites.db` | Favoritos |
| `%AppData%\FMD3\userdata\downloaded.db` | Marcas de capítulos descargados |
| `%AppData%\FMD3\userdata\lua\` | Árbol de módulos sincronizado |
| `%AppData%\FMD3\data\<module_id>.db` | Catálogo por sitio |
| `<carpeta del ejecutable>\downloads\` | Descargas (configurable en Ajustes) |

## Build

```powershell
npm run tauri build
```

El instalador **no** empaqueta `lua/`. El modules-updater descarga el árbol
completo a `%AppData%\FMD3\userdata\lua` en el primer arranque, y esa es la
única copia que existe en una instalación — así una actualización de la app
nunca pisa los módulos que ya sincronizaste.

El proceso completo de firma y publicación está en
[`docs/RELEASE-UPDATER.md`](docs/RELEASE-UPDATER.md).

## Documentación

- [`docs/LUA-REFERENCE.md`](docs/LUA-REFERENCE.md) — API Lua disponible para módulos
- [`docs/RELEASE-UPDATER.md`](docs/RELEASE-UPDATER.md) — releases y self-updater
- [`dev/README.md`](dev/README.md) — catálogo de prueba para desarrollo

## Créditos y licencia

Los módulos de `lua/` provienen de [FMD2](https://github.com/dazedcat19/FMD2)
(dazedcat19, NhKPaNdA y colaboradores), y el modules-updater se sincroniza
contra ese repositorio. Gracias también a los desarrolladores del FMD original:
Akarin-K, Anastasiadinara, SDXC, kavin-90, kmvi y riderkick.

Cliente FMD3 por [allydevper](https://github.com/allydevper).

GPL-2.0 — ver [`license.txt`](license.txt).
