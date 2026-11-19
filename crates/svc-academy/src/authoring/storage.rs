//! The Academy's own object store (`video/storage.ts`): an S3-compatible store (MinIO) reached by path-style SigV4
//! presigned URLs. Blank endpoint, bucket or keys is no store; a blank region or URL lifetime refuses when a URL is
//! signed, never defaulted. The bucket is never listed.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use service_kit::time::Instant;

use super::refuse;
use crate::errors::Refusal;

type HmacSha256 = Hmac<Sha256>;

const UNSIGNED: &str = "UNSIGNED-PAYLOAD";

/// `VideoStorageConfig`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Storage {
    pub endpoint: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
    pub region: String,
    pub ttl_seconds: Option<i64>,
}

/// `IssuedPlayback`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issued {
    pub url: String,
    pub expires_at: i64,
    pub grant: String,
}

fn filled(s: &str) -> bool {
    !service_kit::schema::js_trim(s).is_empty()
}

impl Storage {
    /// `videoStorageFromEnv`: the store when endpoint, bucket and both keys are set.
    pub fn from_env(endpoint: &str, bucket: &str, access_key: &str, secret_key: &str, region: &str, ttl: Option<i64>) -> Option<Storage> {
        let s = Storage {
            endpoint: endpoint.to_owned(),
            bucket: bucket.to_owned(),
            access_key: access_key.to_owned(),
            secret_key: secret_key.to_owned(),
            region: region.to_owned(),
            ttl_seconds: ttl,
        };
        s.configured().then_some(s)
    }

    /// `isVideoStorageConfigured`.
    pub fn configured(&self) -> bool {
        filled(&self.endpoint) && filled(&self.bucket) && filled(&self.access_key) && filled(&self.secret_key)
    }
}

/// `assertVideoStorageConfigured`.
pub fn assert_configured(s: Option<&Storage>) -> Result<&Storage, Refusal> {
    match s {
        Some(s) if s.configured() => Ok(s),
        _ => refuse(
            "Video object storage is not configured — set ACADEMY_VIDEO_S3_ENDPOINT, bucket, and keys (or leave off)",
            "academy.video_storage_unconfigured",
        ),
    }
}

/// `assertPublishedVideoUrlTtl`: an integer in 1..=3600, never clamped.
pub fn assert_ttl(ttl: Option<i64>) -> Result<i64, Refusal> {
    match ttl {
        Some(t) if (1..=3600).contains(&t) => Ok(t),
        _ => refuse(
            "Academy video URL TTL is unset — set ACADEMY_VIDEO_URL_TTL_SECONDS (never invent seconds)",
            "academy.video_url_ttl_unset",
        ),
    }
}

/// `assertPublishedVideoS3Region`.
pub fn assert_region(region: &str) -> Result<&str, Refusal> {
    let t = service_kit::schema::js_trim(region);
    if t.is_empty() {
        return refuse(
            "Academy video S3 region is unset — set ACADEMY_VIDEO_S3_REGION (never invent us-east-1)",
            "academy.video_s3_region_unset",
        );
    }
    Ok(t)
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let Ok(mut m) = HmacSha256::new_from_slice(key) else {
        return Vec::new();
    };
    m.update(data.as_bytes());
    m.finalize().into_bytes().to_vec()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

/// AWS URI-encode: unreserved characters (and `/` in a path) stay; every other byte is `%XX`.
pub fn aws_encode(value: &str, keep_slash: bool) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '~' | '-') || (keep_slash && ch == '/') {
            out.push(ch);
        } else {
            let mut buf = [0u8; 4];
            for b in ch.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        }
    }
    out
}

fn signing_key(secret: &str, date_stamp: &str, region: &str) -> Vec<u8> {
    let k_date = hmac(format!("AWS4{secret}").as_bytes(), date_stamp);
    let k_region = hmac(&k_date, region);
    let k_service = hmac(&k_region, "s3");
    hmac(&k_service, "aws4_request")
}

/// `endpointParts`: the origin and the `host` header (with its port only when not the scheme's default).
fn endpoint_parts(endpoint: &str) -> Result<(String, String), Refusal> {
    let raw = if endpoint.contains("://") {
        endpoint.to_owned()
    } else {
        format!("http://{endpoint}")
    };
    let u = url::Url::parse(&raw).map_err(|e| Refusal::Internal {
        message: format!("Invalid URL: {e}"),
        code: None,
    })?;
    let hostname = u.host_str().unwrap_or("").to_owned();
    let host = match u.port() {
        Some(p) => format!("{hostname}:{p}"),
        None => hostname,
    };
    Ok((format!("{}://{host}", u.scheme()), host))
}

/// `amzDateOf`: `YYYYMMDDTHHMMSSZ` and `YYYYMMDD`, in UTC.
fn amz_date_of(at: i64) -> (String, String) {
    let iso = Instant(at).iso();
    let digits: String = iso.chars().take(19).filter(char::is_ascii_digit).collect();
    let date = digits.get(0..8).unwrap_or_default().to_owned();
    let time = digits.get(8..14).unwrap_or_default();
    (format!("{date}T{time}Z"), date)
}

/// `presign`: a path-style presigned URL for one object and method, valid for the owner's lifetime.
fn presign(s: &Storage, method: &str, object_key: &str, at: i64) -> Result<(String, i64, String), Refusal> {
    let storage = assert_configured(Some(s))?;
    let key = object_key.trim_start_matches('/').to_owned();
    if key.is_empty() {
        return refuse("Video object key is missing — no grant", "academy.video_grant_required");
    }
    let ttl = assert_ttl(storage.ttl_seconds)?;
    let expires_at = at + ttl * 1000;
    let (origin, host) = endpoint_parts(&storage.endpoint)?;
    let (amz_date, date_stamp) = amz_date_of(at);
    let region = assert_region(&storage.region)?;
    let scope = format!("{date_stamp}/{region}/s3/aws4_request");
    let credential = format!("{}/{scope}", storage.access_key);
    let canonical_uri = aws_encode(&format!("/{}/{key}", storage.bucket), true);
    // Already in sorted order.
    let query = [
        ("X-Amz-Algorithm", "AWS4-HMAC-SHA256".to_owned()),
        ("X-Amz-Credential", credential),
        ("X-Amz-Date", amz_date.clone()),
        ("X-Amz-Expires", ttl.to_string()),
        ("X-Amz-SignedHeaders", "host".to_owned()),
    ];
    let canonical_query = query
        .iter()
        .map(|(k, v)| format!("{}={}", aws_encode(k, false), aws_encode(v, false)))
        .collect::<Vec<_>>()
        .join("&");
    let canonical_request = [method, &canonical_uri, &canonical_query, &format!("host:{host}\n"), "host", UNSIGNED].join("\n");
    let string_to_sign = ["AWS4-HMAC-SHA256", &amz_date, &scope, &sha256_hex(canonical_request.as_bytes())].join("\n");
    let signature = hex(&hmac(&signing_key(&storage.secret_key, &date_stamp, region), &string_to_sign));
    Ok((format!("{origin}{canonical_uri}?{canonical_query}&X-Amz-Signature={signature}"), expires_at, key))
}

/// `signGetObjectUrl`.
pub fn sign_get(s: &Storage, object_key: &str, at: i64) -> Result<Issued, Refusal> {
    let (url, expires_at, key) = presign(s, "GET", object_key, at)?;
    Ok(Issued {
        grant: issue_grant(&s.secret_key, &key, expires_at),
        url,
        expires_at,
    })
}

/// `signPutObjectUrl`.
pub fn sign_put(s: &Storage, object_key: &str, at: i64) -> Result<(String, i64), Refusal> {
    let (url, expires_at, _) = presign(s, "PUT", object_key, at)?;
    Ok((url, expires_at))
}

/// `issueGrant`: `v1.<exp seconds>.<hmac hex>`.
pub fn issue_grant(secret: &str, bound: &str, expires_at: i64) -> String {
    let exp = expires_at.div_euclid(1000);
    format!("v1.{exp}.{}", hex(&hmac(secret.as_bytes(), &format!("v1|{bound}|{exp}"))))
}

fn hex_bytes(s: &str) -> Vec<u8> {
    // `Buffer.from(s, 'hex')`: pairs until the first that is not hex.
    let mut out = Vec::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i + 1 < b.len() {
        let (Some(h), Some(l)) = (b.get(i).and_then(|c| (*c as char).to_digit(16)), b.get(i + 1).and_then(|c| (*c as char).to_digit(16)))
        else {
            break;
        };
        out.push(u8::try_from(h * 16 + l).unwrap_or(0));
        i += 2;
    }
    out
}

fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && !a.is_empty() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `grantIsValid`.
pub fn grant_is_valid(secret: &str, bound: &str, grant: &str, now: i64) -> bool {
    let parts: Vec<&str> = grant.split('.').collect();
    let [v, exp, mac] = parts.as_slice() else {
        return false;
    };
    if *v != "v1" {
        return false;
    }
    let Some(exp) = js_integer(exp) else {
        return false;
    };
    if exp * 1000 <= now {
        return false;
    }
    let expected = hex(&hmac(secret.as_bytes(), &format!("v1|{bound}|{exp}")));
    same(&hex_bytes(mac), &hex_bytes(&expected))
}

/// `Number(s)` when it is an integer.
fn js_integer(s: &str) -> Option<i64> {
    let t = service_kit::schema::js_trim(s);
    if t.is_empty() {
        return Some(0);
    }
    let f: f64 = t.parse().ok()?;
    #[expect(clippy::cast_possible_truncation, reason = "checked to be an integer in range first")]
    (f.fract() == 0.0 && f.abs() < 9.0e15).then_some(f as i64)
}

fn grant_required<T>(message: &str) -> Result<T, Refusal> {
    refuse(message, "academy.video_grant_required")
}

/// `assertPlaybackUrlGranted`: the SigV4 signature present, unexpired and matching.
pub fn assert_playback_url_granted(s: &Storage, playback_url: &str, now: i64) -> Result<(), Refusal> {
    let storage = assert_configured(Some(s))?;
    let Ok(parsed) = url::Url::parse(playback_url) else {
        return grant_required("Video URL is not a grant");
    };
    let param = |name: &str| parsed.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    let (Some(signature), Some(amz_date), Some(expires_raw)) =
        (param("X-Amz-Signature"), param("X-Amz-Date"), param("X-Amz-Expires"))
    else {
        return grant_required("Video URL has no grant signature");
    };
    if signature.is_empty() || amz_date.is_empty() || expires_raw.is_empty() {
        return grant_required("Video URL has no grant signature");
    }
    let expires = match js_integer(&expires_raw) {
        Some(e) if e > 0 => e,
        _ => return grant_required("Video URL grant expiry is not a grant"),
    };
    let b = amz_date.as_bytes();
    let shaped = b.len() == 16
        && b.get(8) == Some(&b'T')
        && b.get(15) == Some(&b'Z')
        && b.iter().enumerate().all(|(i, c)| i == 8 || i == 15 || c.is_ascii_digit());
    if !shaped {
        return grant_required("Video URL grant date is not a grant");
    }
    let n = |r: std::ops::Range<usize>| amz_date.get(r).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
    let signed_at = utc_ms(n(0..4), n(4..6) - 1, n(6..8), n(9..11), n(11..13), n(13..15));
    if signed_at + expires * 1000 <= now {
        return grant_required("Video URL grant has expired");
    }
    let path = parsed.path().trim_start_matches('/');
    let rest: Vec<&str> = path.split('/').skip(1).collect();
    let object_key = percent_decode(&rest.join("/"))?;
    let issued = sign_get(
        &Storage {
            ttl_seconds: Some(expires),
            ..storage.clone()
        },
        &object_key,
        signed_at,
    )?;
    let expected = url::Url::parse(&issued.url)
        .ok()
        .and_then(|u| u.query_pairs().find(|(k, _)| k == "X-Amz-Signature").map(|(_, v)| v.into_owned()))
        .unwrap_or_default();
    if !same(&hex_bytes(&signature), &hex_bytes(&expected)) {
        return grant_required("Video URL grant signature does not match");
    }
    Ok(())
}

/// `Date.UTC(y, m, d, h, mi, s)`, with JavaScript's overflow of each field.
fn utc_ms(y: i64, m: i64, d: i64, h: i64, mi: i64, s: i64) -> i64 {
    let y = y + m.div_euclid(12);
    let m = m.rem_euclid(12) + 1;
    // Days from the civil date (Howard Hinnant's algorithm).
    let yy = if m <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468 + (d - 1);
    ((days * 24 + h) * 60 + mi) * 60_000 + s * 1000
}

/// `decodeURIComponent`.
fn percent_decode(s: &str) -> Result<String, Refusal> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(c) = b.get(i) {
        if *c == b'%' {
            let h = b.get(i + 1..i + 3).and_then(|x| std::str::from_utf8(x).ok()).and_then(|x| u8::from_str_radix(x, 16).ok());
            let Some(v) = h else {
                return Err(Refusal::Internal {
                    message: "URI malformed".to_owned(),
                    code: None,
                });
            };
            out.push(v);
            i += 3;
        } else {
            out.push(*c);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| Refusal::Internal {
        message: "URI malformed".to_owned(),
        code: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Storage {
        Storage {
            endpoint: "http://minio:9000".to_owned(),
            bucket: "academy".to_owned(),
            access_key: "TESTACCESS".to_owned(),
            secret_key: "TESTSECRET".to_owned(),
            region: "test-region-1".to_owned(),
            ttl_seconds: Some(300),
        }
    }

    #[test]
    fn a_signed_get_is_a_grant_until_it_expires() {
        let at = 1_767_225_600_000;
        let issued = sign_get(&store(), "foundations/risk-first.mp4", at).unwrap_or_else(|_| unreachable!());
        assert!(issued.url.starts_with("http://minio:9000/academy/foundations/risk-first.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256"));
        assert!(issued.url.contains("X-Amz-Date=20260101T000000Z"));
        assert_eq!(issued.expires_at, at + 300_000);
        assert!(assert_playback_url_granted(&store(), &issued.url, at + 1000).is_ok());
        assert!(assert_playback_url_granted(&store(), &issued.url, at + 300_000).is_err());
        let tampered = issued.url.replace("risk-first", "risk-second");
        assert!(assert_playback_url_granted(&store(), &tampered, at + 1000).is_err());
    }

    #[test]
    fn a_grant_is_bound_and_expires() {
        let g = issue_grant("s", "u|v", 10_000);
        assert!(g.starts_with("v1.10."));
        assert!(grant_is_valid("s", "u|v", &g, 9_000));
        assert!(!grant_is_valid("s", "u|w", &g, 9_000));
        assert!(!grant_is_valid("s", "u|v", &g, 10_000));
    }

    #[test]
    fn utc_matches_javascript() {
        assert_eq!(utc_ms(2026, 0, 1, 0, 0, 0), 1_767_225_600_000);
        assert_eq!(utc_ms(1970, 0, 1, 0, 0, 1), 1000);
    }
}
