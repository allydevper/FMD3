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

Versión **1.0.0**. El instalador se publica en
[Releases](https://github.com/allydevper/FMD3/releases).

> [!NOTE]
> Tras instalar, el primer arranque descarga los módulos Lua (hace falta red).
> Luego ve a **Ajustes → Sitios Web**, marca los que quieras y actualiza el catálogo.

## Qué hace

- **Explorar** — catálogo por sitio con filtro avanzado, portadas y `GetInfo`.
- **Descargas** — cola con SQLite, progreso en vivo, prioridades, reintentos y
  menú contextual.
- **Favoritos** — revisión automática de capítulos nuevos, encolado directo,
  ocultar sin borrar, e importar/exportar contra FMD2 u otro FMD3.
- **Empaquetado** — capítulos a ZIP/CBZ y afines, con renombrado configurable.
- **Módulos Lua** — 669 sitios (611 archivos), sincronizados desde GitHub por el
  updater interno.
- **Antibot** — websitebypass de FMD2 + Duktape. Para varios bloqueos de
  Cloudflare conviene [Cloudflare One](https://one.one.one.one/) (WARP) y
  reintentar; en Ajustes → Red hay un navegador interno opcional si no basta.
- **Self-updater** — comprobación de versión vía GitHub Releases.

## Instalación

Windows x64: descarga `FMD3_1.0.0_x64-setup.exe` desde
[Releases](https://github.com/allydevper/FMD3/releases/latest).

El self-updater comprueba
[`latest.json`](https://github.com/allydevper/FMD3/releases/latest/download/latest.json)
en esa misma página. Cómo firmar y publicar: [`docs/RELEASE-UPDATER.md`](docs/RELEASE-UPDATER.md).

Para compilar desde el código, sigue [Desarrollo](#desarrollo).

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

El HTTP lo hace `reqwest` desde Rust, no el WebView — salvo cuando se abre el
navegador interno para Cloudflare (ver abajo), donde sí es un WebView2 real el
que navega, ejecuta JS y resuelve el reto.

### Cloudflare (paridad con FMD2)

Para algunos bloqueos se recomienda instalar el cliente
[Cloudflare One](https://one.one.one.one/) (WARP) y reintentar la descarga.

FMD2 **no** usa FlareSolverr por defecto: solo intenta el challenge IUAM legacy
con Duktape. Los sitios con Cloudflare moderno (Turnstile, `challenge-platform`)
fallan igual en FMD2 y aquí si no hay cookies válidas.

En Ajustes → Red, **Navegador interno (Cloudflare)** abre una ventana de la app
cuando WARP no alcanza, para cualquier sitio detrás de Cloudflare. No lo
combines con proxy.

Opcional, como FMD2 con webdriver: pon `"use_webdriver": true` en
`lua/websitebypass/websitebypass_config.json` y ten Python + FlareSolverr
escuchando en `:8191`.

## Dónde viven los datos

**Debug (`tauri dev`):** perfil en **`%AppData%\FMD3`**. Descargas por defecto en
`%USERPROFILE%\Downloads\FMD3` (o la ruta que tengas en *Guardar en*).

**Release / portable:** perfil y descargas **junto al `.exe`**. Cada carpeta
descomprimida es una versión aislada (no comparte AppData con debug ni con otro zip).

| Ruta (portable) | Contenido |
|---|---|
| `<carpeta>\fmd3.db` | Ajustes, cola y caché de metadatos |
| `<carpeta>\userdata\favorites.db` | Favoritos |
| `<carpeta>\userdata\downloaded.db` | Marcas de capítulos descargados |
| `<carpeta>\userdata\lua\` | Árbol de módulos (sync al primer arranque) |
| `<carpeta>\data\<module_id>.db` | Catálogo por sitio |
| `<carpeta>\cover-cache\` | Portadas en disco |
| `<carpeta>\downloads\` | Descargas por defecto |

SQLite puede crear sidecars `*.db-wal` y `*.db-shm`. Cierra FMD3 antes de copiar
el perfil; copia **toda** la carpeta, no solo el `.db`.

### Pasar de debug a un portable (misma máquina)

1. Cierra FMD3 (ventana y bandeja).
2. Copia el contenido de `%AppData%\FMD3` **dentro** de la carpeta del portable
   (junto a `FMD3.exe`).
3. Copia tus descargas (p. ej. `src-tauri\target\debug\downloads` o
   `%USERPROFILE%\Downloads\FMD3`) a `<portable>\downloads\`.
4. En Ajustes, pon *Guardar en* a esa carpeta `downloads` (si la cola guardaba
   rutas absolutas de debug, cámbialas o reescribe el ajuste).
5. **Lua.** En debug es el `lua/` del repo. En portable el primer arranque
   sincroniza a `userdata\lua`. No copies el `lua/` del repo salvo parches locales.
6. TestCatalog y demás `Category=Test` no aparecen en release.

## Build

```powershell
npm run tauri build
```

El instalador NSIS (si lo generas) **no** empaqueta `lua/`. El modules-updater
descarga el árbol a `userdata\lua` junto al exe (portable) o, en builds antiguos
que aún usaban AppData, a `%AppData%\FMD3\userdata\lua`.

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
