//! Windows DPAPI (`CryptProtectData`/`CryptUnprotectData`) wrapper.
//!
//! Used to encrypt sensitive settings (the Cloudflare session: cookies incl.
//! `cf_clearance`, plus its User-Agent) at rest in SQLite. The ciphertext is
//! tied to the current Windows user account — it cannot be decrypted by
//! another user, nor after copying `fmd3.db` to another machine.

use windows::core::PCWSTR;
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
};

/// Copies a DPAPI output blob into an owned `Vec<u8>` and frees it with
/// `LocalFree`, as required by the Win32 contract for these two calls.
fn take_blob(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    if blob.pbData.is_null() || blob.cbData == 0 {
        return Vec::new();
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize) }.to_vec();
    unsafe {
        let _ = LocalFree(Some(HLOCAL(blob.pbData as *mut core::ffi::c_void)));
    }
    bytes
}

/// Encrypts `plaintext` for the current Windows user (`CRYPTPROTECT_UI_FORBIDDEN`:
/// never shows a UI prompt, fails instead).
pub fn protect(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(take_blob(output))
}

/// Decrypts a blob produced by `protect` for the current Windows user.
pub fn unprotect(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: ciphertext.len() as u32,
        pbData: ciphertext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(take_blob(output))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let plaintext = b"cf_clearance=abc123; some=value".to_vec();
        let encrypted = protect(&plaintext).expect("protect should succeed");
        assert_ne!(encrypted, plaintext, "ciphertext must differ from plaintext");
        let decrypted = unprotect(&encrypted).expect("unprotect should succeed");
        assert_eq!(decrypted, plaintext);
    }
}
