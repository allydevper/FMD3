# Extras FMD2 (backlog host)

Pendientes fuera de sprints activos / aparcados.

## Pendientes

_(vacío — fases del plan completo implementadas en host)_

## Hecho

- `GetBetween`, `ParseHTML`, `fmd.imagepuzzle`
- Log `Init` / carga de módulos en registry
- Cancelación de cola en `download_chapter` + `HTTP.Terminated`
- Reanudar: skip pre-GET + `queue_retry` / Retry UI
- **Settings red:** `http.user_agent`, `http.proxy`, `download.max_threads` (UI Ajustes)
- **Límites módulo:** `MaxTaskLimit`, `MaxThreadPerTaskLimit`, `MaxConnectionLimit` en ModuleState
- **Pack CBZ/ZIP** post-capítulo (`download.pack_format`, `download.pack_delete_folder`)
- **Paralelismo de imágenes** (si no hay hooks Lua de download; respeta threads + MaxThreadPerTaskLimit)
- **Custom rename:** `%Manga%` `%Chapter%` `%ChapterIndex%` `%Page%` `%Website%`
- **Favoritos check:** UI muestra último cap; Check / Check+encolar
- **`fmd.mangafoxwatermark`:** LoadTemplate / RemoveWatermark
- **Convertir al guardar:** jpg/png/webp (`download.convert_to`)
- **`fmd.crypto` ampliado:** MD5/SHA1/SHA256/SHA512, HMAC_*, AES CBC/CTR, RC4, Hex, HTML*, Base64, URL*

## Aparcado

- Login / cuentas (`OnLogin`, `OnAccountState`, cookies de cuenta)
- PDF / EPUB (solo CBZ/ZIP en pack)
- ImageMagick externo (conversión vía crate `image`)
