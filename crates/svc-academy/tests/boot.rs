//! How svc-academy is started: the fleet's compose file runs this crate's binary in its own image, after its own
//! `migrate` one-shot, with the owner's blanks left blank. It holds the compose pins the TypeScript service's tests held
//! that no slice's tests hold yet: `stream/livekit-compose-pin.test.ts`, `access/max-room-capacity-compose-pin.test.ts`
//! and `jwt-access-ttl-issuer-audience-compose-pin.test.ts` (the video, paper, tournament and ambassador pins are in
//! `authoring_compose_pins.rs`, `programme_paper_guards.rs`, `programme_tournaments_wire.rs` and
//! `programme_ambassadors.rs`). Their checks on `env.ts` source text are what `env_parity.rs` holds: the crate's loader
//! answers every recorded environment as `env.ts` did, a blank owner value loading as unset.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

const COMPOSE: &str = include_str!("../../../docker-compose.apps.yml");

/// `composeServiceBlock(compose, name)`: the service's lines, up to the next top-level service.
fn block(name: &str) -> String {
    let lines: Vec<&str> = COMPOSE.split('\n').collect();
    let header = format!("  {name}:");
    let start = lines
        .iter()
        .position(|l| l.trim_end() == header)
        .unwrap_or_else(|| panic!("no {name} block in docker-compose.apps.yml"));
    let mut end = start + 1;
    while end < lines.len() && (lines[end].trim().is_empty() || lines[end].starts_with("   ")) {
        end += 1;
    }
    lines[start..end].join("\n")
}

/// Lines that are exactly `line` (trimmed).
fn count(haystack: &str, line: &str) -> usize {
    haystack.lines().filter(|l| l.trim() == line).count()
}

/// Lines that assign `key` (`<indent>KEY:`).
fn assignments(haystack: &str, key: &str) -> usize {
    let lead = format!("{key}:");
    haystack
        .lines()
        .filter(|l| l.starts_with(' ') && l.trim_start().starts_with(&lead))
        .count()
}

#[test]
fn compose_runs_the_rust_binary_on_4016_after_its_own_migrations() {
    let b = block("svc-academy");
    for line in [
        "image: intafaced/svc-academy:dev",
        "dockerfile: crates/svc-academy/Dockerfile",
        "command: ['/app/svc-academy']",
        "SERVICE_NAME: svc-academy",
        "HTTP_PORT: '4016'",
        "expose: ['4016']",
        "TOKEN_URL: http://svc-token:4003",
        "IDENTITY_URL: http://svc-identity:4002",
        "TRADE_URL: http://svc-trade:4004",
        "LEDGER_URL: http://svc-ledger:4001",
        "DATABASE_URL: postgres://svc_academy:${SVC_ACADEMY_DB_PASSWORD:-svc_academy}@postgres:5432/intafaced",
        "test: ['CMD', 'curl', '-fsS', 'http://127.0.0.1:4016/health']",
    ] {
        assert_eq!(
            count(&b, line),
            1,
            "svc-academy's block holds `{line}` once"
        );
    }
    // The fleet's shared env and both secrets, as every service gets them; never the Node image or its entry point.
    assert_eq!(
        count(&b, "<<: [*service-env, *edge-secret, *internal-secret]"),
        1
    );
    assert!(!b.contains("<<: *app"), "svc-academy is not the Node image");
    assert!(!b.contains("services/svc-academy"), "no TypeScript entry");
    // It starts after its schema is migrated and the bus is up.
    assert!(b.contains("svc-academy-migrate:\n        condition: service_completed_successfully"));
    assert!(b.contains("postgres:\n        condition: service_healthy"));
    assert!(b.contains("<<: *needs-bus"));
    // The ones that call it reach it on 4016.
    assert!(count(COMPOSE, "ACADEMY_URL: http://svc-academy:4016") >= 1);

    let m = block("svc-academy-migrate");
    for line in [
        "image: intafaced/svc-academy:dev",
        "dockerfile: crates/svc-academy/Dockerfile",
        "restart: 'no'",
        "command: ['/app/svc-academy', 'migrate']",
        "DATABASE_URL: postgres://svc_academy:${SVC_ACADEMY_DB_PASSWORD:-svc_academy}@postgres:5432/intafaced",
    ] {
        assert_eq!(
            count(&m, line),
            1,
            "svc-academy-migrate's block holds `{line}` once"
        );
    }
}

#[test]
fn the_dockerfile_builds_this_crate_and_runs_it_as_non_root() {
    let d = include_str!("../Dockerfile");
    assert!(d.contains("cargo build --release --locked -p svc-academy"));
    assert!(d.contains("COPY --from=build /svc-academy /app/svc-academy"));
    assert!(d.contains("USER nobody"));
    assert!(d.contains("CMD [\"/app/svc-academy\"]"));
    // curl is what the compose healthcheck runs.
    assert!(d.contains("curl"));
}

// ── stream/livekit-compose-pin.test.ts ──────────────────────────────────────────────────────────────────────────────

#[test]
fn ships_a_livekit_service_while_keeping_the_blank_provider_mode_refuse_closed() {
    let livekit = block("livekit");
    assert!(livekit.contains("image: livekit/livekit-server:"));
    assert_eq!(
        count(
            COMPOSE,
            "ACADEMY_STREAM_PROVIDER: ${ACADEMY_STREAM_PROVIDER:-none}"
        ),
        1
    );
    assert_eq!(count(COMPOSE, "LIVEKIT_URL: ${LIVEKIT_URL:-}"), 1);
}

// ── access/max-room-capacity-compose-pin.test.ts ────────────────────────────────────────────────────────────────────

#[test]
fn the_room_capacity_is_one_empty_pass_through_never_5000() {
    let b = block("svc-academy");
    assert_eq!(
        count(
            &b,
            "ACADEMY_MAX_ROOM_CAPACITY: ${ACADEMY_MAX_ROOM_CAPACITY:-}"
        ),
        1
    );
    assert_eq!(assignments(COMPOSE, "ACADEMY_MAX_ROOM_CAPACITY"), 1);
    assert!(!COMPOSE.contains("${ACADEMY_MAX_ROOM_CAPACITY:-5000}"));
    // The sibling pins are not restamped.
    for line in [
        "JWT_ACCESS_TTL_SECONDS: ${JWT_ACCESS_TTL_SECONDS:-900}",
        "ACADEMY_STREAM_PROVIDER: ${ACADEMY_STREAM_PROVIDER:-none}",
        "ACADEMY_PAPER_TRADING_ENABLED: ${ACADEMY_PAPER_TRADING_ENABLED:-true}",
        "ACADEMY_TOURNAMENT_ENABLED: ${ACADEMY_TOURNAMENT_ENABLED:-true}",
        "ACADEMY_VIDEO_URL_TTL_SECONDS: ${ACADEMY_VIDEO_URL_TTL_SECONDS:-}",
    ] {
        assert_eq!(count(&b, line), 1, "{line}");
    }
}

// ── jwt-access-ttl-issuer-audience-compose-pin.test.ts ──────────────────────────────────────────────────────────────

#[test]
fn passes_the_access_token_ttl_issuer_and_audience_once_with_identitys_defaults() {
    let b = block("svc-academy");
    for line in [
        "JWT_ACCESS_TTL_SECONDS: ${JWT_ACCESS_TTL_SECONDS:-900}",
        "JWT_ISSUER: ${JWT_ISSUER:-intafaced}",
        "JWT_AUDIENCE: ${JWT_AUDIENCE:-intafaced.api}",
    ] {
        assert_eq!(count(&b, line), 1, "{line}");
    }
    for key in [
        "JWT_ACCESS_TTL_SECONDS",
        "JWT_ISSUER",
        "JWT_AUDIENCE",
        "TOKEN_URL",
        "IDENTITY_URL",
        "ACADEMY_STREAM_PROVIDER",
        "ACADEMY_MAX_ROOM_CAPACITY",
        "ACADEMY_PAPER_TRADING_ENABLED",
        "ACADEMY_TOURNAMENT_ENABLED",
    ] {
        assert_eq!(assignments(&b, key), 1, "{key} is assigned once");
    }
    assert_eq!(
        assignments(&b, "JWT_ACCESS_SECRET"),
        0,
        "no access secret here"
    );
    for line in [
        "LIVEKIT_URL: ${LIVEKIT_URL:-}",
        "LIVEKIT_API_KEY: ${LIVEKIT_API_KEY:-}",
        "LIVEKIT_API_SECRET: ${LIVEKIT_API_SECRET:-}",
    ] {
        assert_eq!(count(&b, line), 1, "{line}");
    }
}
