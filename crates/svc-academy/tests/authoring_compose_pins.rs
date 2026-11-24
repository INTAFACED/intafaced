//! The video compose pins: `video/compose-pin.test.ts`, `video/video-s3-region-compose-pin.test.ts`,
//! `video/video-url-ttl-compose-pin.test.ts` and `video/video-watch-threshold-compose-pin.test.ts`.
//!
//! The compose file is the same file the crate will be deployed with, so its lines are read here as the TypeScript reads
//! them. The TypeScript's checks on `env.ts` source text ("defaults to `''`, never `us-east-1` or `300`") hold the
//! meaning "a blank owner value loads as unset, never as an invented default"; here that is asserted on what the
//! crate's loader (`env::load`) actually loads, and on the signing code refusing by name.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test"
)]

use std::collections::BTreeMap;

use service_kit::json::Json;

fn compose() -> String {
    std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docker-compose.apps.yml"
    ))
    .unwrap()
}

/// `composeServiceBlock(source, name)`: the service's lines, up to the next service.
fn block(source: &str, name: &str) -> String {
    let lines: Vec<&str> = source.split('\n').collect();
    let start = lines
        .iter()
        .position(|l| *l == format!("  {name}:"))
        .unwrap_or_else(|| panic!("{name} missing"));
    let mut out = vec![lines[start]];
    for l in &lines[start + 1..] {
        let is_service =
            l.starts_with("  ") && !l.starts_with("   ") && l.trim_end().ends_with(':');
        if is_service {
            break;
        }
        out.push(l);
    }
    out.join("\n")
}

/// Lines that are exactly `<key>: <value>` after indentation.
fn lines_of(source: &str, key: &str, value: &str) -> usize {
    source
        .lines()
        .filter(|l| l.starts_with(' ') && l.trim() == format!("{key}: {value}"))
        .count()
}

fn assignments(source: &str, key: &str) -> usize {
    source
        .lines()
        .filter(|l| l.trim_start().starts_with(&format!("{key}:")))
        .count()
}

fn load(over: &[(&str, &str)]) -> Result<Json, String> {
    let mut source: BTreeMap<String, String> = [
        ("DATABASE_URL", "postgres://u:p@localhost:5432/db"),
        ("DATABASE_POOL_MAX", "10"),
        ("EDGE_PRINCIPAL_SECRET", &*"s".repeat(32)),
        ("INTERNAL_SERVICE_SECRET", &*"s".repeat(32)),
        ("NODE_ENV", "test"),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
    .collect();
    for (k, v) in over {
        source.insert((*k).to_owned(), (*v).to_owned());
    }
    svc_academy::env::load(&source)
        .map(|e| e.json)
        .map_err(|e| e.message)
}

fn signing_source() -> String {
    std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/authoring/storage.rs"
    ))
    .unwrap()
}

// ── video/compose-pin.test.ts ───────────────────────────────────────────────────────────────────────────────────────

#[test]
fn the_loader_defaults_every_video_key_empty() {
    let env = load(&[]).unwrap();
    for key in [
        "ACADEMY_VIDEO_S3_ENDPOINT",
        "ACADEMY_VIDEO_S3_BUCKET",
        "ACADEMY_VIDEO_S3_ACCESS_KEY",
        "ACADEMY_VIDEO_S3_SECRET_KEY",
        "ACADEMY_VIDEO_S3_REGION",
        "ACADEMY_VIDEO_MIN_TIER",
        "ACADEMY_VIDEO_MIN_STAKE",
    ] {
        assert_eq!(env.get(key), Some(&Json::str("")), "{key}");
    }
}

#[test]
fn svc_academy_compose_passes_video_env_with_empty_defaults() {
    let academy = block(&compose(), "svc-academy");
    assert_eq!(lines_of(&academy, "SERVICE_NAME", "svc-academy"), 1);
    for key in [
        "ACADEMY_VIDEO_S3_ENDPOINT",
        "ACADEMY_VIDEO_S3_BUCKET",
        "ACADEMY_VIDEO_S3_REGION",
    ] {
        assert_eq!(
            lines_of(&academy, key, &format!("${{{key}:-}}")),
            1,
            "{key}"
        );
    }
    assert!(!academy.contains("ACADEMY_VIDEO_S3_ENDPOINT:-http"));
    assert!(!academy.contains("ACADEMY_VIDEO_S3_REGION:-us-east-1"));
}

#[test]
fn academy_minio_is_profile_gated_default_off_not_livekit() {
    let minio = block(&compose(), "academy-minio");
    assert!(
        minio
            .lines()
            .any(|l| l.trim() == "profiles: ['academy-video']"),
        "{minio}"
    );
    assert!(minio.contains("minio/minio:"));
    assert!(!minio.lines().any(|l| {
        let t = l.trim_start();
        (t.starts_with("image:") || t.starts_with("command:"))
            && t.to_lowercase().contains("livekit")
    }));
}

// ── video/video-s3-region-compose-pin.test.ts and video/video-url-ttl-compose-pin.test.ts ───────────────────────────

#[test]
fn the_region_and_the_ttl_are_one_empty_pass_through_in_the_svc_academy_block_only() {
    let all = compose();
    let academy = block(&all, "svc-academy");
    for key in ["ACADEMY_VIDEO_S3_REGION", "ACADEMY_VIDEO_URL_TTL_SECONDS"] {
        assert_eq!(
            lines_of(&academy, key, &format!("${{{key}:-}}")),
            1,
            "{key}"
        );
        assert_eq!(assignments(&academy, key), 1, "{key}");
        assert_eq!(
            all.lines()
                .filter(|l| l.starts_with(' ') && l.trim_start().starts_with(&format!("{key}:")))
                .count(),
            1,
            "{key}"
        );
    }
    assert!(!academy.contains("ACADEMY_VIDEO_URL_TTL_SECONDS:-300"));
}

#[test]
fn the_pins_restamp_no_sibling_key() {
    let academy = block(&compose(), "svc-academy");
    for (key, value) in [
        ("JWT_ACCESS_TTL_SECONDS", "${JWT_ACCESS_TTL_SECONDS:-900}"),
        (
            "ACADEMY_STREAM_PROVIDER",
            "${ACADEMY_STREAM_PROVIDER:-none}",
        ),
        (
            "ACADEMY_PAPER_TRADING_ENABLED",
            "${ACADEMY_PAPER_TRADING_ENABLED:-true}",
        ),
        (
            "ACADEMY_TOURNAMENT_ENABLED",
            "${ACADEMY_TOURNAMENT_ENABLED:-true}",
        ),
        (
            "ACADEMY_VIDEO_S3_ENDPOINT",
            "${ACADEMY_VIDEO_S3_ENDPOINT:-}",
        ),
        (
            "ACADEMY_VIDEO_URL_TTL_SECONDS",
            "${ACADEMY_VIDEO_URL_TTL_SECONDS:-}",
        ),
        (
            "LIVEKIT_TOKEN_TTL_SECONDS",
            "${LIVEKIT_TOKEN_TTL_SECONDS:-3600}",
        ),
    ] {
        assert_eq!(lines_of(&academy, key, value), 1, "{key}");
    }
}

#[test]
fn the_signing_code_refuses_a_blank_region_and_ttl_by_name_and_never_falls_back() {
    let src = signing_source();
    assert!(src.contains("academy.video_s3_region_unset"));
    assert!(src.contains("academy.video_url_ttl_unset"));
    assert!(!src.contains("\"us-east-1\""));
    assert!(!src.contains(".clamp(1, 3600)"));
}

#[test]
fn an_unset_or_blank_region_is_unpublished_and_an_explicit_one_is_kept() {
    assert_eq!(
        load(&[]).unwrap().get("ACADEMY_VIDEO_S3_REGION"),
        Some(&Json::str(""))
    );
    assert_eq!(
        load(&[("ACADEMY_VIDEO_S3_REGION", "")])
            .unwrap()
            .get("ACADEMY_VIDEO_S3_REGION"),
        Some(&Json::str(""))
    );
    assert_eq!(
        load(&[("ACADEMY_VIDEO_S3_REGION", "us-east-1")])
            .unwrap()
            .get("ACADEMY_VIDEO_S3_REGION"),
        Some(&Json::str("us-east-1"))
    );
}

#[test]
fn an_unset_blank_or_whitespace_ttl_is_unpublished_zero_refuses_and_an_explicit_one_is_kept() {
    assert_eq!(
        load(&[]).unwrap().get("ACADEMY_VIDEO_URL_TTL_SECONDS"),
        None
    );
    assert_eq!(
        load(&[("ACADEMY_VIDEO_URL_TTL_SECONDS", "")])
            .unwrap()
            .get("ACADEMY_VIDEO_URL_TTL_SECONDS"),
        None
    );
    assert_eq!(
        load(&[("ACADEMY_VIDEO_URL_TTL_SECONDS", "   ")])
            .unwrap()
            .get("ACADEMY_VIDEO_URL_TTL_SECONDS"),
        None
    );
    assert!(
        load(&[("ACADEMY_VIDEO_URL_TTL_SECONDS", "0")])
            .unwrap_err()
            .contains("ACADEMY_VIDEO_URL_TTL_SECONDS")
    );
    assert_eq!(
        load(&[("ACADEMY_VIDEO_URL_TTL_SECONDS", "120")])
            .unwrap()
            .get("ACADEMY_VIDEO_URL_TTL_SECONDS"),
        Some(&Json::int(120))
    );
}

// ── video/video-watch-threshold-compose-pin.test.ts ─────────────────────────────────────────────────────────────────

#[test]
fn the_watch_threshold_passes_through_empty_and_no_duration_is_baked() {
    let all = compose();
    let academy = block(&all, "svc-academy");
    let key = "ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS";
    assert_eq!(lines_of(&academy, key, &format!("${{{key}:-}}")), 1);
    assert!(!academy.lines().any(|l| {
        l.contains(&format!("{key}:-"))
            && l.split(":-")
                .nth(1)
                .is_some_and(|r| r.starts_with(|c: char| c.is_ascii_digit()))
    }));
    assert_eq!(load(&[]).unwrap().get(key), None);
    assert_eq!(
        all.lines()
            .filter(|l| l.starts_with(' ') && l.trim_start().starts_with(&format!("{key}:")))
            .count(),
        1
    );
}
