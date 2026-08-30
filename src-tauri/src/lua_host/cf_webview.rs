//! Cloudflare challenge via the app's embedded WebView2 (no FlareSolverr).
//!
//! Create/read the window from a worker thread: on Windows, `WebviewWindowBuilder`
//! and `cookies()` deadlock if called from a synchronous command on the main thread.
//!
//! The window stays open across pages/chapters and is docked over a slot in
//! Downloads. It is not hidden after each solve — only released when the queue
//! goes idle for real, or when the user closes the panel.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use url::Url;

use super::lua_log;

pub const WINDOW_LABEL: &str = "cf-bypass";

const VISIBLE_WAIT: Duration = Duration::from_secs(102);
const POLL: Duration = Duration::from_millis(400);
const REUSE_TTL: Duration = Duration::from_secs(30);

/// Hooks fetch/XHR before the reader scripts run, so page JSON is captured.
const PAGE_HOOK: &str = r#"
(() => {
  try {
    if (window.__fmdHook) return;
    window.__fmdHook = true;
    window.__fmdPages = [];
    window.__fmdJson = '';
    const add = (u) => {
      if (typeof u !== 'string' || u.length < 8) return;
      if (window.__fmdPages.indexOf(u) === -1) window.__fmdPages.push(u);
    };
    const walk = (o, d) => {
      if (!o || d > 8) return;
      if (typeof o === 'string') {
        if (/imgURL|\/umanga\/|\.(jpe?g|png|webp|gif)(\?|$)/i.test(o) && o.length < 2000) add(o);
        return;
      }
      if (Array.isArray(o)) { o.forEach((x) => walk(x, d + 1)); return; }
      if (typeof o === 'object') {
        if (o.imgURL) add(String(o.imgURL));
        Object.keys(o).forEach((k) => walk(o[k], d + 1));
      }
    };
    const take = (t) => {
      if (typeof t === 'string' && t.length >= 10) {
        if (/imgURL|pUrl/.test(t) && t.length > (window.__fmdJson || '').length) window.__fmdJson = t;
        try { walk(JSON.parse(t), 0); } catch (e) {}
      }
    };
    const ofetch = window.fetch;
    if (typeof ofetch === 'function') {
      window.fetch = function () {
        return ofetch.apply(this, arguments).then((r) => {
          try { r.clone().text().then(take).catch(() => {}); } catch (e) {}
          return r;
        });
      };
    }
    if (window.XMLHttpRequest && XMLHttpRequest.prototype) {
      const os = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        this.addEventListener('load', function () { try { take(this.responseText); } catch (e) {} });
        return os.apply(this, arguments);
      };
    }
  } catch (e) {}
})();
"#;

static APP: OnceLock<AppHandle> = OnceLock::new();
static GATE: Mutex<()> = Mutex::new(());
static LAST_OK: Mutex<Option<LastSolve>> = Mutex::new(None);
static LAST_HTML: Mutex<Option<HtmlCache>> = Mutex::new(None);
static DOCK_BOUNDS: Mutex<Option<DockBounds>> = Mutex::new(None);

static USER_CLOSED: AtomicBool = AtomicBool::new(false);
static RELEASING: AtomicBool = AtomicBool::new(false);
static KEEP_ON_IDLE: AtomicBool = AtomicBool::new(false);
static COLLAPSED: AtomicBool = AtomicBool::new(false);
static SESSION_INTRO: AtomicBool = AtomicBool::new(false);
static FOCUSED_ONCE: AtomicBool = AtomicBool::new(false);

struct LastSolve {
    at: Instant,
    session: WebviewCfSession,
}

struct HtmlCache {
    url: String,
    at: Instant,
    session: WebviewCfSession,
}

#[derive(Clone, Copy)]
struct DockBounds {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Clone)]
pub struct WebviewCfSession {
    pub user_agent: String,
    pub cookies: HashMap<String, String>,
    pub html: String,
    /// Host this session (cookies/UA) was solved for. Cached sessions must
    /// never be handed out for a different host — see `solve()`.
    pub host: Option<String>,
}

#[derive(Deserialize)]
struct ReaderProbe {
    state: String,
    count: Option<u32>,
    script: Option<String>,
}

#[derive(Clone, Serialize)]
struct CfWebviewState {
    active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}

pub fn set_app_handle(app: AppHandle) {
    let _ = APP.set(app);
}

pub fn remember(mut session: WebviewCfSession) {
    session.html.clear();
    *LAST_OK.lock() = Some(LastSolve {
        at: Instant::now(),
        session,
    });
}

pub fn forget() {
    *LAST_OK.lock() = None;
    *LAST_HTML.lock() = None;
}

pub fn is_window_open() -> bool {
    APP.get()
        .and_then(|app| app.get_webview_window(WINDOW_LABEL))
        .is_some()
}

pub fn take_user_closed() -> bool {
    USER_CLOSED.swap(false, Ordering::SeqCst)
}

/// Detener / cancelar un ítem en curso: el worker idle no debe destruir la ventana.
pub fn keep_on_next_idle() {
    KEEP_ON_IDLE.store(true, Ordering::SeqCst);
}

pub fn set_dock_bounds(app: &AppHandle, x: f64, y: f64, w: f64, h: f64) {
    if w < 40.0 || h < 40.0 {
        return;
    }
    *DOCK_BOUNDS.lock() = Some(DockBounds { x, y, w, h });
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        apply_dock(app, &w);
    }
}

pub fn set_collapsed(app: &AppHandle, collapsed: bool) {
    COLLAPSED.store(collapsed, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        apply_dock(app, &w);
    }
}

pub fn reapply_dock(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        apply_dock(app, &w);
    }
}

/// Cola vacía de verdad: cerrar el panel. Si el usuario detuvo, se conserva.
pub fn release_if_idle() {
    if KEEP_ON_IDLE.swap(false, Ordering::SeqCst) {
        return;
    }
    destroy_window();
}

/// Cierre explícito del panel / ventana: cancela ítems running y destruye.
pub fn user_closed(app: &AppHandle) {
    USER_CLOSED.store(true, Ordering::SeqCst);
    crate::queue::cancel_all_running(app);
    destroy_window();
}

pub fn on_window_destroyed(app: &AppHandle) {
    reset_session_ui();
    emit_state(app, false, None);
    if RELEASING.swap(false, Ordering::SeqCst) {
        return;
    }
    USER_CLOSED.store(true, Ordering::SeqCst);
    crate::queue::cancel_all_running(app);
}

/// Cookie-only reuse (HTTP retries). Does not return page HTML.
pub fn solve(url: &str, abort: impl Fn() -> bool) -> Option<WebviewCfSession> {
    let _gate = GATE.lock();
    if abort() {
        return None;
    }
    let host = Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()));
    {
        let last = LAST_OK.lock();
        if let Some(prev) = last.as_ref() {
            // Cookies (incl. cf_clearance) from one site must never be handed
            // to a caller resolving Cloudflare for a different site.
            if prev.at.elapsed() < REUSE_TTL
                && prev.session.host == host
                && has_clearance(&prev.session.cookies)
            {
                lua_log::emit_lua_log("Cloudflare: reutilizando cookies de la sesión anterior.");
                return Some(prev.session.clone());
            }
        }
    }
    let session = solve_locked(url, &abort)?;
    remember(session.clone());
    Some(session)
}

/// Always load the URL in the WebView and return rendered HTML (with `var pUrl` injected).
pub fn solve_for_html(url: &str, abort: impl Fn() -> bool) -> Option<WebviewCfSession> {
    let _gate = GATE.lock();
    if abort() {
        return None;
    }
    {
        let cache = LAST_HTML.lock();
        if let Some(prev) = cache.as_ref() {
            if prev.url == url && prev.at.elapsed() < REUSE_TTL && !prev.session.html.is_empty() {
                lua_log::emit_lua_log("Cloudflare: reutilizando HTML del lector.");
                return Some(prev.session.clone());
            }
        }
    }
    let session = solve_locked(url, &abort)?;
    remember(session.clone());
    *LAST_HTML.lock() = Some(HtmlCache {
        url: url.to_string(),
        at: Instant::now(),
        session: session.clone(),
    });
    Some(session)
}

fn has_clearance(cookies: &HashMap<String, String>) -> bool {
    cookies
        .iter()
        .any(|(k, v)| k.eq_ignore_ascii_case("cf_clearance") && !v.trim().is_empty())
}

fn solve_locked(url: &str, abort: &impl Fn() -> bool) -> Option<WebviewCfSession> {
    let app = APP.get().cloned()?;
    let parsed = Url::parse(url).ok()?;
    if abort() {
        return None;
    }

    let first = !SESSION_INTRO.load(Ordering::SeqCst);
    if first {
        lua_log::emit_lua_log("Cloudflare: abriendo el navegador interno…");
    }

    let window = match ensure_window(&app, parsed.clone()) {
        Some(w) => w,
        None => {
            lua_log::emit_lua_log("Cloudflare: no se pudo abrir el navegador interno.");
            return None;
        }
    };

    if first {
        lua_log::emit_lua_log("Cloudflare: si aparece un captcha, complétalo en el panel.");
        lua_log::emit_lua_log("Cloudflare: esperando que el lector cargue las páginas…");
        SESSION_INTRO.store(true, Ordering::SeqCst);
    }

    let hard_until = Instant::now() + VISIBLE_WAIT;

    loop {
        if abort() {
            lua_log::emit_lua_log("Cloudflare: cancelado.");
            return None;
        }
        if app.get_webview_window(WINDOW_LABEL).is_none() {
            if !RELEASING.load(Ordering::SeqCst) {
                USER_CLOSED.store(true, Ordering::SeqCst);
                lua_log::emit_lua_log("Cloudflare: ventana cerrada.");
            }
            return None;
        }

        if let Some(session) = try_collect(&window, &parsed, first) {
            if first {
                lua_log::emit_lua_log("Cloudflare: lector listo.");
            }
            return Some(session);
        }

        if Instant::now() >= hard_until {
            dump_timeout_html(&window);
            lua_log::emit_lua_log("Cloudflare: tiempo agotado esperando el lector.");
            return None;
        }
        thread::sleep(POLL);
    }
}

fn ensure_window(app: &AppHandle, url: Url) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        let _ = w.eval(PAGE_HOOK);
        let _ = w.navigate(url.clone());
        emit_state(app, true, Some(url.as_str()));
        apply_dock(app, &w);
        return Some(w);
    }

    USER_CLOSED.store(false, Ordering::SeqCst);
    FOCUSED_ONCE.store(false, Ordering::SeqCst);

    let builder = window_builder(app, url.clone());
    let builder = match app.get_webview_window("main") {
        Some(main) => builder.parent(&main).unwrap_or_else(|_| window_builder(app, url.clone())),
        None => builder,
    };

    let window = builder
        .build()
        .map_err(|e| {
            lua_log::emit_lua_log(&format!(
                "Cloudflare: no se pudo abrir el navegador interno ({e})"
            ));
            e
        })
        .ok()?;

    emit_state(app, true, Some(url.as_str()));
    apply_dock(app, &window);
    Some(window)
}

fn window_builder(app: &AppHandle, url: Url) -> WebviewWindowBuilder<'_, tauri::Wry, AppHandle> {
    WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(url))
        .title("Navegador interno")
        .inner_size(360.0, 520.0)
        .decorations(false)
        .resizable(false)
        .visible(false)
        .skip_taskbar(true)
        .always_on_top(false)
        .initialization_script(PAGE_HOOK)
}

fn apply_dock(app: &AppHandle, window: &WebviewWindow) {
    if COLLAPSED.load(Ordering::SeqCst) {
        let _ = window.hide();
        return;
    }
    let Some(bounds) = *DOCK_BOUNDS.lock() else {
        let _ = window.hide();
        return;
    };
    if let Some(main) = app.get_webview_window("main") {
        if let (Ok(pos), Ok(scale)) = (main.inner_position(), main.scale_factor()) {
            let x = pos.x + (bounds.x * scale).round() as i32;
            let y = pos.y + (bounds.y * scale).round() as i32;
            let w = (bounds.w * scale).round().max(1.0) as u32;
            let h = (bounds.h * scale).round().max(1.0) as u32;
            let _ = window.set_position(PhysicalPosition::new(x, y));
            let _ = window.set_size(PhysicalSize::new(w, h));
        }
    }
    let _ = window.show();
    if !FOCUSED_ONCE.swap(true, Ordering::SeqCst) {
        let _ = window.set_focus();
    }
}

fn emit_state(app: &AppHandle, active: bool, url: Option<&str>) {
    let payload = CfWebviewState {
        active,
        url: url.map(|u| u.to_string()),
    };
    let _ = app.emit("cf-webview-state", &payload);
    let _ = app.emit_to("main", "cf-webview-state", &payload);
}

fn destroy_window() {
    if let Some(app) = APP.get() {
        if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
            RELEASING.store(true, Ordering::SeqCst);
            let _ = w.close();
        }
        emit_state(app, false, None);
    }
    reset_session_ui();
    forget();
}

fn reset_session_ui() {
    SESSION_INTRO.store(false, Ordering::SeqCst);
    FOCUSED_ONCE.store(false, Ordering::SeqCst);
    COLLAPSED.store(false, Ordering::SeqCst);
    *DOCK_BOUNDS.lock() = None;
}

/// Writes `html` to the app's debug folder, only when logging is enabled.
/// Never dumps unconditionally: this HTML can carry signed/tokenized CDN URLs.
fn dump_html(html: &str, reason: &str) {
    if !crate::settings_keys::bool_setting(crate::settings_keys::LOG_ENABLED, false) {
        return;
    }
    let dir = crate::db::db_path().join("debug");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join(format!("cf-webview-{reason}.html"));
    if std::fs::write(&path, html).is_ok() {
        lua_log::emit_lua_log(&format!(
            "Cloudflare: HTML guardado en {} ({} bytes).",
            path.display(),
            html.len()
        ));
    }
}

fn dump_timeout_html(window: &WebviewWindow) {
    if let Some(html) = webview_html(window) {
        dump_html(&html, "timeout");
    }
}

fn try_collect(window: &WebviewWindow, url: &Url, first: bool) -> Option<WebviewCfSession> {
    let probe = reader_probe(window, url.path())?;
    match probe.state.as_str() {
        "ok" => {}
        _ => return None,
    }
    let script = probe.script.unwrap_or_default();
    if script.is_empty() {
        return None;
    }
    if first {
        if let Some(n) = probe.count {
            lua_log::emit_lua_log(&format!("Cloudflare: {n} páginas en el lector."));
        }
    } else if let Some(n) = probe.count {
        lua_log::emit_lua_log(&format!("Cloudflare: página lista ({n})."));
    } else {
        lua_log::emit_lua_log("Cloudflare: página lista.");
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let (raw_cookies, via_fallback) = match window.cookies_for_url(url.clone()).ok() {
        Some(c) => (c, false),
        None => (window.cookies().unwrap_or_default(), true),
    };
    if via_fallback && first {
        lua_log::emit_lua_log(
            "Cloudflare: cookies_for_url falló; filtrando por dominio antes de usarlas.",
        );
    }
    let map = cookie_map(&raw_cookies, &host);
    let ua = webview_user_agent(window).unwrap_or_default();
    let page = webview_html(window).unwrap_or_default();
    let html = format!("<script>{script}</script>\n{page}");
    dump_html(&html, "leer");
    Some(WebviewCfSession {
        user_agent: ua,
        cookies: map,
        html,
        host: Some(host),
    })
}

fn reader_probe(window: &WebviewWindow, path: &str) -> Option<ReaderProbe> {
    let path_json = serde_json::to_string(path).unwrap_or_else(|_| "\"\"".into());
    let js = r#"(() => {
      const want = __WANT__;
      const ok = (arr) => ({state:'ok', count: arr.length, script: 'var pUrl = ' + JSON.stringify(arr) + ';'});
      const toArr = (v) => {
        const out = [];
        if (!v) return out;
        const list = Array.isArray(v) ? v : [v];
        for (const item of list) {
          if (typeof item === 'string' && item.length > 4) out.push({imgURL: item});
          else if (item && typeof item === 'object') {
            const u = item.imgURL || item.imgUrl || item.url || item.src || '';
            if (u) out.push({imgURL: String(u)});
          }
        }
        return out;
      };
      try {
        if (want && location.href.indexOf(want) === -1) return {state:'wait'};
        const t = (document.title || '').toLowerCase();
        const html = document.documentElement ? document.documentElement.innerHTML : '';
        if (t.includes('just a moment') || t.includes('attention required')) return {state:'cf'};
        if (html.includes('challenge-platform') || html.includes('cf-browser-verification')) return {state:'cf'};

        if (window.__fmdPages && window.__fmdPages.length) return ok(toArr(window.__fmdPages));
        if (window.__fmdJson && /imgURL/.test(window.__fmdJson)) {
          const m = window.__fmdJson.match(/pUrl\s*=\s*(\[[\s\S]*?\])/);
          if (m) {
            try { return ok(toArr(JSON.parse(m[1]))); } catch (e) {}
          }
          const imgs = [];
          window.__fmdJson.replace(/"imgURL"\s*:\s*"([^"]+)"/g, (_, u) => { imgs.push({imgURL: u}); return ''; });
          if (imgs.length) return ok(imgs);
        }

        const names = ['pUrl','pages','images','imgList','pageList','lista','chapterImages','page_array'];
        for (const n of names) {
          const v = window[n];
          if (Array.isArray(v) && v.length) {
            const arr = toArr(v);
            if (arr.length) return ok(arr);
          }
        }

        for (const s of document.scripts) {
          const txt = s.textContent || '';
          if (txt.indexOf('pUrl') === -1 && txt.indexOf('imgURL') === -1) continue;
          const m = txt.match(/(?:var|let|const)\s+pUrl\s*=\s*(\[[\s\S]*?\])/);
          if (m) {
            try { const arr = toArr(JSON.parse(m[1])); if (arr.length) return ok(arr); } catch (e) {}
          }
        }

        const imgs = Array.from(document.querySelectorAll('img, source')).map((i) =>
          i.getAttribute('data-src') || i.getAttribute('data-original') || i.getAttribute('src') || i.getAttribute('srcset') || ''
        ).map((s) => s.split(' ')[0]).filter((s) =>
          s && s.length > 20 && !s.includes('logo') && !s.includes('/assets/') && !s.includes('favicon') && !s.startsWith('data:')
        );
        if (imgs.length > 1) return ok(imgs.map((u) => ({imgURL: u})));

        return {state:'wait'};
      } catch (e) {
        return {state:'wait'};
      }
    })()"#
    .replace("__WANT__", &path_json);
    let raw = eval_json(window, &js, Duration::from_secs(2))?;
    serde_json::from_str(&raw).ok().or_else(|| {
        let unquoted = raw.trim().trim_matches('"').replace("\\\"", "\"");
        serde_json::from_str(&unquoted).ok()
    })
}

fn eval_json(window: &WebviewWindow, js: &str, timeout: Duration) -> Option<String> {
    let (tx, rx) = mpsc::channel();
    window
        .eval_with_callback(js, move |s| {
            let _ = tx.send(s);
        })
        .ok()?;
    rx.recv_timeout(timeout).ok()
}

/// Keeps only cookies scoped to `host` (or the target host as a subdomain of
/// the cookie's domain). Cookies with no `Domain` attribute are host-only and
/// kept as-is — the best signal available, notably from the `window.cookies()`
/// fallback in `try_collect`, which otherwise returns the WebView's whole
/// cookie jar (shared across sites navigated in the same `cf-bypass` window).
fn cookie_map(cookies: &[tauri::webview::Cookie<'static>], host: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for c in cookies {
        let name = c.name().trim();
        if name.is_empty() {
            continue;
        }
        if let Some(domain) = c.domain() {
            let domain = domain.trim_start_matches('.').to_ascii_lowercase();
            let matches = host == domain || host.ends_with(&format!(".{domain}"));
            if !matches {
                continue;
            }
        }
        map.insert(name.to_string(), c.value().to_string());
    }
    map
}

fn webview_html(window: &WebviewWindow) -> Option<String> {
    let raw = eval_json(
        window,
        "document.documentElement.outerHTML",
        Duration::from_secs(5),
    )?;
    if let Ok(s) = serde_json::from_str::<String>(&raw) {
        let s = s.trim().to_string();
        if !s.is_empty() {
            return Some(s);
        }
    }
    if raw.len() > 800 {
        Some(raw)
    } else {
        None
    }
}

fn webview_user_agent(window: &WebviewWindow) -> Option<String> {
    let raw = eval_json(window, "navigator.userAgent", Duration::from_secs(2))?;
    if let Ok(s) = serde_json::from_str::<String>(&raw) {
        let s = s.trim().to_string();
        if !s.is_empty() {
            return Some(s);
        }
    }
    let t = raw.trim().trim_matches('"').trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}
