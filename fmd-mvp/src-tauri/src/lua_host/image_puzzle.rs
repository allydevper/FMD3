//! `require 'fmd.imagepuzzle'` — FMD2 ImagePuzzle (Create / Matrix / DeScramble).

use super::http::{DocumentHandle, HttpClient};
use image::{GenericImage, GenericImageView, ImageFormat, RgbaImage};
use mlua::{Lua, MetaMethod, UserData, UserDataMethods, Value};
use parking_lot::Mutex;
use std::io::Cursor;
use std::sync::Arc;

#[derive(Clone)]
struct ImagePuzzle {
    hor_block: i32,
    ver_block: i32,
    multiply: i32,
    matrix: Vec<i32>,
}

impl ImagePuzzle {
    fn new(hor_block: i32, ver_block: i32) -> Self {
        let n = (hor_block * ver_block).max(0) as usize;
        Self {
            hor_block,
            ver_block,
            multiply: 1,
            matrix: (0..n as i32).collect(),
        }
    }
}

/// Reorder HorBlock×VerBlock tiles according to Matrix (FMD2 ImagePuzzle.DeScramble).
fn descramble(puzzle: &ImagePuzzle, input: &[u8]) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(input).map_err(|e| e.to_string())?;
    let (width, height) = img.dimensions();
    let hor = puzzle.hor_block.max(1) as u32;
    let ver = puzzle.ver_block.max(1) as u32;
    let needed = (hor * ver) as usize;
    if puzzle.matrix.len() < needed {
        return Err("Invalid matrix size".into());
    }

    let multiply = puzzle.multiply.max(1) as u32;
    let (block_w, block_h) = if multiply <= 1 {
        (width / hor, height / ver)
    } else {
        (
            (width / (hor * multiply)) * multiply,
            (height / (ver * multiply)) * multiply,
        )
    };
    if block_w == 0 || block_h == 0 {
        return Err("Block size is zero".into());
    }

    let src = img.to_rgba8();
    let mut dst = RgbaImage::new(width, height);
    for i in 0..needed {
        let m = puzzle.matrix[i].max(0) as u32;
        let dst_row = m / hor;
        let dst_col = m % hor;
        let src_row = i as u32 / hor;
        let src_col = i as u32 % hor;

        let sx = src_col * block_w;
        let sy = src_row * block_h;
        let dx = dst_col * block_w;
        let dy = dst_row * block_h;
        if sx + block_w > width || sy + block_h > height || dx + block_w > width || dy + block_h > height
        {
            continue;
        }
        let tile = src.view(sx, sy, block_w, block_h).to_image();
        dst.copy_from(&tile, dx, dy)
            .map_err(|e| e.to_string())?;
    }

    encode_like_input(input, &dst)
}

fn detect_format(input: &[u8]) -> ImageFormat {
    if input.len() >= 12 && &input[0..4] == b"RIFF" && &input[8..12] == b"WEBP" {
        // FMD2 webp path saves as png
        return ImageFormat::Png;
    }
    if input.starts_with(&[0x89, b'P', b'N', b'G']) {
        return ImageFormat::Png;
    }
    ImageFormat::Jpeg
}

fn encode_like_input(input: &[u8], img: &RgbaImage) -> Result<Vec<u8>, String> {
    let format = detect_format(input);
    let mut buf = Cursor::new(Vec::new());
    match format {
        ImageFormat::Png => {
            img.write_to(&mut buf, ImageFormat::Png)
                .map_err(|e| e.to_string())?;
        }
        _ => {
            image::DynamicImage::ImageRgba8(img.clone())
                .to_rgb8()
                .write_to(&mut buf, ImageFormat::Jpeg)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(buf.into_inner())
}

#[derive(Clone)]
struct ImagePuzzleHandle {
    inner: Arc<Mutex<ImagePuzzle>>,
}

#[derive(Clone)]
struct MatrixProxy {
    puzzle: ImagePuzzleHandle,
}

fn client_from_value(v: &Value) -> Option<HttpClient> {
    let Value::UserData(ud) = v else {
        return None;
    };
    if let Ok(d) = ud.borrow::<DocumentHandle>() {
        return Some(d.client.clone());
    }
    if let Ok(h) = ud.borrow::<HttpClient>() {
        return Some(h.clone());
    }
    None
}

impl UserData for MatrixProxy {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(MetaMethod::Index, |_, this, idx: i64| {
            let p = this.puzzle.inner.lock();
            let i = idx as usize;
            Ok(p.matrix.get(i).copied().unwrap_or(0))
        });
        methods.add_meta_method_mut(MetaMethod::NewIndex, |_, this, (idx, val): (i64, i64)| {
            let mut p = this.puzzle.inner.lock();
            let i = idx as usize;
            if i < p.matrix.len() {
                p.matrix[i] = val as i32;
            }
            Ok(())
        });
    }
}

impl UserData for ImagePuzzleHandle {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(MetaMethod::Index, |lua, this, key: Value| {
            // numeric index is not used on puzzle itself
            let key = match key {
                Value::String(s) => s.to_string_lossy(),
                _ => return Ok(Value::Nil),
            };
            match key.as_str() {
                "Matrix" => Ok(Value::UserData(lua.create_userdata(MatrixProxy {
                    puzzle: this.clone(),
                })?)),
                "HorBlock" => Ok(Value::Integer(this.inner.lock().hor_block as i64)),
                "VerBlock" => Ok(Value::Integer(this.inner.lock().ver_block as i64)),
                "Multiply" => Ok(Value::Integer(this.inner.lock().multiply as i64)),
                "DeScramble" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, (input, output): (Value, Value)| {
                        let in_c = client_from_value(&input)
                            .ok_or_else(|| mlua::Error::runtime("DeScramble: bad input"))?;
                        let out_c = client_from_value(&output)
                            .ok_or_else(|| mlua::Error::runtime("DeScramble: bad output"))?;
                        let bytes = in_c.document_bytes();
                        let puzzle = this.inner.lock().clone();
                        let out = descramble(&puzzle, &bytes)
                            .map_err(mlua::Error::runtime)?;
                        out_c.set_document_bytes(out);
                        Ok(())
                    })?;
                    Ok(Value::Function(f))
                }
                _ => Ok(Value::Nil),
            }
        });
        methods.add_meta_method_mut(MetaMethod::NewIndex, |_, this, (key, val): (Value, Value)| {
            let key = match key {
                Value::String(s) => s.to_string_lossy(),
                _ => return Ok(()),
            };
            if key == "Multiply" {
                if let Value::Integer(i) = val {
                    this.inner.lock().multiply = i as i32;
                }
            }
            Ok(())
        });
    }
}

pub fn register_fmd_imagepuzzle(lua: &Lua) -> mlua::Result<()> {
    let package: mlua::Table = lua.globals().get("package")?;
    let loaded: mlua::Table = package.get("loaded")?;
    let m = lua.create_table()?;
    let create = lua.create_function(|lua, (hor, ver): (i64, i64)| {
        let handle = ImagePuzzleHandle {
            inner: Arc::new(Mutex::new(ImagePuzzle::new(hor as i32, ver as i32))),
        };
        Ok(lua.create_userdata(handle)?)
    })?;
    m.set("Create", create.clone())?;
    m.set("New", create)?;
    loaded.set("fmd.imagepuzzle", m)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn solid_blocks_png() -> Vec<u8> {
        // 4x4 image, 2x2 blocks of distinct colors
        let mut img = RgbaImage::new(4, 4);
        let colors = [
            Rgba([255, 0, 0, 255]),
            Rgba([0, 255, 0, 255]),
            Rgba([0, 0, 255, 255]),
            Rgba([255, 255, 0, 255]),
        ];
        for by in 0..2u32 {
            for bx in 0..2u32 {
                let c = colors[(by * 2 + bx) as usize];
                for y in 0..2u32 {
                    for x in 0..2u32 {
                        img.put_pixel(bx * 2 + x, by * 2 + y, c);
                    }
                }
            }
        }
        let mut buf = Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png).unwrap();
        buf.into_inner()
    }

    #[test]
    fn descramble_identity() {
        let png = solid_blocks_png();
        let puzzle = ImagePuzzle::new(2, 2);
        let out = descramble(&puzzle, &png).unwrap();
        let a = image::load_from_memory(&png).unwrap().to_rgba8();
        let b = image::load_from_memory(&out).unwrap().to_rgba8();
        assert_eq!(a.as_raw(), b.as_raw());
    }

    #[test]
    fn descramble_swaps_tiles() {
        let png = solid_blocks_png();
        let mut puzzle = ImagePuzzle::new(2, 2);
        // place tile 0 (red) at position 1, tile 1 (green) at 0
        puzzle.matrix = vec![1, 0, 2, 3];
        let out = descramble(&puzzle, &png).unwrap();
        let b = image::load_from_memory(&out).unwrap().to_rgba8();
        // dst position 0 gets source tile from matrix mapping:
        // for i=0, Matrix[0]=1 → dst row/col of 1 = (0,1) gets src tile 0 (red)
        // for i=1, Matrix[1]=0 → dst (0,0) gets src tile 1 (green)
        assert_eq!(*b.get_pixel(0, 0), Rgba([0, 255, 0, 255]));
        assert_eq!(*b.get_pixel(2, 0), Rgba([255, 0, 0, 255]));
    }

    #[test]
    fn lua_create_matrix_descramble_document() {
        use crate::lua_host::http::HttpClient;
        use mlua::Lua;

        let lua = Lua::new();
        register_fmd_imagepuzzle(&lua).unwrap();
        let http = HttpClient::new().unwrap();
        http.set_document_bytes(solid_blocks_png());
        let doc = lua
            .create_userdata(DocumentHandle {
                client: http.clone(),
            })
            .unwrap();
        lua.globals().set("DOC", doc).unwrap();
        lua.load(
            r#"
            local IP = require('fmd.imagepuzzle')
            local p = IP.Create(2, 2)
            assert(p.HorBlock == 2 and p.VerBlock == 2)
            p.Matrix[0] = 1
            p.Matrix[1] = 0
            p.DeScramble(DOC, DOC)
            "#,
        )
        .exec()
        .unwrap();
        let out = http.document_bytes();
        let b = image::load_from_memory(&out).unwrap().to_rgba8();
        assert_eq!(*b.get_pixel(0, 0), Rgba([0, 255, 0, 255]));
        assert_eq!(*b.get_pixel(2, 0), Rgba([255, 0, 0, 255]));
    }
}
