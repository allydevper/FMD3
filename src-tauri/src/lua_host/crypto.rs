//! `require 'fmd.crypto'` — subset of FMD2 LuaCrypto.pas used by modules.

use aes::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit, StreamCipher};
use aes::{Aes128, Aes192, Aes256};
use base64::{engine::general_purpose::STANDARD, Engine};
use cbc::{Decryptor as CbcDecryptor, Encryptor as CbcEncryptor};
use hmac::{Hmac, Mac};
use md5::Md5;
use mlua::{Lua, Table, Value};
use sha1::{Digest as Sha1Digest, Sha1};
use sha2::{Digest, Sha256, Sha512};

type Aes128Ctr = ctr::Ctr128BE<Aes128>;
type Aes192Ctr = ctr::Ctr128BE<Aes192>;
type Aes256Ctr = ctr::Ctr128BE<Aes256>;
type HmacSha256 = Hmac<Sha256>;
type HmacSha1 = Hmac<Sha1>;
type HmacSha512 = Hmac<Sha512>;
type HmacMd5 = Hmac<Md5>;
type Aes128CbcEnc = CbcEncryptor<Aes128>;
type Aes128CbcDec = CbcDecryptor<Aes128>;
type Aes256CbcEnc = CbcEncryptor<Aes256>;
type Aes256CbcDec = CbcDecryptor<Aes256>;

/// FMD2 EscapeHTML / crypto.HTMLEncode
pub fn html_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Minimal HTMLDecode (amp / lt / gt / quot / #39 / nbsp).
pub fn html_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'&' {
            let rest = &s[i..];
            if let Some(decoded) = decode_entity(rest) {
                out.push_str(decoded.0);
                i += decoded.1;
                continue;
            }
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn decode_entity(s: &str) -> Option<(&'static str, usize)> {
    const ENTITIES: &[(&str, &str)] = &[
        ("&amp;", "&"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&#39;", "'"),
        ("&apos;", "'"),
        ("&nbsp;", " "),
    ];
    for (ent, rep) in ENTITIES {
        if s.starts_with(ent) {
            return Some((rep, ent.len()));
        }
    }
    None
}

/// Synapse EncodeURL — percent-encode URLSpecialChar bytes.
pub fn encode_url(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if url_special(b) {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        } else {
            out.push(b as char);
        }
    }
    out
}

fn url_special(b: u8) -> bool {
    matches!(
        b,
        0x00..=0x20
            | b'<'
            | b'>'
            | b'"'
            | b'%'
            | b'{'
            | b'}'
            | b'|'
            | b'\\'
            | b'^'
            | b'['
            | b']'
            | b'`'
            | 0x7F..=0xFF
    )
}

pub fn hmac_sha256(data: &[u8], key: &[u8]) -> Vec<u8> {
    if data.is_empty() || key.is_empty() {
        return Vec::new();
    }
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// FMD2 AESCTR: AES-CTR big-endian counter, key length 16/24/32 (padded).
pub fn aes_ctr(data: &[u8], key: &[u8], iv: &[u8]) -> Vec<u8> {
    if data.is_empty() || key.is_empty() || iv.is_empty() {
        return Vec::new();
    }
    let mut counter = [0u8; 16];
    let n = iv.len().min(16);
    counter[..n].copy_from_slice(&iv[..n]);

    let mut out = data.to_vec();
    if key.len() <= 16 {
        let mut k = [0u8; 16];
        k[..key.len()].copy_from_slice(key);
        let mut cipher = Aes128Ctr::new(&k.into(), &counter.into());
        cipher.apply_keystream(&mut out);
    } else if key.len() <= 24 {
        let mut k = [0u8; 24];
        k[..key.len()].copy_from_slice(key);
        let mut cipher = Aes192Ctr::new(&k.into(), &counter.into());
        cipher.apply_keystream(&mut out);
    } else {
        let mut k = [0u8; 32];
        let n = key.len().min(32);
        k[..n].copy_from_slice(&key[..n]);
        let mut cipher = Aes256Ctr::new(&k.into(), &counter.into());
        cipher.apply_keystream(&mut out);
    }
    out
}

fn lua_bytes(v: Value) -> Vec<u8> {
    match v {
        Value::String(s) => s.as_bytes().to_vec(),
        _ => Vec::new(),
    }
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(s: &str) -> Vec<u8> {
    let clean: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    (0..clean.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(clean.get(i..i + 2)?, 16).ok())
        .collect()
}

fn aes_cbc_encrypt(data: &[u8], key: &[u8], iv: &[u8]) -> Vec<u8> {
    if data.is_empty() || key.is_empty() || iv.len() < 16 {
        return Vec::new();
    }
    let mut iv16 = [0u8; 16];
    iv16.copy_from_slice(&iv[..16]);
    let mut buf = data.to_vec();
    let pad = 16 - (buf.len() % 16);
    buf.extend(std::iter::repeat(pad as u8).take(pad));
    if key.len() <= 16 {
        let mut k = [0u8; 16];
        k[..key.len()].copy_from_slice(key);
        let mut enc = Aes128CbcEnc::new(&k.into(), &iv16.into());
        for chunk in buf.chunks_exact_mut(16) {
            enc.encrypt_block_mut(aes::cipher::Block::<Aes128>::from_mut_slice(chunk));
        }
    } else {
        let mut k = [0u8; 32];
        let n = key.len().min(32);
        k[..n].copy_from_slice(&key[..n]);
        let mut enc = Aes256CbcEnc::new(&k.into(), &iv16.into());
        for chunk in buf.chunks_exact_mut(16) {
            enc.encrypt_block_mut(aes::cipher::Block::<Aes256>::from_mut_slice(chunk));
        }
    }
    buf
}

fn aes_cbc_decrypt(data: &[u8], key: &[u8], iv: &[u8]) -> Vec<u8> {
    if data.is_empty() || data.len() % 16 != 0 || key.is_empty() || iv.len() < 16 {
        return Vec::new();
    }
    let mut iv16 = [0u8; 16];
    iv16.copy_from_slice(&iv[..16]);
    let mut buf = data.to_vec();
    if key.len() <= 16 {
        let mut k = [0u8; 16];
        k[..key.len()].copy_from_slice(key);
        let mut dec = Aes128CbcDec::new(&k.into(), &iv16.into());
        for chunk in buf.chunks_exact_mut(16) {
            dec.decrypt_block_mut(aes::cipher::Block::<Aes128>::from_mut_slice(chunk));
        }
    } else {
        let mut k = [0u8; 32];
        let n = key.len().min(32);
        k[..n].copy_from_slice(&key[..n]);
        let mut dec = Aes256CbcDec::new(&k.into(), &iv16.into());
        for chunk in buf.chunks_exact_mut(16) {
            dec.decrypt_block_mut(aes::cipher::Block::<Aes256>::from_mut_slice(chunk));
        }
    }
    if let Some(&pad) = buf.last() {
        let pad = pad as usize;
        if (1..=16).contains(&pad) && buf.len() >= pad {
            buf.truncate(buf.len() - pad);
        }
    }
    buf
}

fn rc4(data: &[u8], key: &[u8]) -> Vec<u8> {
    if data.is_empty() || key.is_empty() {
        return Vec::new();
    }
    let mut s: Vec<u8> = (0..=255).collect();
    let mut j = 0u8;
    for i in 0..256 {
        j = j.wrapping_add(s[i]).wrapping_add(key[i % key.len()]);
        s.swap(i, j as usize);
    }
    let mut i = 0u8;
    j = 0;
    data.iter()
        .map(|&b| {
            i = i.wrapping_add(1);
            j = j.wrapping_add(s[i as usize]);
            s.swap(i as usize, j as usize);
            b ^ s[(s[i as usize].wrapping_add(s[j as usize])) as usize]
        })
        .collect()
}

pub fn register_fmd_crypto(lua: &Lua) -> mlua::Result<()> {
    let package: Table = lua.globals().get("package")?;
    let loaded: Table = package.get("loaded")?;

    let crypto = lua.create_table()?;
    crypto.set(
        "DecodeBase64",
        lua.create_function(|lua, data: String| {
            let cleaned: String = data.chars().filter(|c| !c.is_whitespace()).collect();
            match STANDARD.decode(cleaned.as_bytes()) {
                Ok(bytes) => Ok(Value::String(lua.create_string(&bytes)?)),
                Err(_) => Ok(Value::Nil),
            }
        })?,
    )?;
    crypto.set(
        "EncodeBase64",
        lua.create_function(|_, data: Value| {
            Ok(STANDARD.encode(lua_bytes(data)))
        })?,
    )?;
    crypto.set(
        "EncodeURLElement",
        lua.create_function(|_, s: String| {
            Ok(url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>())
        })?,
    )?;
    crypto.set(
        "EncodeURL",
        lua.create_function(|_, s: String| Ok(encode_url(&s)))?,
    )?;
    crypto.set(
        "HTMLEncode",
        lua.create_function(|_, s: String| Ok(html_encode(&s)))?,
    )?;
    crypto.set(
        "HTMLDecode",
        lua.create_function(|_, s: String| Ok(html_decode(&s)))?,
    )?;
    crypto.set(
        "HMAC_SHA256",
        lua.create_function(|lua, (data, key): (Value, Value)| {
            let out = hmac_sha256(&lua_bytes(data), &lua_bytes(key));
            Ok(Value::String(lua.create_string(&out)?))
        })?,
    )?;
    crypto.set(
        "AESCTR",
        lua.create_function(|lua, (data, key, iv): (Value, Value, Value)| {
            let out = aes_ctr(&lua_bytes(data), &lua_bytes(key), &lua_bytes(iv));
            Ok(Value::String(lua.create_string(&out)?))
        })?,
    )?;
    crypto.set(
        "SHA256",
        lua.create_function(|lua, data: Value| {
            let hash = Sha256::digest(lua_bytes(data));
            Ok(Value::String(lua.create_string(hash.as_slice())?))
        })?,
    )?;
    crypto.set(
        "SHA256Hex",
        lua.create_function(|_, data: Value| Ok(to_hex(&Sha256::digest(lua_bytes(data)))))?,
    )?;
    crypto.set(
        "SHA512",
        lua.create_function(|lua, data: Value| {
            let hash = Sha512::digest(lua_bytes(data));
            Ok(Value::String(lua.create_string(hash.as_slice())?))
        })?,
    )?;
    crypto.set(
        "SHA512Hex",
        lua.create_function(|_, data: Value| Ok(to_hex(&Sha512::digest(lua_bytes(data)))))?,
    )?;
    crypto.set(
        "SHA1",
        lua.create_function(|lua, data: Value| {
            let hash = <Sha1 as Sha1Digest>::digest(lua_bytes(data));
            Ok(Value::String(lua.create_string(hash.as_slice())?))
        })?,
    )?;
    crypto.set(
        "MD5",
        lua.create_function(|lua, data: Value| {
            let hash = <Md5 as Digest>::digest(lua_bytes(data));
            Ok(Value::String(lua.create_string(hash.as_slice())?))
        })?,
    )?;
    crypto.set(
        "MD5Hex",
        lua.create_function(|_, data: Value| {
            Ok(to_hex(&<Md5 as Digest>::digest(lua_bytes(data))))
        })?,
    )?;
    crypto.set(
        "HMAC_SHA256Hex",
        lua.create_function(|_, (data, key): (Value, Value)| {
            Ok(to_hex(&hmac_sha256(&lua_bytes(data), &lua_bytes(key))))
        })?,
    )?;
    crypto.set(
        "HMAC_SHA512",
        lua.create_function(|lua, (data, key): (Value, Value)| {
            let d = lua_bytes(data);
            let k = lua_bytes(key);
            if d.is_empty() || k.is_empty() {
                return Ok(Value::String(lua.create_string("")?));
            }
            let mut mac = HmacSha512::new_from_slice(&k).expect("hmac");
            mac.update(&d);
            Ok(Value::String(lua.create_string(&mac.finalize().into_bytes())?))
        })?,
    )?;
    crypto.set(
        "HMAC_SHA1",
        lua.create_function(|lua, (data, key): (Value, Value)| {
            let d = lua_bytes(data);
            let k = lua_bytes(key);
            if d.is_empty() || k.is_empty() {
                return Ok(Value::String(lua.create_string("")?));
            }
            let mut mac = HmacSha1::new_from_slice(&k).expect("hmac");
            mac.update(&d);
            Ok(Value::String(lua.create_string(&mac.finalize().into_bytes())?))
        })?,
    )?;
    crypto.set(
        "HMAC_MD5",
        lua.create_function(|lua, (data, key): (Value, Value)| {
            let d = lua_bytes(data);
            let k = lua_bytes(key);
            if d.is_empty() || k.is_empty() {
                return Ok(Value::String(lua.create_string("")?));
            }
            let mut mac = HmacMd5::new_from_slice(&k).expect("hmac");
            mac.update(&d);
            Ok(Value::String(lua.create_string(&mac.finalize().into_bytes())?))
        })?,
    )?;
    crypto.set(
        "AESEncryptCBC",
        lua.create_function(|lua, (data, key, iv): (Value, Value, Value)| {
            let out = aes_cbc_encrypt(&lua_bytes(data), &lua_bytes(key), &lua_bytes(iv));
            Ok(Value::String(lua.create_string(&out)?))
        })?,
    )?;
    crypto.set(
        "AESDecryptCBC",
        lua.create_function(|lua, (data, key, iv): (Value, Value, Value)| {
            let out = aes_cbc_decrypt(&lua_bytes(data), &lua_bytes(key), &lua_bytes(iv));
            Ok(Value::String(lua.create_string(&out)?))
        })?,
    )?;
    crypto.set(
        "RC4",
        lua.create_function(|lua, (data, key): (Value, Value)| {
            let out = rc4(&lua_bytes(data), &lua_bytes(key));
            Ok(Value::String(lua.create_string(&out)?))
        })?,
    )?;
    crypto.set(
        "HexToStr",
        lua.create_function(|lua, s: String| {
            Ok(Value::String(lua.create_string(&from_hex(&s))?))
        })?,
    )?;
    crypto.set(
        "StrToHexStr",
        lua.create_function(|_, data: Value| Ok(to_hex(&lua_bytes(data))))?,
    )?;

    loaded.set("fmd.crypto", crypto)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_encode_basic() {
        assert_eq!(html_encode("<a>&"), "&lt;a&gt;&amp;");
        assert_eq!(html_decode("&lt;a&gt;&amp;"), "<a>&");
    }

    #[test]
    fn encode_url_space() {
        assert_eq!(encode_url("a b"), "a%20b");
        assert!(!encode_url("http://x.com/a").contains("%3A")); // ':' not in URLSpecialChar
    }

    #[test]
    fn hmac_and_aesctr_roundtrip() {
        let key = hmac_sha256(b"page:0:block", b"chapter-key");
        assert_eq!(key.len(), 32);
        let iv = [0u8; 16];
        let plain = b"hello image bytes!!";
        let enc = aes_ctr(plain, &key, &iv);
        assert_ne!(enc, plain);
        let dec = aes_ctr(&enc, &key, &iv);
        assert_eq!(dec, plain);
    }

    #[test]
    fn lua_htmlencode_hmac() {
        let lua = Lua::new();
        register_fmd_crypto(&lua).unwrap();
        lua.load(
            r#"
            local c = require('fmd.crypto')
            assert(c.HTMLEncode('<x>') == '&lt;x&gt;')
            local h = c.HMAC_SHA256('data', 'key')
            assert(#h == 32)
            local z = string.rep('\0', 16)
            local e = c.AESCTR('abcdefghijklmnop', h, z)
            assert(c.AESCTR(e, h, z) == 'abcdefghijklmnop')
            "#,
        )
        .exec()
        .unwrap();
    }
}
