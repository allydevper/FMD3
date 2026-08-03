# Self-updater (GitHub Releases)

FMD3 uses [`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/) against:

`https://github.com/allydevper/FMD3/releases/latest/download/latest.json`

Only this repo is checked (no FMD2 fallback).

## Signing keys

- **Public** (committed / in `tauri.conf.json`): `.tauri/fmd3.key.pub`
- **Private** (lives **outside** the repo): `%USERPROFILE%\.fmd3-keys\fmd3.key`

The private key must never live inside the project folder — not even gitignored, since a
zip/copy of the folder would carry it along. Keep its password in a password manager; if the
release is ever automated, store both as GitHub secrets (`TAURI_SIGNING_PRIVATE_KEY` /
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).

Generate a new pair (only if rotating keys):

```powershell
npm run tauri signer generate -- -w $env:USERPROFILE\.fmd3-keys\fmd3.key -f --ci --password "YOUR_PASSWORD"
```

Copy the generated `.pub` next to it into `.tauri/fmd3.key.pub`, then paste its contents into
`src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.

### Build / release env

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -Raw $env:USERPROFILE\.fmd3-keys\fmd3.key)
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "YOUR_PASSWORD"   # if the key has one
npm run tauri:build
```

Without `TAURI_SIGNING_PRIVATE_KEY`, the NSIS build will not produce `.sig` updater artifacts.

## Publish a release

1. Bump version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` (keep them in sync).
2. Build with signing env set (above).
3. From `src-tauri/target/release/bundle/nsis/` take:
   - `FMD3_<version>_x64-setup.exe`
   - `FMD3_<version>_x64-setup.exe.sig`
4. Create `latest.json` (example for `0.2.0`):

```json
{
  "version": "0.2.0",
  "notes": "Changelog breve…",
  "pub_date": "2026-08-01T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<paste FULL contents of the .sig file>",
      "url": "https://github.com/allydevper/FMD3/releases/download/v0.2.0/FMD3_0.2.0_x64-setup.exe"
    }
  }
}
```

5. Create a GitHub Release tagged `v0.2.0` (or matching version), upload the `.exe`, `.sig`, and `latest.json`, and mark it as **Latest**.

Until `latest.json` exists on that URL, in-app check should report that there is no published update (not crash).

## In-app flow

- Option **Comprobar versión al iniciar** (`updater.check_on_start`)
- Sobre → **Revisar última versión**
- If newer: confirm → download/install (Windows `passive`) → relaunch
