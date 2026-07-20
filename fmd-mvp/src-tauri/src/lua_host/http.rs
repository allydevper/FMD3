use mlua::{UserData, UserDataMethods, Value};
use parking_lot::Mutex;
use std::sync::Arc;

#[derive(Clone)]
pub struct HttpClient {
    inner: Arc<Mutex<HttpInner>>,
}

struct HttpInner {
    client: reqwest::blocking::Client,
    document: String,
}

impl HttpClient {
    pub fn new() -> mlua::Result<Self> {
        let client = reqwest::blocking::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) FMD-MVP/0.1")
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .map_err(mlua::Error::external)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(HttpInner {
                client,
                document: String::new(),
            })),
        })
    }

    pub fn document(&self) -> String {
        self.inner.lock().document.clone()
    }

    fn get(&self, url: &str) -> bool {
        let mut inner = self.inner.lock();
        match inner.client.get(url).send() {
            Ok(resp) => {
                let ok = resp.status().is_success() || resp.status().as_u16() == 304;
                inner.document = resp.text().unwrap_or_default();
                ok || !inner.document.is_empty()
            }
            Err(_) => {
                inner.document.clear();
                false
            }
        }
    }
}

impl UserData for HttpClient {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        // FMD modules call HTTP.GET(url) with dot syntax (no implicit self).
        methods.add_meta_method(mlua::MetaMethod::Index, |lua, this, key: String| {
            match key.as_str() {
                "Document" => {
                    let doc = this.document();
                    Ok(Value::String(lua.create_string(&doc)?))
                }
                "GET" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, url: String| Ok(this.get(&url)))?;
                    Ok(Value::Function(f))
                }
                "POST" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, url: String| {
                        let mut inner = this.inner.lock();
                        match inner.client.post(&url).send() {
                            Ok(resp) => {
                                let ok = resp.status().is_success();
                                inner.document = resp.text().unwrap_or_default();
                                Ok(ok)
                            }
                            Err(_) => {
                                inner.document.clear();
                                Ok(false)
                            }
                        }
                    })?;
                    Ok(Value::Function(f))
                }
                _ => Ok(Value::Nil),
            }
        });
    }
}
