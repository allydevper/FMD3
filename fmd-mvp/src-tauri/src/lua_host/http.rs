use mlua::{UserData, UserDataMethods, Value};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone)]
pub struct HttpClient {
    inner: Arc<Mutex<HttpInner>>,
}

struct HttpInner {
    client: reqwest::blocking::Client,
    document: String,
    headers: HashMap<String, String>,
}

#[derive(Clone)]
struct DocumentHandle {
    client: HttpClient,
}

#[derive(Clone)]
struct HeadersHandle {
    client: HttpClient,
}

#[derive(Clone)]
struct HeaderValuesHandle {
    client: HttpClient,
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
                headers: HashMap::new(),
            })),
        })
    }

    pub fn document(&self) -> String {
        self.inner.lock().document.clone()
    }

    pub fn headers_map(&self) -> HashMap<String, String> {
        self.inner.lock().headers.clone()
    }

    pub fn set_header(&self, key: &str, value: &str) {
        self.inner.lock().headers.insert(key.to_string(), value.to_string());
    }

    /// Perform GET (applies stored headers). Returns success.
    pub fn get_url(&self, url: &str) -> bool {
        self.get(url)
    }

    fn reset(&self) {
        let mut inner = self.inner.lock();
        inner.document.clear();
        inner.headers.clear();
    }

    fn get(&self, url: &str) -> bool {
        let (client, headers) = {
            let inner = self.inner.lock();
            (inner.client.clone(), inner.headers.clone())
        };
        let mut req = client.get(url);
        for (k, v) in &headers {
            req = req.header(k.as_str(), v.as_str());
        }
        match req.send() {
            Ok(resp) => {
                let ok = resp.status().is_success() || resp.status().as_u16() == 304;
                let text = resp.text().unwrap_or_default();
                let mut inner = self.inner.lock();
                inner.document = text;
                ok || !inner.document.is_empty()
            }
            Err(_) => {
                self.inner.lock().document.clear();
                false
            }
        }
    }

    fn post(&self, url: &str) -> bool {
        let (client, headers) = {
            let inner = self.inner.lock();
            (inner.client.clone(), inner.headers.clone())
        };
        let mut req = client.post(url);
        for (k, v) in &headers {
            req = req.header(k.as_str(), v.as_str());
        }
        match req.send() {
            Ok(resp) => {
                let ok = resp.status().is_success();
                let text = resp.text().unwrap_or_default();
                let mut inner = self.inner.lock();
                inner.document = text;
                ok
            }
            Err(_) => {
                self.inner.lock().document.clear();
                false
            }
        }
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
            let v = this
                .client
                .inner
                .lock()
                .headers
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
                    Value::Integer(i) => i.to_string(),
                    Value::Number(n) => n.to_string(),
                    Value::Boolean(b) => b.to_string(),
                    _ => String::new(),
                };
                this.client.inner.lock().headers.insert(key, s);
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
                "GET" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, url: String| Ok(this.get(&url)))?;
                    Ok(Value::Function(f))
                }
                "POST" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, url: String| Ok(this.post(&url)))?;
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
                "MimeType" => Ok(Value::String(lua.create_string("")?)),
                _ => Ok(Value::Nil),
            }
        });
    }
}
