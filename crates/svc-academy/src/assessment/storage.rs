//! The object store for assignment files (`video/storage.ts`: `presign`, `signGetObjectUrl`, `signPutObjectUrl`), and
//! the bytes sent to and read from a signed address (`putOverHttp` in `curriculum/assignments.ts`, `getOverHttp` in
//! `curriculum/peer-review.ts`). Path-style SigV4 presigning; the bucket is never listed.

use std::time::Duration;

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use service_kit::json::Json;
use service_kit::schema::js_trim;
use service_kit::time::Instant;

use super::{num, refuse, sha256_hex};
use crate::errors::Refusal;
use crate::settings::Settings;

/// `VideoStorageConfig`.
#[derive(Debug, Clone, PartialEq)]
pub struct StorageConfig {
    pub endpoint: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
    pub region: String,
    pub ttl_seconds: Option<f64>,
}

fn text(settings: &Settings, key: &str) -> String {
    match settings.0.get(key) {
        Some(Json::String(s)) => s.clone(),
        _ => String::new(),
    }
}

/// `videoStorageFromEnv(env)`: none unless the endpoint, bucket and keys are all set.
pub fn from_settings(settings: &Settings) -> Option<StorageConfig> {
    let config = StorageConfig {
        endpoint: text(settings, "ACADEMY_VIDEO_S3_ENDPOINT"),
        bucket: text(settings, "ACADEMY_VIDEO_S3_BUCKET"),
        access_key: text(settings, "ACADEMY_VIDEO_S3_ACCESS_KEY"),
        secret_key: text(settings, "ACADEMY_VIDEO_S3_SECRET_KEY"),
        region: text(settings, "ACADEMY_VIDEO_S3_REGION"),
        ttl_seconds: match settings.0.get("ACADEMY_VIDEO_URL_TTL_SECONDS") {
            Some(Json::Number(n)) => Some(*n),
            _ => None,
        },
    };
    configured(&config).then_some(config)
}

/// `isVideoStorageConfigured`.
pub fn configured(c: &StorageConfig) -> bool {
    [&c.endpoint, &c.bucket, &c.access_key, &c.secret_key]
        .iter()
        .all(|v| !js_trim(v).is_empty())
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(key) else {
        return Vec::new();
    };
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `awsEncode(value, keepSlash)`.
pub fn aws_encode(value: &str, keep_slash: bool) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric()
            || matches!(ch, '.' | '_' | '~' | '-')
            || (keep_slash && ch == '/')
        {
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

/// `endpointParts(endpoint)`: the origin and the signed host, as WHATWG `URL` reads them (a default port dropped).
pub fn endpoint_parts(endpoint: &str) -> (String, String) {
    let full = if endpoint.contains("://") {
        endpoint.to_owned()
    } else {
        format!("http://{endpoint}")
    };
    let (scheme, rest) = full.split_once("://").unwrap_or(("http", full.as_str()));
    let scheme = scheme.to_ascii_lowercase();
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, h)| h)
        .to_ascii_lowercase();
    let default = if scheme == "https" {
        ":443"
    } else if scheme == "http" {
        ":80"
    } else {
        ""
    };
    let host = if !default.is_empty() && authority.ends_with(default) {
        authority.trim_end_matches(default).to_owned()
    } else {
        authority
    };
    (format!("{scheme}://{host}"), host)
}

/// `presign(config, method, objectKey, at)`: the URL.
pub fn presign(
    config: &StorageConfig,
    method: &str,
    object_key: &str,
    at: i64,
) -> Result<String, Refusal> {
    if !configured(config) {
        return refuse(
            "Video object storage is not configured — set ACADEMY_VIDEO_S3_ENDPOINT, bucket, and keys (or leave off)",
            "academy.video_storage_unconfigured",
        );
    }
    let key = object_key.trim_start_matches('/');
    if key.is_empty() {
        return refuse(
            "Video object key is missing — no grant",
            "academy.video_grant_required",
        );
    }
    #[expect(
        clippy::float_cmp,
        reason = "Number.isInteger: a whole number equals its truncation"
    )]
    let ttl = match config.ttl_seconds {
        Some(t) if t.trunc() == t && (1.0..=3600.0).contains(&t) => Json::Number(t),
        _ => {
            return refuse(
                "Academy video URL TTL is unset — set ACADEMY_VIDEO_URL_TTL_SECONDS (never invent seconds)",
                "academy.video_url_ttl_unset",
            );
        }
    };
    let ttl = num(&ttl).unwrap_or(0);
    let (origin, host) = endpoint_parts(&config.endpoint);
    let iso = Instant(at).iso();
    let digits: String = iso.chars().filter(char::is_ascii_digit).collect();
    let date_stamp = digits.get(..8).unwrap_or("").to_owned();
    let amz_date = format!("{date_stamp}T{}Z", digits.get(8..14).unwrap_or(""));
    let region = js_trim(&config.region);
    if region.is_empty() {
        return refuse(
            "Academy video S3 region is unset — set ACADEMY_VIDEO_S3_REGION (never invent us-east-1)",
            "academy.video_s3_region_unset",
        );
    }
    let credential = format!(
        "{}/{date_stamp}/{region}/s3/aws4_request",
        config.access_key
    );
    let canonical_uri = aws_encode(&format!("/{}/{key}", config.bucket), true);
    let mut query = [
        ("X-Amz-Algorithm", "AWS4-HMAC-SHA256".to_owned()),
        ("X-Amz-Credential", credential),
        ("X-Amz-Date", amz_date.clone()),
        ("X-Amz-Expires", ttl.to_string()),
        ("X-Amz-SignedHeaders", "host".to_owned()),
    ];
    query.sort_by(|a, b| a.0.cmp(b.0));
    let canonical_query = query
        .iter()
        .map(|(k, v)| format!("{}={}", aws_encode(k, false), aws_encode(v, false)))
        .collect::<Vec<_>>()
        .join("&");
    let canonical_request = [
        method,
        &canonical_uri,
        &canonical_query,
        &format!("host:{host}\n"),
        "host",
        "UNSIGNED-PAYLOAD",
    ]
    .join("\n");
    let scope = format!("{date_stamp}/{region}/s3/aws4_request");
    let to_sign = [
        "AWS4-HMAC-SHA256",
        &amz_date,
        &scope,
        &hex(&Sha256::digest(canonical_request.as_bytes())),
    ]
    .join("\n");
    let k_date = hmac(format!("AWS4{}", config.secret_key).as_bytes(), &date_stamp);
    let k_region = hmac(&k_date, region);
    let k_service = hmac(&k_region, "s3");
    let signing = hmac(&k_service, "aws4_request");
    let signature = hex(&hmac(&signing, &to_sign));
    Ok(format!(
        "{origin}{canonical_uri}?{canonical_query}&X-Amz-Signature={signature}"
    ))
}

/// Sends a file's bytes to, and reads them back from, a signed address (`PutObjectFn`, `GetObjectFn`). Swapped in tests.
pub trait ObjectBytes: Send + Sync {
    /// The store's status, or an error when the request never got one (`fetch` threw).
    fn put(&self, url: &str, bytes: &[u8], content_type: &str) -> Result<u16, String>;
    /// The status and, on a 2xx, the body.
    fn get(&self, url: &str) -> Result<(u16, Vec<u8>), String>;
}

/// `putOverHttp` / `getOverHttp`: one minute each.
pub struct HttpObjectBytes {
    agent: ureq::Agent,
}

impl Default for HttpObjectBytes {
    fn default() -> Self {
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(60)))
            .build()
            .new_agent();
        HttpObjectBytes { agent }
    }
}

impl ObjectBytes for HttpObjectBytes {
    fn put(&self, url: &str, bytes: &[u8], content_type: &str) -> Result<u16, String> {
        self.agent
            .put(url)
            .header("content-type", content_type)
            .send(bytes)
            .map(|r| r.status().as_u16())
            .map_err(|e| e.to_string())
    }

    fn get(&self, url: &str) -> Result<(u16, Vec<u8>), String> {
        let mut res = self.agent.get(url).call().map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        if !(200..300).contains(&status) {
            return Ok((status, Vec::new()));
        }
        let bytes = res
            .body_mut()
            .with_config()
            .limit(u64::MAX)
            .read_to_vec()
            .map_err(|e| e.to_string())?;
        Ok((status, bytes))
    }
}

/// The sha256 of bytes, hex.
pub fn sha256_of(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> StorageConfig {
        StorageConfig {
            endpoint: "http://minio:9000".into(),
            bucket: "academy".into(),
            access_key: "AKIDEXAMPLE".into(),
            secret_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".into(),
            region: "us-test-1".into(),
            ttl_seconds: Some(600.0),
        }
    }

    #[test]
    fn endpoint_drops_default_ports() {
        assert_eq!(
            endpoint_parts("minio:9000"),
            ("http://minio:9000".into(), "minio:9000".into())
        );
        assert_eq!(
            endpoint_parts("https://S3.example.com:443/"),
            ("https://s3.example.com".into(), "s3.example.com".into())
        );
    }

    #[test]
    fn presigned_urls_match_node() {
        // From `signPutObjectUrl` / `signGetObjectUrl` in Node over the same inputs.
        assert_eq!(
            presign(
                &config(),
                "PUT",
                "/courses/c/items/i/submissions/u/ab",
                1_700_000_000_000
            )
            .unwrap_or_default(),
            "http://minio:9000/academy/courses/c/items/i/submissions/u/ab?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20231114%2Fus-test-1%2Fs3%2Faws4_request&X-Amz-Date=20231114T221320Z&X-Amz-Expires=600&X-Amz-SignedHeaders=host&X-Amz-Signature=095fd44f6a5af0fdc3e3c4e1daa528592dcc716ccdb572dc6751ed8eb0977177"
        );
        assert_eq!(
            presign(&config(), "GET", "courses/\u{fc} x/k", 1_700_000_000_000).unwrap_or_default(),
            "http://minio:9000/academy/courses/%C3%BC%20x/k?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20231114%2Fus-test-1%2Fs3%2Faws4_request&X-Amz-Date=20231114T221320Z&X-Amz-Expires=600&X-Amz-SignedHeaders=host&X-Amz-Signature=c4943282e216cb839703b5c71ab42341663e15ff24b681ab243189eabe9f35d4"
        );
        let mut no_ttl = config();
        no_ttl.ttl_seconds = None;
        assert!(presign(&no_ttl, "GET", "k", 0).is_err());
    }
}
