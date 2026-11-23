//! How svc-bank signs a receipt it hands a customer (`receipt-signing.ts`): the SHA-256 of the text's UTF-8 bytes, and
//! an HMAC-SHA256 over the same bytes under a key derived (HKDF-SHA256, no salt) from the service secret for one kind of
//! receipt alone, named by `info`.

use sha2::{Digest, Sha256};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// HMAC-SHA256 (RFC 2104).
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        for (b, k) in block.iter_mut().zip(key) {
            *b = *k;
        }
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|b| b ^ 0x36));
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(block.map(|b| b ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

/// `hkdfSync('sha256', secret, <empty salt>, info, 32)` (RFC 5869: an empty salt is 32 zero bytes).
pub fn hkdf_sha256_32(secret: &[u8], info: &[u8]) -> [u8; 32] {
    let prk = hmac_sha256(&[0u8; 32], secret);
    let mut t = info.to_vec();
    t.push(1);
    hmac_sha256(&prk, &t)
}

/// `oneLine`: each run of control characters or line separators is one space, then trimmed.
pub fn one_line(value: Option<&str>) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in value.unwrap_or_default().chars() {
        if c.is_control() || c == '\u{2028}' || c == '\u{2029}' {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    service_kit::money::js_trim(&out).to_owned()
}

/// `signReceipt(text, secret, info)`: `(sha256, signature)`, both lower-case hex.
pub fn sign(text: &str, secret: &str, info: &str) -> (String, String) {
    let key = hkdf_sha256_32(secret.as_bytes(), info.as_bytes());
    (
        hex(&Sha256::digest(text.as_bytes())),
        hex(&hmac_sha256(&key, text.as_bytes())),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_and_hkdf_are_the_rfc_vectors() {
        // RFC 4231 test case 2.
        assert_eq!(
            hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // RFC 5869 test case 3 (no salt, no info), first 32 bytes.
        let ikm = [0x0bu8; 22];
        assert_eq!(
            hex(&hkdf_sha256_32(&ikm, b"")),
            "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d"
        );
    }

    #[test]
    fn one_value_is_one_line() {
        assert_eq!(one_line(Some(" a\n\u{85}b\u{2028}c ")), "a b c");
        assert_eq!(one_line(None), "");
    }
}
