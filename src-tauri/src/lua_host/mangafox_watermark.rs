//! `require 'fmd.mangafoxwatermark'` — LoadTemplate / RemoveWatermark (FanFox).

use image::{DynamicImage, GrayImage, ImageFormat, RgbaImage};
use mlua::{Lua, Table, Value};
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Clone)]
struct Template {
    width: u32,
    height: u32,
    /// Otsu-binarized 0/255 bytes
    bits: Vec<u8>,
}

struct Remover {
    templates: Vec<Template>,
    template_dir: PathBuf,
    min_psnr: f32,
    min_white_border: u32,
}

impl Remover {
    fn new() -> Self {
        Self {
            templates: Vec::new(),
            template_dir: PathBuf::new(),
            min_psnr: 9.0,
            min_white_border: 4,
        }
    }

    fn clear(&mut self) {
        self.templates.clear();
    }

    fn load_template(&mut self, dir: &str) -> usize {
        if !dir.is_empty() {
            self.template_dir = PathBuf::from(dir);
        }
        if self.template_dir.as_os_str().is_empty() {
            return 0;
        }
        self.clear();
        let Ok(rd) = std::fs::read_dir(&self.template_dir) else {
            return 0;
        };
        for ent in rd.flatten() {
            let p = ent.path();
            if !p.is_file() {
                continue;
            }
            if let Ok(t) = load_one_bit_template(&p) {
                self.templates.push(t);
            }
        }
        self.templates.len()
    }

    fn remove_watermark(&self, file: &str, save_as_png: bool) -> bool {
        if self.templates.is_empty() {
            return false;
        }
        let path = Path::new(file);
        let Ok(img) = image::open(path) else {
            return false;
        };
        let rgba = img.to_rgba8();
        let (w, h) = rgba.dimensions();
        let mut best_i = None;
        let mut best_psnr = 0.0f32;
        for (i, tmpl) in self.templates.iter().enumerate() {
            if h < tmpl.height {
                continue;
            }
            let l = if w > tmpl.width {
                (w - tmpl.width) / 2
            } else {
                0
            };
            let region = crop_one_bit(&rgba, l, h - tmpl.height, tmpl.width, tmpl.height);
            if !white_border_ok(&region, tmpl.width, self.min_white_border) {
                continue;
            }
            let psnr = calc_psnr(&region, &tmpl.bits);
            if psnr > best_psnr {
                best_psnr = psnr;
                best_i = Some(i);
            }
        }
        let Some(idx) = best_i else {
            return false;
        };
        if best_psnr < self.min_psnr {
            return false;
        }
        let th = self.templates[idx].height;
        let cropped = image::imageops::crop_imm(&rgba, 0, 0, w, h - th).to_image();
        let out_path = if save_as_png {
            path.with_extension("png")
        } else {
            path.to_path_buf()
        };
        let _ = std::fs::remove_file(path);
        let dynimg = DynamicImage::ImageRgba8(cropped);
        let ok = if save_as_png {
            dynimg.save_with_format(&out_path, ImageFormat::Png).is_ok()
        } else {
            dynimg.save(&out_path).is_ok()
        };
        ok && out_path.is_file()
    }
}

fn gray_byte(p: image::Rgba<u8>) -> u8 {
    ((u16::from(p[0]) * 77 + u16::from(p[1]) * 150 + u16::from(p[2]) * 29) / 256) as u8
}

fn otsu_threshold(hist: &[u32; 256], total: u32) -> u8 {
    let mut sum_all = 0u64;
    for (i, &c) in hist.iter().enumerate() {
        sum_all += (i as u64) * c as u64;
    }
    let mut sum_b = 0u64;
    let mut w_b = 0u32;
    let mut max_var = 0.0f64;
    let mut threshold = 128u8;
    for t in 0..256 {
        w_b += hist[t];
        if w_b == 0 {
            continue;
        }
        let w_f = total - w_b;
        if w_f == 0 {
            break;
        }
        sum_b += (t as u64) * hist[t] as u64;
        let m_b = sum_b as f64 / w_b as f64;
        let m_f = (sum_all - sum_b) as f64 / w_f as f64;
        let var = w_b as f64 * w_f as f64 * (m_b - m_f).powi(2);
        if var > max_var {
            max_var = var;
            threshold = t as u8;
        }
    }
    threshold
}

fn to_one_bit(gray: &GrayImage) -> Vec<u8> {
    let mut hist = [0u32; 256];
    for p in gray.pixels() {
        hist[p[0] as usize] += 1;
    }
    let thr = otsu_threshold(&hist, gray.len() as u32);
    gray.pixels()
        .map(|p| if p[0] > thr { 255 } else { 0 })
        .collect()
}

fn load_one_bit_template(path: &Path) -> Result<Template, String> {
    let img = image::open(path).map_err(|e| e.to_string())?;
    let gray = img.to_luma8();
    let (width, height) = gray.dimensions();
    let bits = to_one_bit(&gray);
    Ok(Template {
        width,
        height,
        bits,
    })
}

fn crop_one_bit(img: &RgbaImage, x: u32, y: u32, w: u32, h: u32) -> Vec<u8> {
    let mut gray = GrayImage::new(w, h);
    for dy in 0..h {
        for dx in 0..w {
            let px = img.get_pixel(x + dx, y + dy);
            gray.put_pixel(dx, dy, image::Luma([gray_byte(*px)]));
        }
    }
    to_one_bit(&gray)
}

fn white_border_ok(bits: &[u8], width: u32, border: u32) -> bool {
    if border == 0 {
        return true;
    }
    let n = (border * width) as usize;
    bits.iter().take(n).all(|&b| b != 0)
}

fn calc_psnr(a: &[u8], b: &[u8]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut mse = 0.0f64;
    for (x, y) in a.iter().zip(b.iter()) {
        let d = i32::from(*x) - i32::from(*y);
        mse += (d * d) as f64;
    }
    mse /= a.len() as f64;
    if mse.sqrt() < 0.0001 {
        return 1e6;
    }
    (10.0 * (255.0f64.powi(2) / mse).log10()) as f32
}

static REMOVER: once_cell::sync::Lazy<Arc<Mutex<Remover>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(Remover::new())));

pub fn register_fmd_mangafoxwatermark(lua: &Lua) -> mlua::Result<()> {
    let package: Table = lua.globals().get("package")?;
    let loaded: Table = package.get("loaded")?;
    let m = lua.create_table()?;
    m.set(
        "LoadTemplate",
        lua.create_function(|_, dir: Option<String>| {
            let n = REMOVER.lock().load_template(dir.as_deref().unwrap_or(""));
            Ok(n as i64)
        })?,
    )?;
    m.set(
        "RemoveWatermark",
        lua.create_function(|_, (file, save_png): (String, Option<Value>)| {
            let save = match save_png {
                Some(Value::Boolean(b)) => b,
                Some(Value::Integer(i)) => i != 0,
                _ => false,
            };
            Ok(REMOVER.lock().remove_watermark(&file, save))
        })?,
    )?;
    loaded.set("fmd.mangafoxwatermark", m)?;
    Ok(())
}
