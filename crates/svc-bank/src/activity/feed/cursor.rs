//! The composite cursor of `activity.list` (`activity-cursor.ts`), byte for byte: `<payload>.<mac>`, the payload the
//! base64url of `JSON.stringify({v:1,u,a,o,f?,s?})`, the mac an HMAC-SHA256 of the payload's text under a key derived
//! from the service secret by HKDF-SHA256 (empty salt, info `bank.activity.cursor.v1`), both base64url without padding.
//!
//! The cursor binds the user, the asset filter and, for a filtered page, the filter; it never decides which owners are
//! read (the owner list is rebuilt from the session on every call).

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use service_kit::json::{self, Json};
use sha2::Sha256;

/// HKDF `info`.
pub const CURSOR_KEY_INFO: &str = "bank.activity.cursor.v1";
const MAX_CURSOR_LENGTH: usize = 16_384;

/// Where one owner stopped: a ledger cursor (resume after it), not started (`null`), or nothing older (`false`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pos {
    Ledger(String),
    Start,
    Done,
}

/// `CursorBody`. The owners keep the order they were written in.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Body {
    pub user_id: String,
    pub asset_id: Option<String>,
    pub owners: Vec<(String, Pos)>,
    /// Set only for a filtered page.
    pub filter_key: Option<String>,
    /// Matching rows already returned from this position; 0 is "omitted".
    pub skip: u32,
}

impl Body {
    /// An owner's position, `None` when the cursor does not name it.
    pub fn owner(&self, key: &str) -> Option<&Pos> {
        self.owners.iter().find(|(k, _)| k == key).map(|(_, p)| p)
    }
}

/// `ActivityCursorInvalidError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalid;

/// HKDF-SHA256 (RFC 5869) of the secret's UTF-8 bytes, empty salt, 32 bytes (one block).
pub fn derive_key(secret: &str) -> [u8; 32] {
    // An empty salt is HashLen zero bytes; HMAC pads its key with zeros, so the empty key is the same key.
    let mut extract = Hmac::<Sha256>::new_from_slice(&[]).unwrap_or_else(|_| unreachable!());
    extract.update(secret.as_bytes());
    let prk = extract.finalize().into_bytes();
    let mut expand = Hmac::<Sha256>::new_from_slice(&prk).unwrap_or_else(|_| unreachable!());
    expand.update(CURSOR_KEY_INFO.as_bytes());
    expand.update(&[1]);
    expand.finalize().into_bytes().into()
}

fn mac_of(secret: &str, payload: &str) -> Hmac<Sha256> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(&derive_key(secret)).unwrap_or_else(|_| unreachable!());
    mac.update(payload.as_bytes());
    mac
}

fn pos_json(p: &Pos) -> Json {
    match p {
        Pos::Ledger(s) => Json::str(s.clone()),
        Pos::Start => Json::Null,
        Pos::Done => Json::Bool(false),
    }
}

/// `encodeCursor`.
pub fn encode(secret: &str, body: &Body) -> String {
    let mut fields = vec![
        ("v".to_owned(), Json::int(1)),
        ("u".to_owned(), Json::str(body.user_id.clone())),
        (
            "a".to_owned(),
            body.asset_id.clone().map_or(Json::Null, Json::String),
        ),
        (
            "o".to_owned(),
            Json::Object(json::js_key_order(
                body.owners
                    .iter()
                    .map(|(k, p)| (k.clone(), pos_json(p)))
                    .collect(),
            )),
        ),
    ];
    if let Some(f) = body.filter_key.as_ref().filter(|f| !f.is_empty()) {
        fields.push(("f".to_owned(), Json::str(f.clone())));
    }
    if body.skip > 0 {
        fields.push(("s".to_owned(), Json::int(i64::from(body.skip))));
    }
    let payload = URL_SAFE_NO_PAD.encode(Json::Object(fields).compact());
    let mac = URL_SAFE_NO_PAD.encode(mac_of(secret, &payload).finalize().into_bytes());
    format!("{payload}.{mac}")
}

/// `Buffer.from(text, 'base64url')`: characters outside the alphabet are skipped, a lone last character is dropped,
/// and trailing bits are ignored.
pub fn b64url_lenient(text: &str) -> Vec<u8> {
    let value = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some(u32::from(c - b'A')),
            b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
            b'-' | b'+' => Some(62),
            b'_' | b'/' => Some(63),
            _ => None,
        }
    };
    let digits: Vec<u32> = text
        .bytes()
        .take_while(|b| *b != b'=')
        .filter_map(value)
        .collect();
    let mut out = Vec::with_capacity(digits.len() * 3 / 4);
    for chunk in digits.chunks(4) {
        let mut n = 0u32;
        for (i, d) in chunk.iter().enumerate() {
            n |= d << (18 - 6 * i);
        }
        let bytes = n.to_be_bytes();
        let take = match chunk.len() {
            4 => 3,
            3 => 2,
            2 => 1,
            _ => 0,
        };
        out.extend_from_slice(bytes.get(1..1 + take).unwrap_or_default());
    }
    out
}

fn alphabet(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `decodeCursor`: the body, unless the cursor is not ours, not intact, or not issued to this user for this asset
/// filter and this filter (`None`: an unfiltered page).
pub fn decode(
    secret: &str,
    cursor: &str,
    user_id: &str,
    asset_id: Option<&str>,
    filter_key: Option<&str>,
) -> Result<Body, Invalid> {
    if cursor.encode_utf16().count() > MAX_CURSOR_LENGTH {
        return Err(Invalid);
    }
    let (payload, mac) = cursor.split_once('.').ok_or(Invalid)?;
    if !alphabet(payload) || !alphabet(mac) {
        return Err(Invalid);
    }
    let given = b64url_lenient(mac);
    if given.len() != 32 {
        return Err(Invalid);
    }
    mac_of(secret, payload)
        .verify_slice(&given)
        .map_err(|_| Invalid)?;
    let text = String::from_utf8_lossy(&b64url_lenient(payload)).into_owned();
    let raw = json::parse(&text).map_err(|_| Invalid)?;
    let Json::Object(_) = raw else {
        return Err(Invalid);
    };
    if raw.get("v") != Some(&Json::Number(1.0)) {
        return Err(Invalid);
    }
    match raw.get("u") {
        Some(Json::String(u)) if u == user_id => {}
        _ => return Err(Invalid),
    }
    let a_ok = match (raw.get("a"), asset_id) {
        (None | Some(Json::Null), None) => true,
        (Some(Json::String(a)), Some(want)) => a == want,
        _ => false,
    };
    if !a_ok {
        return Err(Invalid);
    }
    let Some(Json::Object(owners)) = raw.get("o") else {
        return Err(Invalid);
    };
    let stored = match raw.get("f") {
        Some(Json::String(f)) => Some(f.clone()),
        _ => None,
    };
    if stored.as_deref() != filter_key {
        return Err(Invalid);
    }
    let skip = match raw.get("s") {
        None => 0.0,
        Some(Json::Number(n)) => *n,
        Some(_) => return Err(Invalid),
    };
    if skip.fract() != 0.0 || !(0.0..=100_000.0).contains(&skip) {
        return Err(Invalid);
    }
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a whole number from 0 to 100,000"
    )]
    let skip = skip as u32;
    if skip > 0 && stored.is_none() {
        return Err(Invalid);
    }
    let mut out = Vec::with_capacity(owners.len());
    for (key, pos) in owners {
        let pos = match pos {
            Json::Null => Pos::Start,
            Json::Bool(false) => Pos::Done,
            Json::String(s) => Pos::Ledger(s.clone()),
            _ => return Err(Invalid),
        };
        out.push((key.clone(), pos));
    }
    Ok(Body {
        user_id: user_id.to_owned(),
        asset_id: asset_id.map(str::to_owned),
        owners: out,
        filter_key: stored.filter(|f| !f.is_empty()),
        skip,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    const SECRET: &str = "a-bank-activity-test-cursor-secret-long-enough";
    const ALICE: &str = "11111111-1111-4111-8111-111111111111";

    #[test]
    fn hkdf_matches_rfc_5869_test_case_3() {
        // RFC 5869 A.3: IKM 22 x 0x0b, empty salt, empty info. Our derivation fixes the info, so check the extract
        // and expand steps against the RFC's PRK and OKM directly.
        let ikm = [0x0bu8; 22];
        let mut extract = Hmac::<Sha256>::new_from_slice(&[]).unwrap();
        extract.update(&ikm);
        let prk = extract.finalize().into_bytes();
        let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        assert_eq!(
            hex(&prk),
            "19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04"
        );
        let mut expand = Hmac::<Sha256>::new_from_slice(&prk).unwrap();
        expand.update(&[1]);
        assert_eq!(
            hex(&expand.finalize().into_bytes()),
            "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d"
        );
    }

    #[test]
    fn signs_with_an_hkdf_derived_key_not_the_raw_secret() {
        let body = Body {
            user_id: ALICE.to_owned(),
            owners: vec![("u".to_owned(), Pos::Start)],
            ..Body::default()
        };
        let cursor = encode(SECRET, &body);
        let (payload, mac) = cursor.split_once('.').unwrap();
        assert_eq!(
            String::from_utf8(b64url_lenient(payload)).unwrap(),
            format!(r#"{{"v":1,"u":"{ALICE}","a":null,"o":{{"u":null}}}}"#)
        );
        let mut raw = Hmac::<Sha256>::new_from_slice(SECRET.as_bytes()).unwrap();
        raw.update(payload.as_bytes());
        let raw_mac = URL_SAFE_NO_PAD.encode(raw.finalize().into_bytes());
        assert_ne!(mac, raw_mac);
        assert_eq!(
            decode(SECRET, &format!("{payload}.{raw_mac}"), ALICE, None, None),
            Err(Invalid)
        );
        assert_eq!(decode(SECRET, &cursor, ALICE, None, None).unwrap(), body);
    }

    #[test]
    fn refuses_a_forged_or_mangled_cursor() {
        let other = encode(
            "another-secret-entirely-xxxxxxxxxxxxxxxxx",
            &Body {
                user_id: ALICE.to_owned(),
                owners: vec![("u".to_owned(), Pos::Start)],
                ..Body::default()
            },
        );
        for bad in ["garbage", "a.b", "", "....", other.as_str()] {
            assert_eq!(
                decode(SECRET, bad, ALICE, None, None),
                Err(Invalid),
                "{bad}"
            );
        }
    }

    #[test]
    fn binds_the_filter_and_the_skip() {
        let body = Body {
            user_id: ALICE.to_owned(),
            asset_id: Some("USDT".to_owned()),
            owners: vec![
                ("u".to_owned(), Pos::Ledger("djIuMw".to_owned())),
                ("s:x".to_owned(), Pos::Done),
            ],
            filter_key: Some("{\"k\":null}".to_owned()),
            skip: 3,
        };
        let c = encode(SECRET, &body);
        assert_eq!(
            decode(SECRET, &c, ALICE, Some("USDT"), Some("{\"k\":null}")).unwrap(),
            body
        );
        assert_eq!(decode(SECRET, &c, ALICE, Some("USDT"), None), Err(Invalid));
        assert_eq!(
            decode(SECRET, &c, ALICE, None, Some("{\"k\":null}")),
            Err(Invalid)
        );
    }
}
