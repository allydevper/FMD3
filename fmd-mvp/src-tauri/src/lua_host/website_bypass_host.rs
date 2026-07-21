//! Run FMD2 `lua/websitebypass` scripts (checkantibot + websitebypass) against HttpClient.

use super::duktape_js;
use super::http::HttpClient;
use super::paths::{self, lua_root, websitebypass_dir};
use mlua::{Lua, Table, Value};
use parking_lot::Mutex;
use std::path::Path;
use std::process::Command;
use std::sync::OnceLock;

static INIT_OK: OnceLock<bool> = OnceLock::new();

fn register_fmd_logger(lua: &Lua) -> mlua::Result<()> {
    let package: Table = lua.globals().get("package")?;
    let loaded: Table = package.get("loaded")?;
    let logger = lua.create_table()?;
    // Quiet by default: use_webdriver=false is the normal path; errors only when debug needed.
    logger.set(
        "SendError",
        lua.create_function(|_, _msg: String| Ok(()))?,
    )?;
    logger.set(
        "SendWarning",
        lua.create_function(|_, _msg: String| Ok(()))?,
    )?;
    logger.set(
        "Send",
        lua.create_function(|_, _msg: String| Ok(()))?,
    )?;
    loaded.set("fmd.logger", logger)?;
    Ok(())
}

fn register_fmd_env(lua: &Lua) -> mlua::Result<()> {
    super::fmd_env::register_fmd_env(lua)
}

fn resolve_python() -> String {
    for prog in ["python", "python3"] {
        if let Ok(out) = Command::new(prog).arg("--version").output() {
            if out.status.success() {
                return prog.to_string();
            }
        }
    }
    #[cfg(windows)]
    {
        if let Ok(out) = Command::new("py")
            .args(["-3", "-c", "import sys; print(sys.executable)"])
            .output()
        {
            if out.status.success() {
                let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !p.is_empty() && Path::new(&p).is_file() {
                    return p;
                }
            }
        }
    }
    "python".to_string()
}

fn register_fmd_subprocess(lua: &Lua) -> mlua::Result<()> {
    let package: Table = lua.globals().get("package")?;
    let loaded: Table = package.get("loaded")?;
    let sub = lua.create_table()?;
    sub.set(
        "RunCommandHide",
        lua.create_function(|_, args: mlua::Variadic<Value>| {
            let mut cmd_args: Vec<String> = Vec::new();
            for a in args.iter() {
                match a {
                    Value::String(s) => cmd_args.push(s.to_string_lossy()),
                    Value::Integer(i) => cmd_args.push(i.to_string()),
                    Value::Number(n) => cmd_args.push(n.to_string()),
                    _ => {}
                }
            }
            if cmd_args.is_empty() {
                return Ok((false, String::new(), String::from("empty command")));
            }
            let program = cmd_args.remove(0);
            let mut cmd = Command::new(&program);
            cmd.args(&cmd_args);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            match cmd.output() {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
                    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
                    let ok = out.status.success();
                    // Prefer last JSON-looking line (python may print noise)
                    let result = stdout
                        .lines()
                        .rev()
                        .find(|l| l.trim_start().starts_with('{'))
                        .unwrap_or(stdout.trim())
                        .to_string();
                    Ok((ok, result, stderr))
                }
                Err(e) => Ok((false, String::new(), e.to_string())),
            }
        })?,
    )?;
    loaded.set("fmd.subprocess", sub)?;
    Ok(())
}

#[derive(Clone, Default)]
struct ModuleStorage {
    map: ArcMutexMap,
}

type ArcMutexMap = std::sync::Arc<Mutex<HashMapStr>>;
type HashMapStr = std::collections::HashMap<String, String>;

impl mlua::UserData for ModuleStorage {
    fn add_methods<M: mlua::UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(mlua::MetaMethod::Index, |lua, this, key: String| {
            if key == "Storage" {
                return Ok(Value::UserData(lua.create_userdata(StorageHandle {
                    map: this.map.clone(),
                })?));
            }
            Ok(Value::Nil)
        });
    }
}

#[derive(Clone)]
struct StorageHandle {
    map: ArcMutexMap,
}

impl mlua::UserData for StorageHandle {
    fn add_methods<M: mlua::UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(mlua::MetaMethod::Index, |lua, this, key: String| {
            let v = this.map.lock().get(&key).cloned().unwrap_or_default();
            Ok(Value::String(lua.create_string(&v)?))
        });
        methods.add_meta_method_mut(
            mlua::MetaMethod::NewIndex,
            |_, this, (key, value): (String, Value)| {
                let s = match value {
                    Value::String(s) => s.to_string_lossy(),
                    Value::Boolean(b) => b.to_string(),
                    Value::Integer(i) => i.to_string(),
                    _ => String::new(),
                };
                this.map.lock().insert(key, s);
                Ok(())
            },
        );
    }
}

fn setup_bypass_lua(lua: &Lua, http: &HttpClient) -> mlua::Result<()> {
    let root = lua_root();
    let wb = websitebypass_dir();
    let root_s = root.to_string_lossy().replace('\\', "/");
    let wb_s = wb.to_string_lossy().replace('\\', "/");
    let path = format!(
        "{wb_s}/?.lua;{wb_s}/?/init.lua;{root_s}/?.lua;{root_s}/?/init.lua;{};",
        paths::package_path()
    );
    let package: Table = lua.globals().get("package")?;
    package.set("path", path)?;

    super::crypto::register_fmd_crypto(lua)?;
    duktape_js::register_fmd_duktape(lua)?;
    register_fmd_logger(lua)?;
    register_fmd_env(lua)?;
    register_fmd_subprocess(lua)?;

    // Absolute paths so cloudflare.lua finds python + scripts (FMD2 Option B)
    let py_script = wb.join("cloudflare.py");
    let config_json = wb.join("websitebypass_config.json");
    lua.globals().set(
        "FMD_CLOUDFLARE_PY",
        py_script.to_string_lossy().as_ref(),
    )?;
    lua.globals().set(
        "FMD_WEBSITEBYPASS_CONFIG",
        config_json.to_string_lossy().as_ref(),
    )?;
    let python = resolve_python();
    lua.globals().set("FMD_PYTHON_EXE", python)?;

    // sleep(ms) used by cloudflare.lua
    lua.globals().set(
        "sleep",
        lua.create_function(|_, ms: u64| {
            std::thread::sleep(std::time::Duration::from_millis(ms.min(30_000)));
            Ok(())
        })?,
    )?;

    // fileExist used at top of cloudflare.lua
    lua.globals().set(
        "fileExist",
        lua.create_function(|_, s: String| Ok(std::path::Path::new(&s).exists()))?,
    )?;

    lua.globals().set("HTTP", http.clone())?;
    lua.globals().set("MODULE", ModuleStorage::default())?;

    // CreateTXQuery for Flare ready JSON when use_webdriver
    super::runtime::register_create_txquery_pub(lua)?;

    let check_path = wb.join("checkantibot.lua");
    let bypass_path = wb.join("websitebypass.lua");
    if !check_path.is_file() || !bypass_path.is_file() {
        eprintln!(
            "WebsiteBypass: faltan scripts en {} (checkantibot/websitebypass)",
            wb.display()
        );
        return Err(mlua::Error::external("websitebypass scripts missing"));
    }

    let check_src = std::fs::read_to_string(&check_path).map_err(mlua::Error::external)?;
    lua.load(&check_src)
        .set_name("checkantibot.lua")
        .exec()?;

    let bypass_src = std::fs::read_to_string(&bypass_path).map_err(mlua::Error::external)?;
    lua.load(&bypass_src)
        .set_name("websitebypass.lua")
        .exec()?;

    Ok(())
}

/// Returns true if WebsiteBypass ran and claimed success.
pub fn try_bypass(http: &HttpClient, method: &str, url: &str) -> bool {
    let wb = websitebypass_dir();
    if !wb.join("checkantibot.lua").is_file() {
        let _ = INIT_OK.set(false);
        return false;
    }

    let lua = Lua::new();
    if let Err(e) = setup_bypass_lua(&lua, http) {
        eprintln!("WebsiteBypass setup: {e}");
        return false;
    }

    let globals = lua.globals();
    let check: mlua::Function = match globals.get("____CheckAntiBot") {
        Ok(f) => f,
        Err(_) => return false,
    };

    let antibot: bool = match check.call::<bool>(http.clone()) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("____CheckAntiBot error: {e}");
            return false;
        }
    };

    if !antibot {
        return false;
    }

    http.begin_bypass();
    let result = (|| {
        let bypass: mlua::Function = globals.get("____WebsiteBypass").ok()?;
        match bypass.call::<bool>((method.to_string(), url.to_string())) {
            Ok(ok) => Some(ok),
            Err(_) => Some(false),
        }
    })();
    http.end_bypass();

    let ok = result.unwrap_or(false);
    if ok {
        http.persist_session();
    }
    ok
}
