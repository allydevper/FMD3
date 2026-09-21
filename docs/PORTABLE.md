# Portable release (carpeta + `FMD3.exe`)

El entregable principal para el usuario es una **carpeta portable**, no el
instalador NSIS. Cada zip/carpeta es una versión aislada: perfil y descargas
viven **junto al `.exe`**.

Debug (`tauri dev`) sigue usando `%AppData%\FMD3`. Ver también el README
(“Dónde viven los datos”).

## Requisitos

- Windows + PowerShell
- Python 3 (solo si migras perfil: reescribe rutas en `fmd3.db`)
- Un `FMD3.exe` de **release** ya compilado, o compilar antes (abajo)

## Compilar el exe

Desde la raíz del repo:

```powershell
npm run tauri:build
```

El binario queda en:

`src-tauri\target\release\FMD3.exe`

(`tauri.conf.json` sigue generando también el NSIS en
`src-tauri\target\release\bundle\nsis\`; el portable **no** usa ese setup.)

Si solo cambiaste Rust y el frontend `dist/` ya está al día:

```powershell
cd src-tauri
cargo build --release
```

## Empaquetar (script)

Desde la raíz del repo:

```powershell
# Solo exe → Desktop\FMD3-portable-<versión>\  (carpeta limpia)
.\scripts\pack-portable.ps1

# Con perfil y descargas de debug (cierra FMD3 antes)
.\scripts\pack-portable.ps1 -MigrateProfile -MigrateDownloads

# Versión / destino explícitos
.\scripts\pack-portable.ps1 -Version 1.1.0 -OutDir "$env:USERPROFILE\Desktop" -MigrateProfile -MigrateDownloads

# Compilar release y luego empaquetar
.\scripts\pack-portable.ps1 -Build -MigrateProfile -MigrateDownloads
```

Salida típica:

```
Desktop\FMD3-portable-1.0.0\
  FMD3.exe
  fmd3.db              # si -MigrateProfile
  userdata\
  data\
  cover-cache\
  downloads\           # si -MigrateDownloads (o vacío)
```

Con `-MigrateProfile` el script:

1. Copia `%AppData%\FMD3\*` dentro de la carpeta (incluye `-wal` / `-shm`).
2. Pone `default_output_dir` = `<portable>\downloads`.
3. Reescribe en `queue_items` las rutas que apuntaban a
   `target\debug\downloads` o `%USERPROFILE%\Downloads\FMD3`.

**Cierra FMD3** (ventana y bandeja) antes de migrar: SQLite no debe estar abierto.

## Publicar en GitHub (portable)

1. Sube la versión en `package.json`, `src-tauri/Cargo.toml` y
   `src-tauri/tauri.conf.json`.
2. Compila y empaqueta (`pack-portable.ps1`; sin migrar perfil si es build limpio
   para terceros).
3. Comprime la carpeta a `FMD3_<versión>_windows_x64.zip` (o similar).
4. Crea el Release en GitHub y sube el zip.

El self-updater actual ([`RELEASE-UPDATER.md`](RELEASE-UPDATER.md)) está pensado
para el setup NSIS. Con portable, la actualización típica es **descargar el zip
nuevo** (otra carpeta, o sustituir solo `FMD3.exe` y conservar el perfil).

Los módulos Lua no van dentro del zip. Al pulsar «Revisar actualización» el
portable descarga FMD2 y, con el overlay activo (Ajustes → Módulos), también
`allydevper/FMD3` rama `master`. El árbol queda en `userdata\lua` junto al exe.

## Checklist próxima versión

- [ ] Versión alineada en los tres archivos
- [ ] `npm run tauri:build` (o `cargo build --release` si `dist/` está listo)
- [ ] Cerrar FMD3
- [ ] `.\scripts\pack-portable.ps1` (+ `-MigrateProfile` / `-MigrateDownloads` si quieres tu data)
- [ ] Probar abriendo `FMD3-portable-…\FMD3.exe` (perfil aislado de AppData)
- [ ] Zip y Release en GitHub
