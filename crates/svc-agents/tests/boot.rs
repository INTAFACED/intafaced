//! How svc-agents is started: the fleet's compose file runs this crate's binary in its own image, after its own
//! `migrate` one-shot, with the owner's blanks left blank. It holds the pins the TypeScript service's tests held on how
//! it was started: `academy-url-compose-pin.test.ts`, `identity-url-compose-pin.test.ts`,
//! `jwt-access-ttl-issuer-audience-compose-pin.test.ts`, `oplog/compose-pin.test.ts`,
//! `upstream-auth-header-prefix-compose-pin.test.ts` and `usage-window-timeout-compose-pin.test.ts`. Their checks on
//! `env.ts` are held here on `src/env.rs`'s source and, for what each field loads as, by `env_parity.rs` (every
//! recorded environment answered as `env.ts` did).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

const COMPOSE: &str = include_str!("../../../docker-compose.apps.yml");
const ENV_EXAMPLE: &str = include_str!("../../../.env.example");
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
fn compose_runs_the_rust_binary_on_4008_after_its_own_migrations() {
    let b = block("svc-agents");
    for line in [
        "image: intafaced/svc-agents:dev",
        "dockerfile: crates/svc-agents/Dockerfile",
        "command: ['/app/svc-agents']",
        "SERVICE_NAME: svc-agents",
        "HTTP_PORT: '4008'",
        "expose: ['4008']",
        "DATABASE_URL: postgres://svc_agents:${SVC_AGENTS_DB_PASSWORD:-svc_agents}@postgres:5432/intafaced",
        "test: ['CMD', 'curl', '-fsS', 'http://127.0.0.1:4008/health']",
    ] {
        assert_eq!(count(&b, line), 1, "svc-agents' block holds `{line}` once");
    }
    assert_eq!(
        count(&b, "<<: [*service-env, *edge-secret, *internal-secret]"),
        1
    );
    assert!(!b.contains("<<: *app"), "svc-agents is not the Node image");
    assert!(!b.contains("services/svc-agents"), "no TypeScript entry");
    assert!(b.contains("svc-agents-migrate:\n        condition: service_completed_successfully"));
    assert!(b.contains("postgres:\n        condition: service_healthy"));
    assert!(b.contains("svc-ledger:\n        condition: service_healthy"));
    assert!(b.contains("<<: *needs-bus"));

    let m = block("svc-agents-migrate");
    for line in [
        "image: intafaced/svc-agents:dev",
        "command: ['/app/svc-agents', 'migrate']",
        "restart: 'no'",
        "DATABASE_URL: postgres://svc_agents:${SVC_AGENTS_DB_PASSWORD:-svc_agents}@postgres:5432/intafaced",
    ] {
        assert_eq!(count(&m, line), 1, "svc-agents-migrate holds `{line}` once");
    }
}

/// `academy-url-compose-pin.test.ts` and `identity-url-compose-pin.test.ts`: the Coach's curriculum, identity and the
/// ledger are each pinned once on the fleet network; the ledger is required with no localhost default, identity is
/// optional with none.
#[test]
fn the_outside_services_are_pinned_once_and_never_guessed() {
    let b = block("svc-agents");
    for (key, line) in [
        ("ACADEMY_URL", "ACADEMY_URL: http://svc-academy:4016"),
        ("IDENTITY_URL", "IDENTITY_URL: http://svc-identity:4002"),
        ("LEDGER_URL", "LEDGER_URL: http://svc-ledger:4001"),
    ] {
        assert_eq!(count(&b, line), 1, "svc-agents' block holds `{line}` once");
        assert_eq!(assignments(&b, key), 1, "{key} is set once");
    }
    assert!(!b.contains("localhost:4001"));
    // env.rs: LEDGER_URL is a required URL; IDENTITY_URL is among the optional URLs; no localhost default.
    let env = live(ENV_RS);
    assert!(env.contains("o.url(\"LEDGER_URL\");"));
    assert!(env.contains(
        "for k in [\"IDENTITY_URL\", \"ACADEMY_URL\", \"SUPPORT_URL\", \"TRADE_URL\"] {"
    ));
    assert!(!env.contains("localhost:4001") && !env.contains("localhost:4002"));
    // main.rs: the ledger client is built from LEDGER_URL only; a blank IDENTITY_URL builds no identity port.
    let main = live(MAIN_RS);
    assert!(main.contains("&str_of(\"LEDGER_URL\")"));
    assert!(main.contains("env.str(\"IDENTITY_URL\").filter(|u| !u.is_empty())"));
    assert!(!main.contains("localhost:4001") && !main.contains("localhost:4002"));
}

/// `jwt-access-ttl-issuer-audience-compose-pin.test.ts` and `upstream-auth-header-prefix-compose-pin.test.ts`: each
/// reaches the container once with the loader's default; no operator signing secret is invented for this service.
#[test]
fn the_token_settings_and_the_upstream_auth_reach_the_container_with_the_loaders_defaults() {
    let b = block("svc-agents");
    for (key, line) in [
        (
            "JWT_ACCESS_TTL_SECONDS",
            "JWT_ACCESS_TTL_SECONDS: ${JWT_ACCESS_TTL_SECONDS:-900}",
        ),
        ("JWT_ISSUER", "JWT_ISSUER: ${JWT_ISSUER:-intafaced}"),
        (
            "JWT_AUDIENCE",
            "JWT_AUDIENCE: ${JWT_AUDIENCE:-intafaced.api}",
        ),
        (
            "AGENTS_UPSTREAM_AUTH_HEADER",
            "AGENTS_UPSTREAM_AUTH_HEADER: ${AGENTS_UPSTREAM_AUTH_HEADER:-x-api-key}",
        ),
        (
            "AGENTS_UPSTREAM_AUTH_PREFIX",
            "AGENTS_UPSTREAM_AUTH_PREFIX: ${AGENTS_UPSTREAM_AUTH_PREFIX:-}",
        ),
    ] {
        assert_eq!(count(&b, line), 1, "svc-agents' block holds `{line}` once");
        assert_eq!(assignments(&b, key), 1, "{key} is set once");
    }
    assert_eq!(
        assignments(&b, "JWT_ACCESS_SECRET"),
        0,
        "agents trusts the edge, it signs no token"
    );
    let env = live(ENV_RS);
    assert!(env.contains("o.string(\"AGENTS_UPSTREAM_AUTH_HEADER\", \"x-api-key\");"));
    assert!(env.contains("o.string(\"AGENTS_UPSTREAM_AUTH_PREFIX\", \"\");"));
}

/// `usage-window-timeout-compose-pin.test.ts`: the billing window and the metering switch refuse `compose up` when
/// unset (never 60, never true); the timeout is 60000; the fee asset is required in env.rs; the provider stays `mock`.
#[test]
fn the_billing_window_and_the_metering_switch_are_never_invented() {
    let b = block("svc-agents");
    for line in [
        "AGENTS_USAGE_WINDOW_MINUTES: ${AGENTS_USAGE_WINDOW_MINUTES:?missing — copy .env.example to .env}",
        "AGENTS_METERING_ENABLED: ${AGENTS_METERING_ENABLED:?missing — copy .env.example to .env}",
        "AGENTS_UPSTREAM_TIMEOUT_MS: ${AGENTS_UPSTREAM_TIMEOUT_MS:-60000}",
        "AGENTS_PROVIDER: ${AGENTS_PROVIDER:-mock}",
        "AGENTS_FEE_ASSET_ID: ${AGENTS_FEE_ASSET_ID:-IFC}",
    ] {
        assert_eq!(count(&b, line), 1, "svc-agents' block holds `{line}` once");
    }
    assert_eq!(
        assignments(COMPOSE, "AGENTS_USAGE_WINDOW_MINUTES"),
        1,
        "set for svc-agents only"
    );
    assert_eq!(
        assignments(COMPOSE, "AGENTS_UPSTREAM_TIMEOUT_MS"),
        1,
        "set for svc-agents only"
    );
    assert!(
        !b.contains("AGENTS_METERING_ENABLED:-true")
            && !b.contains("AGENTS_USAGE_WINDOW_MINUTES:-60")
    );
    assert!(!b.contains("AGENTS_PROVIDER:-upstream"));
    for key in [
        "AGENTS_UPSTREAM_BASE_URL",
        "AGENTS_UPSTREAM_API_KEY",
        "AGENTS_UPSTREAM_HEADERS",
        "AGENTS_UPSTREAM_MODELS",
        "AGENTS_UPSTREAM_COMPLETIONS_PATH",
        "AGENTS_UPSTREAM_EMBEDDINGS_PATH",
        "AGENTS_ROUTING_TABLE",
    ] {
        assert_eq!(count(&b, &format!("{key}:")), 1, "{key} is passed key-only");
    }
    let env = live(ENV_RS);
    assert!(
        env.contains("o.issue(\"AGENTS_METERING_ENABLED\", \"agents.metering_enabled_unset\")")
    );
    assert!(env.contains("None => o.issue(\"AGENTS_FEE_ASSET_ID\", REQUIRED_STRING),"));
    assert!(env.contains("o.int(\"AGENTS_UPSTREAM_TIMEOUT_MS\", 1000, 600_000, Some(60_000));"));
    assert!(env.contains("int_issues(window, 1, 1440)") && env.contains("1440 % n != 0"));
}

/// `oplog/compose-pin.test.ts`: the operator log's three owner values are blank-is-unset in env.rs, passed key-only
/// once, and blank in `.env.example`.
#[test]
fn the_operator_log_owner_values_pass_through_blank() {
    let b = block("svc-agents");
    let env = live(ENV_RS);
    for (key, decl) in [
        (
            "AGENTS_LOG_READ_REASONS",
            "o.blank_string(\"AGENTS_LOG_READ_REASONS\", false, None);",
        ),
        (
            "AGENTS_OPS_ACTIONS_LIMIT",
            "o.blank_int(\"AGENTS_OPS_ACTIONS_LIMIT\", 1, 500);",
        ),
        (
            "AGENTS_TRANSCRIPT_RETENTION_DAYS",
            "o.blank_int(\"AGENTS_TRANSCRIPT_RETENTION_DAYS\", 0, 3650);",
        ),
    ] {
        assert!(env.contains(decl), "env.rs declares `{decl}`");
        assert_eq!(assignments(&b, key), 1, "{key} is set once");
        assert_eq!(count(&b, &format!("{key}:")), 1, "{key} is passed key-only");
        let lines: Vec<&str> = ENV_EXAMPLE
            .lines()
            .filter(|l| l.trim_start_matches("# ").starts_with(&format!("{key}=")))
            .collect();
        assert_eq!(
            lines,
            [format!("# {key}=")],
            "{key} is blank in .env.example"
        );
    }
}
