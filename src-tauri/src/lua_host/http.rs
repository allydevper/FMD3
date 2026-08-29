//! HTTP userdata compatible with FMD2 modules + WebsiteBypass Lua scripts.

use mlua::{UserData, UserDataMethods, Value};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

// Match FMD2 UserAgentDefault (httpsendthread.pas)
const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
const CF_SESSION_KEY: &str = "http_cf_session";
const MAX_REDIRECTS: u32 = 5;

/// The inner state is built lazily: constructing it opens several SQLite
/// connections and a `reqwest` client (own tokio thread + TLS init). The
/// registry scan creates one `HttpClient` per module file and never issues a
/// request, so paying that up front cost ~600 times was pure waste.
#[derive(Clone)]
pub struct HttpClient {
    cell: Arc<once_cell::sync::OnceCell<Mutex<HttpInner>>>,
}

struct HttpInner {
    client: reqwest::blocking::Client,
    /// Response body as raw bytes (images must not go through UTF-8 text()).
    document: Vec<u8>,
    /// Outgoing body written via Document.WriteString (FMD2).
    pending_body: String,
    /// Request headers (set by modules / bypass).
    headers: HashMap<String, String>,
    /// Last response headers (Server, Content-Type, …).
    response_headers: HashMap<String, String>,
    cookies: HashMap<String, String>,
    result_code: u16,
    user_agent: String,
    mime_type: String,
    follow_redirection: bool,
    retry_count: i64,
    terminated: bool,
    enabled_cookies: bool,
    /// >0 while inside WebsiteBypass (avoid recursive antibot).
    bypass_depth: u32,
    /// Set when the configured client (proxy/timeout) could not be built. The
    /// client field then holds a degraded fallback, so requests must refuse to
    /// run rather than silently bypass the user's proxy.
    init_err: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CfSession {
    user_agent: String,
    cookies: HashMap<String, String>,
}

#[derive(Clone)]
pub struct DocumentHandle {
    pub client: HttpClient,
}

#[derive(Clone)]
struct HeadersHandle {
    client: HttpClient,
}

#[derive(Clone)]
struct HeaderValuesHandle {
    client: HttpClient,
}

#[derive(Clone)]
struct CookiesHandle {
    client: HttpClient,
}

#[derive(Clone)]
struct CookieValuesHandle {
    client: HttpClient,
}

fn build_client(ua: &str) -> Result<reqwest::blocking::Client, String> {
    // FMD2/Synapse is HTTP/1.1; HTTP/2 ALPN is a common CF fingerprint tell.
    // Redirects: manual (Referer + relative Location), like httpsendthread.pas.
    let mut b = reqwest::blocking::Client::builder()
        .user_agent(ua)
        .cookie_store(true)
        .http1_only()
        .redirect(reqwest::redirect::Policy::none());
    let timeout_secs = crate::settings_keys::http_timeout_secs();
    if timeout_secs > 0 {
        b = b.timeout(std::time::Duration::from_secs(timeout_secs));
    }
    if let Ok(Some(proxy)) = crate::db::settings_get_direct(crate::settings_keys::HTTP_PROXY) {
        let proxy = proxy.trim().to_string();
        if !proxy.is_empty() {
            let p = reqwest::Proxy::all(&proxy).map_err(|e| e.to_string())?;
            b = b.proxy(p);
        }
    }
    b.build().map_err(|e| e.to_string())
}

/// Infallible variant of `build_client`, needed because the client is now built
/// lazily from a context that cannot return an error. On failure (bad proxy URL,
/// TLS backend) it returns a degraded fallback *plus* the error, which the
/// caller stores in `init_err` so requests fail loudly instead of quietly going
/// direct when a proxy was configured.
fn build_client_or_default(ua: &str) -> (reqwest::blocking::Client, Option<String>) {
    match build_client(ua) {
        Ok(c) => (c, None),
        Err(e) => {
            eprintln!("http: no se pudo construir el cliente: {e}");
            let fallback = reqwest::blocking::Client::builder()
                .user_agent(ua)
                .cookie_store(true)
                .http1_only()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap_or_else(|_| reqwest::blocking::Client::new());
            (fallback, Some(e))
        }
    }
}

fn configured_user_agent(session_ua: &str) -> String {
    if let Ok(Some(ua)) = crate::db::settings_get_direct(crate::settings_keys::HTTP_USER_AGENT) {
        let ua = ua.trim();
        if !ua.is_empty() {
            return ua.to_string();
        }
    }
    if session_ua.is_empty() {
        DEFAULT_UA.to_string()
    } else {
        session_ua.to_string()
    }
}

/// `cf_clearance` is bound to the WebView UA that obtained it. Prefer that over
/// the settings UA, or Cloudflare rejects the cookie immediately.
fn ua_for_client(saved: &CfSession) -> String {
    let has_cf = saved
        .cookies
        .keys()
        .any(|k| k.eq_ignore_ascii_case("cf_clearance"));
    if has_cf && !saved.user_agent.trim().is_empty() {
        saved.user_agent.clone()
    } else {
        configured_user_agent(&saved.user_agent)
    }
}

fn resolve_redirect(base: &str, location: &str) -> String {
    let loc = location.trim();
    if loc.is_empty() {
        return base.to_string();
    }
    if loc.starts_with("http://") || loc.starts_with("https://") {
        return loc.to_string();
    }
    match url::Url::parse(base) {
        Ok(base_url) => base_url
            .join(loc)
            .map(|u| u.to_string())
            .unwrap_or_else(|_| loc.to_string()),
        Err(_) => loc.to_string(),
    }
}

fn merge_set_cookie(cookies: &mut HashMap<String, String>, headers: &reqwest::header::HeaderMap) {
    for sc in headers.get_all(reqwest::header::SET_COOKIE) {
        let Ok(s) = sc.to_str() else { continue };
        let Some(nv) = s.split(';').next() else { continue };
        let Some((n, v)) = nv.split_once('=') else { continue };
        let n = n.trim();
        if !n.is_empty() {
            cookies.insert(n.to_string(), v.trim().to_string());
        }
    }
}

fn load_cf_session() -> CfSession {
    crate::db::settings_get_direct(CF_SESSION_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_cf_session(ua: &str, cookies: &HashMap<String, String>) {
    let session = CfSession {
        user_agent: ua.to_string(),
        cookies: cookies.clone(),
    };
    if let Ok(json) = serde_json::to_string(&session) {
        let _ = crate::db::settings_set_direct(CF_SESSION_KEY, &json);
    }
}

fn default_browser_headers() -> HashMap<String, String> {
    // Match THTTPSendThread.Reset / ResetBasic (FMD2)
    let mut h = HashMap::new();
    h.insert("DNT".into(), "1".into());
    h.insert("Upgrade-Insecure-Requests".into(), "1".into());
    h.insert(
        "Accept".into(),
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8".into(),
    );
    h.insert("Accept-Language".into(), "en-US,en;q=0.5".into());
    h.insert("Accept-Charset".into(), "utf-8".into());
    h.insert("Accept-Encoding".into(), "gzip, deflate, br".into());
    h
}

fn looks_like_cloudflare(status: u16, server: &str, body: &str) -> bool {
    let server = server.to_lowercase();
    let cf_server = server.contains("cloudflare") || server.contains("ddos-guard");
    if matches!(status, 403 | 429 | 503) && (cf_server || body.is_empty()) {
        return true;
    }
    body.contains("challenge-platform")
        || body.contains("Just a moment")
        || body.contains("cf-browser-verification")
        || body.contains("__cf_chl")
        || body.contains("cdn-cgi/challenge")
}

fn header_get_ci(map: &HashMap<String, String>, key: &str) -> Option<String> {
    map.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.clone())
}

impl HttpInner {
    /// Reads settings from SQLite and builds the reqwest client. Only called on
    /// first actual use of an `HttpClient`.
    fn build() -> Self {
        let saved = load_cf_session();
        let ua = ua_for_client(&saved);
        let (client, init_err) = build_client_or_default(&ua);
        let mut headers = default_browser_headers();
        let cookies = saved.cookies;
        if !cookies.is_empty() {
            let cookie_hdr = cookies
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join("; ");
            headers.insert("Cookie".into(), cookie_hdr);
        }
        HttpInner {
            client,
            document: Vec::new(),
            pending_body: String::new(),
            headers,
            response_headers: HashMap::new(),
            cookies,
            result_code: 0,
            user_agent: ua,
            mime_type: String::new(),
            follow_redirection: true,
            retry_count: 0,
            terminated: false,
            enabled_cookies: true,
            bypass_depth: 0,
            init_err,
        }
    }
}

impl HttpClient {
    pub fn new() -> mlua::Result<Self> {
        Ok(Self {
            cell: Arc::new(once_cell::sync::OnceCell::new()),
        })
    }

    /// Materializes the inner state on first access.
    fn inner(&self) -> &Mutex<HttpInner> {
        self.cell.get_or_init(|| Mutex::new(HttpInner::build()))
    }

    /// UTF-8 lossy view of Document (HTML/XPath).
    pub fn document(&self) -> String {
        String::from_utf8_lossy(&self.inner().lock().document).into_owned()
    }

    /// Raw Document bytes (image download / save).
    pub fn document_bytes(&self) -> Vec<u8> {
        self.inner().lock().document.clone()
    }

    pub fn set_document_bytes(&self, bytes: Vec<u8>) {
        self.inner().lock().document = bytes;
    }

    fn adopt_webview_document(&self, html: &str) {
        let mut inner = self.inner().lock();
        inner.document = html.as_bytes().to_vec();
        inner.result_code = 200;
        inner
            .response_headers
            .insert("Server".into(), "webview".into());
    }

    pub fn set_terminated(&self, terminated: bool) {
        self.inner().lock().terminated = terminated;
    }

    /// Clone cookies/headers/UA into a new client with its own document buffer (parallel GETs).
    pub fn fork(&self) -> Result<Self, String> {
        let inner = self.inner().lock();
        // Same fallback as `HttpInner::build`, so a broken proxy config fails at
        // the request for forked clients too, not at fork time for some callers
        // and at request time for others.
        let (client, init_err) = build_client_or_default(&inner.user_agent);
        let forked = HttpInner {
            client,
            document: Vec::new(),
            pending_body: String::new(),
            headers: inner.headers.clone(),
            response_headers: HashMap::new(),
            cookies: inner.cookies.clone(),
            result_code: 0,
            user_agent: inner.user_agent.clone(),
            mime_type: String::new(),
            follow_redirection: inner.follow_redirection,
            retry_count: inner.retry_count,
            terminated: inner.terminated,
            enabled_cookies: inner.enabled_cookies,
            bypass_depth: 0,
            // Only the fork's own build result: it re-reads the proxy/timeout
            // settings, so it is fresher than the parent's. Carrying the
            // parent's error over would reject requests on a working client.
            init_err,
        };
        let cell = once_cell::sync::OnceCell::new();
        let _ = cell.set(Mutex::new(forked));
        Ok(Self {
            cell: Arc::new(cell),
        })
    }

    pub fn headers_map(&self) -> HashMap<String, String> {
        self.inner().lock().headers.clone()
    }

    pub fn set_header(&self, key: &str, value: &str) {
        self.inner()
            .lock()
            .headers
            .insert(key.to_string(), value.to_string());
    }

    /// FMD2 THTTPSendThread.AcceptImage
    pub fn accept_image(&self) {
        self.inner()
            .lock()
            .headers
            .insert("Accept".into(), "image/webp,*/*".into());
    }

    pub fn reset_http(&self) {
        self.reset();
    }

    pub fn get_public(&self, url: &str) -> bool {
        self.get(url)
    }

    /// Load `url` in the embedded WebView, wait for the challenge, copy HTML into Document.
    pub fn capture_in_browser(&self, url: &str) -> bool {
        if !crate::settings_keys::cf_internal_browser() {
            super::lua_log::emit_lua_log(
                "Cloudflare: navegador interno desactivado (actívalo en Red).",
            );
            return false;
        }
        super::lua_log::emit_lua_log(&format!("Cloudflare: abriendo navegador para {url}"));
        let http = self.clone();
        let Some(session) = super::cf_webview::solve_for_html(url, move || http.is_terminated()) else {
            return false;
        };
        self.apply_webview_session(&session.user_agent, &session.cookies);
        self.persist_session();
        if session.html.trim().is_empty() {
            super::lua_log::emit_lua_log("Cloudflare: el navegador no devolvió HTML.");
            return false;
        }
        self.adopt_webview_document(&session.html);
        super::cf_webview::remember(session);
        true
    }

    pub fn begin_bypass(&self) {
        self.inner().lock().bypass_depth += 1;
    }

    pub fn end_bypass(&self) {
        let mut inner = self.inner().lock();
        if inner.bypass_depth > 0 {
            inner.bypass_depth -= 1;
        }
    }

    pub fn persist_session(&self) {
        let inner = self.inner().lock();
        save_cf_session(&inner.user_agent, &inner.cookies);
    }

    pub fn is_terminated(&self) -> bool {
        self.inner().lock().terminated
    }

    /// Merge cookies + UA from the embedded WebView (cf_clearance must match that UA).
    pub fn apply_webview_session(&self, ua: &str, cookies: &HashMap<String, String>) {
        let mut inner = self.inner().lock();
        let ua = ua.trim();
        if !ua.is_empty() && ua != inner.user_agent {
            inner.user_agent = ua.to_string();
            Self::rebuild_client_locked(&mut inner);
        }
        if !ua.is_empty() {
            inner.headers.insert("User-Agent".into(), ua.to_string());
        }
        for (k, v) in cookies {
            if !k.is_empty() {
                inner.cookies.insert(k.clone(), v.clone());
            }
        }
        Self::sync_cookie_header(&mut inner);
    }

    fn response_looks_like_cloudflare(&self) -> bool {
        let inner = self.inner().lock();
        let server = header_get_ci(&inner.response_headers, "Server").unwrap_or_default();
        let lossy = String::from_utf8_lossy(&inner.document);
        let preview: String = lossy.chars().take(8000).collect();
        looks_like_cloudflare(inner.result_code, &server, &preview)
    }

    fn rebuild_client_locked(inner: &mut HttpInner) {
        let (client, err) = build_client_or_default(&inner.user_agent);
        inner.client = client;
        inner.init_err = err;
    }

    fn sync_cookie_header(inner: &mut HttpInner) {
        if !inner.enabled_cookies {
            inner.headers.remove("Cookie");
            return;
        }
        if inner.cookies.is_empty() {
            return;
        }
        let cookie_hdr = inner
            .cookies
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("; ");
        inner.headers.insert("Cookie".into(), cookie_hdr);
    }

    fn cookie_header(inner: &HttpInner) -> Option<String> {
        if !inner.enabled_cookies {
            return None;
        }
        if let Some(c) = header_get_ci(&inner.headers, "Cookie") {
            if !c.is_empty() {
                return Some(c);
            }
        }
        if inner.cookies.is_empty() {
            return None;
        }
        Some(
            inner
                .cookies
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join("; "),
        )
    }

    fn apply_response(
        inner: &mut HttpInner,
        status: u16,
        headers: HashMap<String, String>,
        body: Vec<u8>,
        raw_headers: &reqwest::header::HeaderMap,
    ) {
        inner.result_code = status;
        inner.response_headers = headers;
        inner.document = body;
        inner.pending_body.clear();
        if inner.enabled_cookies {
            merge_set_cookie(&mut inner.cookies, raw_headers);
            Self::sync_cookie_header(inner);
        }
    }

    fn send_raw(&self, method: &str, url: &str, body: Option<&str>) -> bool {
        let (mut headers, mime, follow, max_retries) = {
            let inner = self.inner().lock();
            if inner.terminated {
                return false;
            }
            // The configured client could not be built (e.g. invalid proxy).
            // Refuse the request: going out with the fallback client would
            // bypass a proxy the user explicitly set.
            if let Some(err) = &inner.init_err {
                eprintln!("http: petición cancelada, cliente mal configurado: {err}");
                return false;
            }
            let retries = if inner.retry_count > 0 {
                inner.retry_count as u32
            } else {
                crate::settings_keys::http_retries() as u32
            };
            (
                inner.headers.clone(),
                inner.mime_type.clone(),
                inner.follow_redirection,
                retries,
            )
        };

        let client = self.inner().lock().client.clone();
        let mut method_u = method.to_ascii_uppercase();
        let mut current_url = url.to_string();
        let mut body_owned = body.map(|s| s.to_string());
        let mut redirects = 0u32;
        let mut attempt = 0u32;

        loop {
            let cookie = {
                let inner = self.inner().lock();
                Self::cookie_header(&inner)
            };

            let mut req = match method_u.as_str() {
                "POST" => client.post(&current_url),
                "PUT" => client.put(&current_url),
                "HEAD" => client.head(&current_url),
                _ => client.get(&current_url),
            };

            for (k, v) in &headers {
                if k.eq_ignore_ascii_case("Cookie") {
                    continue;
                }
                req = req.header(k.as_str(), v.as_str());
            }
            if let Some(c) = cookie {
                req = req.header("Cookie", c);
            }

            if matches!(method_u.as_str(), "POST" | "PUT") {
                let b = body_owned.as_deref().unwrap_or("");
                if !mime.is_empty() {
                    req = req.header("Content-Type", &mime);
                } else if !b.is_empty() {
                    req = req.header("Content-Type", "application/x-www-form-urlencoded");
                }
                req = req.body(b.to_string());
            }

            let resp = match req.send() {
                Ok(r) => r,
                Err(_e) => {
                    if attempt < max_retries {
                        attempt += 1;
                        std::thread::sleep(std::time::Duration::from_millis(
                            200 * u64::from(attempt),
                        ));
                        continue;
                    }
                    let mut inner = self.inner().lock();
                    inner.result_code = 0;
                    inner.document.clear();
                    inner.response_headers.clear();
                    return false;
                }
            };

            let status = resp.status().as_u16();
            let raw_headers = resp.headers().clone();
            let mut rh = HashMap::new();
            for (k, v) in raw_headers.iter() {
                // Keep first value for lookup APIs; Set-Cookie handled separately
                rh.entry(k.as_str().to_string())
                    .or_insert_with(|| v.to_str().unwrap_or_default().to_string());
            }

            let is_redirect = matches!(status, 301 | 302 | 303 | 307);
            if follow && is_redirect && redirects < MAX_REDIRECTS {
                let loc = raw_headers
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                if loc.is_empty() {
                    let bytes = resp.bytes().map(|b| b.to_vec()).unwrap_or_default();
                    let mut inner = self.inner().lock();
                    Self::apply_response(&mut inner, status, rh, bytes, &raw_headers);
                    return status > 0;
                }
                // Merge cookies from redirect response before following
                {
                    let mut inner = self.inner().lock();
                    if inner.enabled_cookies {
                        merge_set_cookie(&mut inner.cookies, &raw_headers);
                        Self::sync_cookie_header(&mut inner);
                    }
                }
                let next = resolve_redirect(&current_url, &loc);
                // FMD2: add Referer = previous URL if missing
                headers.insert("Referer".into(), current_url.clone());
                current_url = next;
                method_u = "GET".into();
                body_owned = None;
                redirects += 1;
                let _ = resp; // drop body unread
                continue;
            }

            // Retry on transient HTTP errors
            if matches!(status, 408 | 429 | 500 | 502 | 503 | 504) && attempt < max_retries {
                attempt += 1;
                let _ = resp;
                std::thread::sleep(std::time::Duration::from_millis(200 * u64::from(attempt)));
                continue;
            }

            let bytes = resp.bytes().map(|b| b.to_vec()).unwrap_or_default();
            let mut inner = self.inner().lock();
            Self::apply_response(&mut inner, status, rh, bytes, &raw_headers);
            return status > 0;
        }
    }

    /// Low-level request used by WebsiteBypass (no antibot recursion).
    pub fn request_nobypass(&self, method: &str, url: &str) -> bool {
        let body = {
            let mut inner = self.inner().lock();
            let b = inner.pending_body.clone();
            inner.pending_body.clear();
            b
        };
        let body_ref = if body.is_empty() {
            None
        } else {
            Some(body.as_str())
        };
        self.send_raw(method, url, body_ref)
    }

    fn after_request(&self, method: &str, url: &str) {
        let depth = self.inner().lock().bypass_depth;
        if depth > 0 {
            return;
        }
        if !self.response_looks_like_cloudflare() {
            return;
        }

        super::lua_log::emit_lua_log(&format!("Cloudflare: bloqueo en {url}"));

        let modern_challenge = {
            let inner = self.inner().lock();
            let body = String::from_utf8_lossy(&inner.document);
            body.contains("Just a moment") || body.contains("challenge-platform")
        };
        // IUAM Lua cannot solve Turnstile; skipping it avoids 3s of failed retries
        // and HTTP.Reset() wiping a usable Referer before the WebView runs.
        if !modern_challenge {
            if super::website_bypass_host::try_bypass(self, method, url) {
                self.persist_session();
                if !self.response_looks_like_cloudflare() {
                    return;
                }
            }
        }

        if !crate::settings_keys::cf_internal_browser() {
            super::lua_log::emit_lua_log(
                "Cloudflare: navegador interno desactivado (WARP/VPN + reintento, o actívalo en Red).",
            );
            return;
        }

        let http = self.clone();
        let Some(mut session) = super::cf_webview::solve(url, {
            let http = http.clone();
            move || http.is_terminated()
        }) else {
            return;
        };
        self.apply_webview_session(&session.user_agent, &session.cookies);
        self.persist_session();
        if session.html.trim().is_empty() {
            self.begin_bypass();
            let _ = self.request_nobypass(method, url);
            self.end_bypass();
            if self.response_looks_like_cloudflare() {
                super::cf_webview::forget();
                let Some(again) = super::cf_webview::solve(url, {
                    let http = http.clone();
                    move || http.is_terminated()
                }) else {
                    return;
                };
                session = again;
                self.apply_webview_session(&session.user_agent, &session.cookies);
                self.persist_session();
            }
        }
        if !session.html.trim().is_empty() {
            self.adopt_webview_document(&session.html);
        } else if self.response_looks_like_cloudflare() {
            super::cf_webview::forget();
            super::lua_log::emit_lua_log(
                "Cloudflare: no se pudo leer la página ni siquiera en el navegador interno.",
            );
            return;
        }
        super::cf_webview::remember(session);
    }

    fn get(&self, url: &str) -> bool {
        let ok = self.request_nobypass("GET", url);
        self.after_request("GET", url);
        let inner = self.inner().lock();
        ok || !inner.document.is_empty()
    }

    fn post(&self, url: &str, body: Option<&str>) -> bool {
        if let Some(b) = body {
            self.inner().lock().pending_body = b.to_string();
        }
        let ok = self.request_nobypass("POST", url);
        self.after_request("POST", url);
        let inner = self.inner().lock();
        ok || !inner.document.is_empty()
    }

    fn reset(&self) {
        let mut inner = self.inner().lock();
        inner.document.clear();
        inner.pending_body.clear();
        let cookie_hdr = header_get_ci(&inner.headers, "Cookie");
        inner.headers = default_browser_headers();
        if let Some(c) = cookie_hdr {
            inner.headers.insert("Cookie".into(), c);
        }
        inner.response_headers.clear();
        inner.result_code = 0;
        inner.mime_type.clear();
    }

    fn clear_cookies(&self) {
        let mut inner = self.inner().lock();
        inner.cookies.clear();
        inner.headers.remove("Cookie");
        // rebuild client to drop jar
        Self::rebuild_client_locked(&mut inner);
    }
}

impl UserData for DocumentHandle {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(mlua::MetaMethod::Index, |lua, this, key: String| {
            match key.as_str() {
                "ToString" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, ()| Ok(this.client.document()))?;
                    Ok(Value::Function(f))
                }
                "WriteString" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, s: String| {
                        this.client.inner().lock().pending_body.push_str(&s);
                        Ok(())
                    })?;
                    Ok(Value::Function(f))
                }
                _ => Ok(Value::Nil),
            }
        });
        methods.add_meta_method(mlua::MetaMethod::ToString, |_, this, ()| {
            Ok(this.client.document())
        });
    }
}

impl UserData for HeaderValuesHandle {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(mlua::MetaMethod::Index, |lua, this, key: String| {
            let inner = this.client.inner().lock();
            // Response first (Server/Content-Type), then request headers
            let v = header_get_ci(&inner.response_headers, &key)
                .or_else(|| header_get_ci(&inner.headers, &key))
                .unwrap_or_default();
            Ok(Value::String(lua.create_string(&v)?))
        });
        methods.add_meta_method_mut(
            mlua::MetaMethod::NewIndex,
            |_, this, (key, value): (String, Value)| {
                let s = match value {
                    Value::String(s) => s.to_string_lossy().trim().to_string(),
                    Value::Integer(i) => i.to_string(),
                    Value::Number(n) => n.to_string(),
                    Value::Boolean(b) => b.to_string(),
                    _ => String::new(),
                };
                this.client.inner().lock().headers.insert(key, s);
                Ok(())
            },
        );
    }
}

impl UserData for HeadersHandle {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(mlua::MetaMethod::Index, |lua, this, key: String| {
            if key == "Values" {
                Ok(Value::UserData(lua.create_userdata(HeaderValuesHandle {
                    client: this.client.clone(),
                })?))
            } else {
                Ok(Value::Nil)
            }
        });
    }
}

impl UserData for CookieValuesHandle {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(mlua::MetaMethod::Index, |lua, this, key: String| {
            let v = this
                .client
                .inner()
                .lock()
                .cookies
                .get(&key)
                .cloned()
                .unwrap_or_default();
            Ok(Value::String(lua.create_string(&v)?))
        });
        methods.add_meta_method_mut(
            mlua::MetaMethod::NewIndex,
            |_, this, (key, value): (String, Value)| {
                let s = match value {
                    Value::String(s) => s.to_string_lossy(),
                    _ => String::new(),
                };
                let mut inner = this.client.inner().lock();
                inner.cookies.insert(key, s);
                HttpClient::sync_cookie_header(&mut inner);
                Ok(())
            },
        );
    }
}

impl UserData for CookiesHandle {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(mlua::MetaMethod::Index, |lua, this, key: String| {
            if key == "Values" {
                Ok(Value::UserData(lua.create_userdata(CookieValuesHandle {
                    client: this.client.clone(),
                })?))
            } else {
                Ok(Value::Nil)
            }
        });
    }
}

impl UserData for HttpClient {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(mlua::MetaMethod::Index, |lua, this, key: String| {
            match key.as_str() {
                "Document" => Ok(Value::UserData(lua.create_userdata(DocumentHandle {
                    client: this.clone(),
                })?)),
                "Headers" => Ok(Value::UserData(lua.create_userdata(HeadersHandle {
                    client: this.clone(),
                })?)),
                "Cookies" => Ok(Value::UserData(lua.create_userdata(CookiesHandle {
                    client: this.clone(),
                })?)),
                "ResultCode" => Ok(Value::Integer(this.inner().lock().result_code as i64)),
                "UserAgent" => {
                    Ok(Value::String(lua.create_string(&this.inner().lock().user_agent)?))
                }
                "MimeType" => {
                    Ok(Value::String(lua.create_string(&this.inner().lock().mime_type)?))
                }
                "FollowRedirection" => {
                    Ok(Value::Boolean(this.inner().lock().follow_redirection))
                }
                "RetryCount" => Ok(Value::Integer(this.inner().lock().retry_count)),
                "Terminated" => Ok(Value::Boolean(this.inner().lock().terminated)),
                "EnabledCookies" => Ok(Value::Boolean(this.inner().lock().enabled_cookies)),
                "GET" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, url: String| Ok(this.get(&url)))?;
                    Ok(Value::Function(f))
                }
                "CaptureInBrowser" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, url: String| Ok(this.capture_in_browser(&url)))?;
                    Ok(Value::Function(f))
                }
                "POST" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, args: mlua::Variadic<Value>| {
                        let url = match args.get(0) {
                            Some(Value::String(s)) => s.to_string_lossy(),
                            _ => return Ok(false),
                        };
                        let body = match args.get(1) {
                            Some(Value::String(s)) => Some(s.to_string_lossy()),
                            Some(Value::Nil) | None => None,
                            Some(other) => Some(match other {
                                Value::Integer(i) => i.to_string(),
                                Value::Number(n) => n.to_string(),
                                Value::Boolean(b) => b.to_string(),
                                _ => String::new(),
                            }),
                        };
                        Ok(this.post(&url, body.as_deref()))
                    })?;
                    Ok(Value::Function(f))
                }
                "Request" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, (method, url): (String, String)| {
                        // Used heavily by WebsiteBypass — no recursive antibot
                        Ok(this.request_nobypass(&method, &url))
                    })?;
                    Ok(Value::Function(f))
                }
                "Reset" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, ()| {
                        this.reset();
                        Ok(())
                    })?;
                    Ok(Value::Function(f))
                }
                "AcceptImage" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, ()| {
                        this.accept_image();
                        Ok(())
                    })?;
                    Ok(Value::Function(f))
                }
                "ClearCookiesStorage" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, ()| {
                        this.clear_cookies();
                        Ok(())
                    })?;
                    Ok(Value::Function(f))
                }
                _ => Ok(Value::Nil),
            }
        });

        methods.add_meta_method_mut(
            mlua::MetaMethod::NewIndex,
            |_, this, (key, value): (String, Value)| {
                let mut inner = this.inner().lock();
                match key.as_str() {
                    "UserAgent" => {
                        if let Value::String(s) = value {
                            let ua = s.to_string_lossy();
                            if ua != inner.user_agent {
                                inner.user_agent = ua;
                                HttpClient::rebuild_client_locked(&mut inner);
                            }
                        }
                    }
                    "MimeType" => {
                        if let Value::String(s) = value {
                            inner.mime_type = s.to_string_lossy();
                        }
                    }
                    "FollowRedirection" => {
                        if let Value::Boolean(b) = value {
                            inner.follow_redirection = b;
                        }
                    }
                    "RetryCount" => {
                        if let Value::Integer(i) = value {
                            inner.retry_count = i;
                        }
                    }
                    "Terminated" => {
                        if let Value::Boolean(b) = value {
                            inner.terminated = b;
                        }
                    }
                    "EnabledCookies" => {
                        if let Value::Boolean(b) = value {
                            inner.enabled_cookies = b;
                            HttpClient::sync_cookie_header(&mut inner);
                        }
                    }
                    _ => {}
                }
                Ok(())
            },
        );
    }
}
