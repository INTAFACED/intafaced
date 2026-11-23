//! How svc-ledger is started: the fleet's compose file runs this crate's binary in its own image, after its own
//! `migrate` one-shot, with the owner's blanks left blank. It holds the pins the TypeScript service's tests held on how
//! it was started: `posting-compose-pin.test.ts`, `reconcile-cron-compose-pin.test.ts`, `operator-jwt-compose-pin.test.ts`
//! and `s2s-hmac-require-pin.test.ts`. Their checks on `env.ts` are held here on `src/env.rs`'s source and, for what
//! each field loads as, by `env_parity.rs` (every recorded environment answered as `env.ts` did).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

const COMPOSE: &str = include_str!("../../../docker-compose.apps.yml");
const ENV_RS: &str = include_str!("../src/env.rs");
const MAIN_RS: &str = include_str!("../src/main.rs");

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

/// The source with `//` comments dropped, so a commented-out line proves nothing.
fn live(src: &str) -> String {
    src.lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn compose_runs_the_rust_binary_on_4001_after_its_own_migrations() {
    let b = block("svc-ledger");
    for line in [
        "image: intafaced/svc-ledger:dev",
        "dockerfile: crates/svc-ledger/Dockerfile",
        "command: ['/app/svc-ledger']",
        "SERVICE_NAME: svc-ledger",
        "HTTP_PORT: '4001'",
        "expose: ['4001']",
        "DATABASE_URL: postgres://svc_ledger:${SVC_LEDGER_DB_PASSWORD:-svc_ledger}@postgres:5432/intafaced",
        "test: ['CMD', 'curl', '-fsS', 'http://127.0.0.1:4001/health']",
    ] {
        assert_eq!(count(&b, line), 1, "svc-ledger's block holds `{line}` once");
    }
    assert_eq!(count(&b, "<<: [*service-env, *internal-secret]"), 1);
    assert!(!b.contains("<<: *app"), "svc-ledger is not the Node image");
    assert!(!b.contains("services/svc-ledger"), "no TypeScript entry");
    assert!(b.contains("svc-ledger-migrate:\n        condition: service_completed_successfully"));
    assert!(b.contains("postgres:\n        condition: service_healthy"));
    assert!(b.contains("<<: *needs-bus"));

    let m = block("svc-ledger-migrate");
    for line in [
        "image: intafaced/svc-ledger:dev",
        "command: ['/app/svc-ledger', 'migrate']",
        "restart: 'no'",
        "DATABASE_URL: postgres://svc_ledger:${SVC_LEDGER_DB_PASSWORD:-svc_ledger}@postgres:5432/intafaced",
    ] {
        assert_eq!(count(&m, line), 1, "svc-ledger-migrate holds `{line}` once");
    }
}

/// `posting-compose-pin.test.ts`: the posting switch reaches the container, never defaulted off; the operator secret
/// refuses boot when unset; the shared secret comes only from the anchor.
#[test]
fn the_posting_switch_reaches_the_container_and_is_never_defaulted_off() {
    let b = block("svc-ledger");
    assert_eq!(
        count(
            &b,
            "LEDGER_POSTING_ENABLED: ${LEDGER_POSTING_ENABLED:-true}"
        ),
        1
    );
    assert_eq!(assignments(&b, "LEDGER_POSTING_ENABLED"), 1);
    assert!(!b.contains("${LEDGER_POSTING_ENABLED:-false}"));
    assert_eq!(
        count(
            &b,
            "JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET:?missing — copy .env.example to .env}"
        ),
        1
    );
    assert!(
        !b.contains("${JWT_ACCESS_SECRET:-"),
        "no silent default for the operator secret"
    );
    assert_eq!(
        assignments(&b, "INTERNAL_SERVICE_SECRET"),
        0,
        "only *internal-secret sets it"
    );
    // env.rs: unset is on (`.default(true)`).
    assert!(ENV_RS.contains(".get(\"LEDGER_POSTING_ENABLED\")\n        .is_none_or("));
}

/// `reconcile-cron-compose-pin.test.ts`: the owner's cadence passes through blank, and a blank refuses boot.
#[test]
fn the_reconcile_cadence_passes_through_blank_and_is_never_invented() {
    let b = block("svc-ledger");
    assert_eq!(
        count(&b, "RECONCILE_CRON_MINUTES: ${RECONCILE_CRON_MINUTES:-}"),
        1
    );
    assert_eq!(assignments(&b, "RECONCILE_CRON_MINUTES"), 1);
    assert!(!b.contains("${RECONCILE_CRON_MINUTES:-60}"));
    assert_eq!(
        assignments(COMPOSE, "RECONCILE_CRON_MINUTES"),
        1,
        "set for svc-ledger only"
    );
    // env.rs: blank is unset, unset refuses, at least 1 minute; no default.
    assert!(ENV_RS.contains("o.blank_int(\"RECONCILE_CRON_MINUTES\", None, 1, None);"));
}

/// `operator-jwt-compose-pin.test.ts`: the operator token's lifetime, issuer, audience and refresh reach the container
/// with the loader's own defaults.
#[test]
fn the_operator_token_settings_reach_the_container_with_the_loaders_defaults() {
    let b = block("svc-ledger");
    for line in [
        "JWT_ACCESS_TTL_SECONDS: ${JWT_ACCESS_TTL_SECONDS:-900}",
        "JWT_ISSUER: ${JWT_ISSUER:-intafaced}",
        "JWT_AUDIENCE: ${JWT_AUDIENCE:-intafaced.api}",
        "JWT_REFRESH_TTL_SECONDS: ${JWT_REFRESH_TTL_SECONDS:-2592000}",
    ] {
        assert_eq!(count(&b, line), 1, "svc-ledger's block holds `{line}` once");
    }
    for key in [
        "JWT_ACCESS_TTL_SECONDS",
        "JWT_ISSUER",
        "JWT_AUDIENCE",
        "JWT_REFRESH_TTL_SECONDS",
    ] {
        assert_eq!(assignments(&b, key), 1, "{key} is set once");
    }
    // env.rs: the same defaults as authEnvSchema.
    for decl in [
        "o.int(\"JWT_ACCESS_TTL_SECONDS\", (900, Some(60), Some(3600)));",
        "o.string(\"JWT_ISSUER\", \"intafaced\");",
        "o.string(\"JWT_AUDIENCE\", \"intafaced.api\");",
        "(60 * 60 * 24 * 30, Some(3600), Some(60 * 60 * 24 * 90)),",
    ] {
        assert!(ENV_RS.contains(decl), "env.rs declares `{decl}`");
    }
}

/// `s2s-hmac-require-pin.test.ts`: the door the binary serves binds every signed body, whatever the environment says.
#[test]
fn the_served_door_requires_body_bound_signatures() {
    let main = live(MAIN_RS);
    assert_eq!(main.matches("body_bind: BodyBind::Require,").count(), 1);
    assert!(
        !main.contains("INTERNAL_SERVICE_BODY_BIND"),
        "never read from the environment"
    );
    assert!(!main.contains("BodyBind::AcceptBoth"));
}
