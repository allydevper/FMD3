#Requires -Version 5.1
<#
.SYNOPSIS
  Empaqueta FMD3 como carpeta portable (exe + opcional perfil/descargas de debug).

.DESCRIPTION
  Lee la versión de package.json (o -Version), crea Desktop\FMD3-portable-<ver>\
  (o -OutDir), copia src-tauri\target\release\FMD3.exe y, opcionalmente, migra
  %AppData%\FMD3 y las descargas de debug reescribiendo rutas en fmd3.db.

  Documentación: docs/PORTABLE.md

.EXAMPLE
  .\scripts\pack-portable.ps1
.EXAMPLE
  .\scripts\pack-portable.ps1 -MigrateProfile -MigrateDownloads
.EXAMPLE
  .\scripts\pack-portable.ps1 -Build -Version 1.1.0 -MigrateProfile
#>
[CmdletBinding()]
param(
  [string]$Version = "",
  [string]$OutDir = "",
  [switch]$MigrateProfile,
  [switch]$MigrateDownloads,
  [switch]$Build,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot

function Get-PackageVersion {
  $pkgPath = Join-Path $RepoRoot "package.json"
  $raw = Get-Content -Raw -Path $pkgPath
  if ($raw -match '"version"\s*:\s*"([^"]+)"') {
    return $Matches[1]
  }
  throw "No se pudo leer version de package.json"
}

if (-not $Version) {
  $Version = Get-PackageVersion
}

if (-not $OutDir) {
  $OutDir = [Environment]::GetFolderPath("Desktop")
}

$Dest = Join-Path $OutDir "FMD3-portable-$Version"
$ExeSrc = Join-Path $RepoRoot "src-tauri\target\release\FMD3.exe"
$AppData = Join-Path $env:APPDATA "FMD3"
$DebugDl = Join-Path $RepoRoot "src-tauri\target\debug\downloads"
$UserDl = Join-Path $env:USERPROFILE "Downloads\FMD3"

Write-Host "Repo:     $RepoRoot"
Write-Host "Version:  $Version"
Write-Host "Destino:  $Dest"

if ($Build) {
  Write-Host "Compilando (npm run tauri:build)…"
  npm run tauri:build
  if ($LASTEXITCODE -ne 0) {
    throw "tauri:build falló (código $LASTEXITCODE)"
  }
}

if (-not (Test-Path $ExeSrc)) {
  throw "No está $ExeSrc. Compila con: npm run tauri:build  (o pasa -Build)"
}

$running = Get-Process -Name "FMD3", "fmd3" -ErrorAction SilentlyContinue
if ($running -and ($MigrateProfile -or $MigrateDownloads)) {
  throw "Cierra FMD3 (ventana/bandeja) antes de migrar perfil o descargas. PIDs: $($running.Id -join ', ')"
}

if (Test-Path $Dest) {
  if (-not $Force) {
    $ans = Read-Host "Ya existe $Dest. ¿Borrar y recrear? [s/N]"
    if ($ans -notmatch '^[sSyY]') {
      throw "Cancelado."
    }
  }
  Remove-Item -Recurse -Force $Dest
}

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item -Force $ExeSrc (Join-Path $Dest "FMD3.exe")
Write-Host "Copiado FMD3.exe"

$DownloadsDest = Join-Path $Dest "downloads"
New-Item -ItemType Directory -Force -Path $DownloadsDest | Out-Null

if ($MigrateProfile) {
  if (-not (Test-Path $AppData)) {
    throw "No existe $AppData (nada que migrar)."
  }
  Write-Host "Copiando perfil desde $AppData …"
  Copy-Item -Force -Recurse (Join-Path $AppData "*") $Dest
  # Asegura downloads/ tras el copy (AppData no la trae)
  New-Item -ItemType Directory -Force -Path $DownloadsDest | Out-Null
}

if ($MigrateDownloads) {
  $copied = $false
  if (Test-Path $DebugDl) {
    Write-Host "Copiando descargas desde $DebugDl …"
    Copy-Item -Force -Recurse (Join-Path $DebugDl "*") $DownloadsDest
    $copied = $true
  }
  if (Test-Path $UserDl) {
    Write-Host "Copiando descargas desde $UserDl …"
    Copy-Item -Force -Recurse (Join-Path $UserDl "*") $DownloadsDest
    $copied = $true
  }
  if (-not $copied) {
    Write-Host "Aviso: no hay carpeta de descargas de debug ni Downloads\FMD3."
  }
}

$dbPath = Join-Path $Dest "fmd3.db"
if ($MigrateProfile -and (Test-Path $dbPath)) {
  $py = Get-Command python -ErrorAction SilentlyContinue
  if (-not $py) {
    $py = Get-Command py -ErrorAction SilentlyContinue
  }
  if (-not $py) {
    Write-Warning "Python no encontrado: no se reescribieron rutas en fmd3.db. Ajusta Guardar en a mano."
  }
  else {
    $newDl = (Resolve-Path $DownloadsDest).Path
    $oldDebug = ""
    if (Test-Path $DebugDl) {
      $oldDebug = (Resolve-Path $DebugDl).Path
    }
    $script = @"
import sqlite3
db = r'''$dbPath'''
new_dl = r'''$newDl'''
olds = []
for p in [r'''$oldDebug''', r'''$UserDl''']:
    p = p.strip()
    if p:
        olds.append(p)
conn = sqlite3.connect(db)
cur = conn.cursor()
cur.execute("SELECT value FROM settings WHERE key='default_output_dir'")
row = cur.fetchone()
print('old default_output_dir:', row[0] if row else None)
cur.execute(
    "INSERT INTO settings(key,value) VALUES('default_output_dir',?) "
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    (new_dl,),
)
for col in ('output_dir', 'manga_path', 'chapter_path'):
    cur.execute(f'SELECT id, {col} FROM queue_items WHERE {col} IS NOT NULL AND {col} != ""')
    n = 0
    for id_, val in cur.fetchall():
        if not val:
            continue
        newv = val
        lower = val.lower()
        for old in olds:
            if not old:
                continue
            idx = lower.find(old.lower())
            if idx == 0:
                newv = new_dl + val[len(old):]
                break
            if idx > 0:
                newv = val[:idx] + new_dl + val[idx + len(old):]
                break
        if newv != val:
            cur.execute(f'UPDATE queue_items SET {col}=? WHERE id=?', (newv, id_))
            n += 1
    print(f'rewrote {n} queue_items.{col}')
conn.commit()
cur.execute("SELECT value FROM settings WHERE key='default_output_dir'")
print('new default_output_dir:', cur.fetchone()[0])
conn.close()
print('OK')
"@
    Write-Host "Reescribiendo rutas en fmd3.db …"
    & $py.Source -c $script
    if ($LASTEXITCODE -ne 0) {
      throw "Falló la reescritura de rutas (python)."
    }
  }
}

Write-Host ""
Write-Host "Portable listo:"
Write-Host "  $Dest"
Write-Host "Abre FMD3.exe desde ahí. Para distribuir: comprime esa carpeta a un .zip."
