//! Cloudflare challenge via the app's embedded WebView2 (no FlareSolverr).
//!
//! Create/read the window from a worker thread: on Windows, `WebviewWindowBuilder`
//! and `cookies()` deadlock if called from a synchronous command on the main thread.

use parking_lot::Mutex;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
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
      if (typeof t !== 'string' || t.length < 10) return;
      if (/imgURL|pUrl/.test(t) && t.length > (window.__fmdJson || '').length) window.__fmdJson = t;
      try { walk(JSON.parse(t), 0); } catch (e) {}
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

struct LastSolve {
    at: Instant,
    session: WebviewCfSession,
}

struct HtmlCache {
    url: String,
    at: Instant,
    session: WebviewCfSession,
}

#[derive(Clone)]
pub struct WebviewCfSession {
    pub user_agent: String,
    pub cookies: HashMap<String, String>,
    pub html: String,
}

#[derive(Deserialize)]
struct ReaderProbe {
    state: String,
    count: Option<u32>,
    script: Option<String>,
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

/// Cookie-only reuse (HTTP retries). Does not return page HTML.
pub fn solve(url: &str, abort: impl Fn() -> bool) -> Option<WebviewCfSession> {
    let _gate = GATE.lock();
    if abort() {
        return None;
    }
    {
        let last = LAST_OK.lock();
        if let Some(prev) = last.as_ref() {
            if prev.at.elapsed() < REUSE_TTL && has_clearance(&prev.session.cookies) {
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

    lua_log::emit_lua_log("Cloudflare: abriendo el navegador interno…");

    let window = match ensure_window(&app, parsed.clone()) {
        Some(w) => w,
        None => {
            lua_log::emit_lua_log("Cloudflare: no se pudo abrir el navegador interno.");
            return None;
        }
    };

    let _ = window.set_skip_taskbar(false);
    let _ = window.set_always_on_top(true);
    let _ = window.show();
    let _ = window.set_focus();
    lua_log::emit_lua_log("Cloudflare: si aparece un captcha, complétalo en la ventana.");
    lua_log::emit_lua_log("Cloudflare: esperando que el lector cargue las páginas…");

    let hard_until = Instant::now() + VISIBLE_WAIT;

    loop {
        if abort() {
            lua_log::emit_lua_log("Cloudflare: cancelado.");
            hide_window(&window);
            return None;
        }
        if app.get_webview_window(WINDOW_LABEL).is_none() {
            lua_log::emit_lua_log("Cloudflare: ventana cerrada.");
            return None;
        }

        if let Some(session) = try_collect(&window, &parsed) {
            lua_log::emit_lua_log("Cloudflare: lector listo.");
            hide_window(&window);
            return Some(session);
        }

        if Instant::now() >= hard_until {
            dump_timeout_html(&window);
            lua_log::emit_lua_log("Cloudflare: tiempo agotado esperando el lector.");
            hide_window(&window);
            return None;
        }
        thread::sleep(POLL);
    }
}

fn ensure_window(app: &AppHandle, url: Url) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        let _ = w.eval(PAGE_HOOK);
        let _ = w.navigate(url);
        Some(w)
    } else {
        WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(url))
            .title("Completa Cloudflare")
            .inner_size(520.0, 720.0)
            .center()
            .visible(true)
            .skip_taskbar(false)
            .always_on_top(true)
            .initialization_script(PAGE_HOOK)
            .build()
            .map_err(|e| {
                lua_log::emit_lua_log(&format!(
                    "Cloudflare: no se pudo abrir el navegador interno ({e})"
                ));
                e
            })
            .ok()
    }
}

fn hide_window(window: &WebviewWindow) {
    let _ = window.set_always_on_top(false);
    let _ = window.set_skip_taskbar(true);
    let _ = window.hide();
}

fn dump_timeout_html(window: &WebviewWindow) {
    if let Some(html) = webview_html(window) {
        let dump = std::env::temp_dir().join("fmd3-kumanga-leer.html");
        let _ = std::fs::write(&dump, &html);
        lua_log::emit_lua_log(&format!(
            "Cloudflare: HTML del lector guardado ({} bytes).",
            html.len()
        ));
    }
}

fn try_collect(window: &WebviewWindow, url: &Url) -> Option<WebviewCfSession> {
    let probe = reader_probe(window, url.path())?;
    match probe.state.as_str() {
        "ok" => {}
        _ => return None,
    }
    let script = probe.script.unwrap_or_default();
    if script.is_empty() {
        return None;
    }
    if let Some(n) = probe.count {
        lua_log::emit_lua_log(&format!("Cloudflare: {n} páginas en el lector."));
    }
    let cookies = window
        .cookies_for_url(url.clone())
        .ok()
        .or_else(|| window.cookies().ok())
        .unwrap_or_default();
    let map = cookie_map(&cookies);
    let ua = webview_user_agent(window).unwrap_or_default();
    let page = webview_html(window).unwrap_or_default();
    let html = format!("<script>{script}</script>\n{page}");
    let dump = std::env::temp_dir().join("fmd3-kumanga-leer.html");
    let _ = std::fs::write(&dump, &html);
    Some(WebviewCfSession {
        user_agent: ua,
        cookies: map,
        html,
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

fn cookie_map(cookies: &[tauri::webview::Cookie<'static>]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for c in cookies {
        let name = c.name().trim();
        if name.is_empty() {
            continue;
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
