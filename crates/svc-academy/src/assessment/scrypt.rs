//! scrypt (RFC 7914) at Node's defaults, for quiz access codes: `crypto.scrypt(code, salt, 32)` with N = 16384, r = 8,
//! p = 1 (`curriculum/course-quizzes.ts` `hashAccessCode`, `accessCodeMatches`). A stored hash is
//! `scrypt$<salt hex>$<hash hex>`, and every hash the TypeScript stored keeps verifying here.

use hmac::{Hmac, Mac};
use sha2::Sha256;

const N: usize = 16_384;
const R: usize = 8;
/// 32-bit words in one block of 128 * r bytes.
const WORDS: usize = 32 * R;

type HmacSha256 = Hmac<Sha256>;

/// PBKDF2-HMAC-SHA256 with one iteration, `len` bytes.
fn pbkdf2_once(password: &[u8], salt: &[u8], len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    let mut i: u32 = 1;
    while out.len() < len {
        let Ok(mut mac) = HmacSha256::new_from_slice(password) else {
            return out;
        };
        mac.update(salt);
        mac.update(&i.to_be_bytes());
        out.extend_from_slice(&mac.finalize().into_bytes());
        i += 1;
    }
    out.truncate(len);
    out
}

macro_rules! quarter {
    ($x:ident, $a:literal, $b:literal, $c:literal, $d:literal) => {
        $x[$b] ^= $x[$a].wrapping_add($x[$d]).rotate_left(7);
        $x[$c] ^= $x[$b].wrapping_add($x[$a]).rotate_left(9);
        $x[$d] ^= $x[$c].wrapping_add($x[$b]).rotate_left(13);
        $x[$a] ^= $x[$d].wrapping_add($x[$c]).rotate_left(18);
    };
}

/// Salsa20/8 core on one 64-byte block.
fn salsa20_8(b: &mut [u32; 16]) {
    let mut x = *b;
    for _ in 0..4 {
        quarter!(x, 0, 4, 8, 12);
        quarter!(x, 5, 9, 13, 1);
        quarter!(x, 10, 14, 2, 6);
        quarter!(x, 15, 3, 7, 11);
        quarter!(x, 0, 1, 2, 3);
        quarter!(x, 5, 6, 7, 4);
        quarter!(x, 10, 11, 8, 9);
        quarter!(x, 15, 12, 13, 14);
    }
    for (o, v) in b.iter_mut().zip(x) {
        *o = o.wrapping_add(v);
    }
}

/// BlockMix with Salsa20/8: `out` gets the even blocks then the odd ones.
fn block_mix(input: &[u32], out: &mut [u32]) {
    let mut x = [0u32; 16];
    if let Some(last) = input.as_chunks::<16>().0.iter().last() {
        x.copy_from_slice(last);
    }
    for (i, block) in input.as_chunks::<16>().0.iter().enumerate() {
        for (a, b) in x.iter_mut().zip(block) {
            *a ^= *b;
        }
        salsa20_8(&mut x);
        let at = if i % 2 == 0 { i / 2 } else { R + i / 2 };
        if let Some(dst) = out.get_mut(at * 16..at * 16 + 16) {
            dst.copy_from_slice(&x);
        }
    }
}

fn ro_mix(block: &mut [u32]) {
    let mut v = vec![0u32; N * WORDS];
    let mut x = block.to_vec();
    let mut y = vec![0u32; WORDS];
    for chunk in v.as_chunks_mut::<WORDS>().0 {
        chunk.copy_from_slice(&x);
        block_mix(&x, &mut y);
        std::mem::swap(&mut x, &mut y);
    }
    for _ in 0..N {
        let j = x.get(WORDS - 16).copied().unwrap_or(0) as usize % N;
        if let Some(vj) = v.get(j * WORDS..(j + 1) * WORDS) {
            for (a, b) in x.iter_mut().zip(vj) {
                *a ^= *b;
            }
        }
        block_mix(&x, &mut y);
        std::mem::swap(&mut x, &mut y);
    }
    block.copy_from_slice(&x);
}

/// `scrypt(password, salt, len)` at N = 16384, r = 8, p = 1.
pub fn scrypt(password: &[u8], salt: &[u8], len: usize) -> Vec<u8> {
    let b = pbkdf2_once(password, salt, 128 * R);
    let mut words: Vec<u32> = b
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| {
            u32::from_le_bytes([
                c.first().copied().unwrap_or(0),
                c.get(1).copied().unwrap_or(0),
                c.get(2).copied().unwrap_or(0),
                c.get(3).copied().unwrap_or(0),
            ])
        })
        .collect();
    ro_mix(&mut words);
    let mixed: Vec<u8> = words.iter().flat_map(|w| w.to_le_bytes()).collect();
    pbkdf2_once(password, &mixed, len)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `Buffer.from(text, 'hex')`: pairs of hex digits up to the first that is not one.
fn from_hex(text: &str) -> Vec<u8> {
    let digits: Vec<u8> = text.bytes().collect();
    let mut out = Vec::new();
    for pair in digits.as_chunks::<2>().0 {
        let (Some(a), Some(b)) = (
            pair.first().and_then(|d| (*d as char).to_digit(16)),
            pair.get(1).and_then(|d| (*d as char).to_digit(16)),
        ) else {
            break;
        };
        out.push(u8::try_from(a * 16 + b).unwrap_or(0));
    }
    out
}

/// `hashAccessCode(code, salt)`: `scrypt$<salt>$<hash>`, hex.
pub fn hash_access_code(code: &str, salt: &[u8]) -> String {
    format!(
        "scrypt${}${}",
        hex(salt),
        hex(&scrypt(code.as_bytes(), salt, 32))
    )
}

/// A fresh 16-byte salt.
pub fn random_salt() -> [u8; 16] {
    let mut salt = [0u8; 16];
    // A failing system source leaves the salt it has; there is no other source to fall back to.
    let _ = getrandom::fill(&mut salt);
    salt
}

/// `accessCodeMatches(code, stored)`: a malformed hash matches nothing; the comparison takes the same time either way.
pub fn access_code_matches(code: &str, stored: &str) -> bool {
    let mut parts = stored.split('$');
    let (scheme, salt, hash) = (parts.next(), parts.next(), parts.next());
    let (Some("scrypt"), Some(salt), Some(hash)) = (scheme, salt, hash) else {
        return false;
    };
    if salt.is_empty() || hash.is_empty() {
        return false;
    }
    let expected = from_hex(hash);
    if expected.len() != 32 {
        return false;
    }
    let got = scrypt(code.as_bytes(), &from_hex(salt), 32);
    expected
        .iter()
        .zip(&got)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hash_node_stored_keeps_verifying() {
        // node -e "require('crypto').scryptSync('open sesame', Buffer.from('000102030405060708090a0b0c0d0e0f','hex'), 32)"
        let stored = "scrypt$000102030405060708090a0b0c0d0e0f$7d37f3a0bc8f007da895288b85f2a303dd90e17a4ac347c66a41f93144ee076e";
        assert!(access_code_matches("open sesame", stored));
        assert!(!access_code_matches("open sesame!", stored));
        assert_eq!(
            hex(&scrypt(b"", b"", 32)),
            "d72c87d0f077c7766f2985dfab30e8955c373a13a1e93d315203939f542ff86e"
        );
        let salt: Vec<u8> = (0u8..16).collect();
        let made = hash_access_code("open sesame", &salt);
        assert_eq!(made, stored);
        assert!(access_code_matches("open sesame", &made));
        assert!(!access_code_matches("open sesamE", &made));
        assert!(!access_code_matches("open sesame", "bcrypt$00$11"));
        assert!(!access_code_matches("open sesame", "scrypt$$"));
    }
}
