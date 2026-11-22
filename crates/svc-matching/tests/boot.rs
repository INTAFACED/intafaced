//! How svc-matching is started: the fleet's compose file runs this crate's binary in its own image, on the journal
//! volume, with the owner's blanks left blank. It holds the pins the TypeScript service's tests held on how it was
//! started: `engine-kill-switch-compose-pin.test.ts`, `journal-path-compose-pin.test.ts`,
//! `snapshot-every-compose-pin.test.ts`, `hmac-body-bind-require-pin.test.ts`, the compose test of
//! `operator-desk.router.test.ts`, and the config half of `observability-wiring.test.ts` (its live scrape is
//! `serve.rs`'s). Their checks on `env.ts` are held here on `src/env.rs`'s source and, for what each field loads as, by
//! `env_parity.rs` (every recorded environment answered as `env.ts` did).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

const COMPOSE: &str = include_str!("../../../docker-compose.apps.yml");
const PROMETHEUS: &str = include_str!("../../../tooling/infra/prometheus.yaml");
const DOCKERFILE: &str = include_str!("../Dockerfile");
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
fn compose_runs_the_rust_binary_on_4005_with_the_journal_volume() {
    let b = block("svc-matching");
    for line in [
        "image: intafaced/svc-matching:dev",
        "dockerfile: crates/svc-matching/Dockerfile",
        "command: ['/app/svc-matching']",
        "SERVICE_NAME: svc-matching",
        "HTTP_PORT: '4005'",
        "expose: ['4005']",
        "- matchingjournal:/data/matching",
        "test: ['CMD', 'curl', '-fsS', 'http://127.0.0.1:4005/health']",
        "LEDGER_URL: http://svc-ledger:4001",
    ] {
        assert_eq!(
            count(&b, line),
            1,
            "svc-matching's block holds `{line}` once"
        );
    }
    assert!(
        !b.contains("<<: *app"),
        "svc-matching is not the Node image"
    );
    assert!(!b.contains("services/svc-matching"), "no TypeScript entry");
    assert!(
        !b.contains("DATABASE_URL"),
        "the engine has no database, only its journal"
    );
    assert!(b.contains("<<: *needs-bus"));
    assert!(b.contains("svc-ledger:\n        condition: service_healthy"));
    // The image can write the journal's directory, as the uid that wrote it under the Node image.
    assert!(DOCKERFILE.contains("RUN mkdir -p /data/matching && chown -R 1000:1000 /data"));
    assert!(DOCKERFILE.contains("USER 1000:1000"));
    assert!(DOCKERFILE.contains("cargo build --release --locked -p svc-matching"));
}

/// `journal-path-compose-pin.test.ts`: the host can pin the journal the engine replays; its default is the volume.
#[test]
fn the_journal_path_passes_through_with_the_volume_default() {
    let b = block("svc-matching");
    assert_eq!(
        count(
            &b,
            "MATCHING_JOURNAL_PATH: ${MATCHING_JOURNAL_PATH:-/data/matching/engine_journal.ndjson}"
        ),
        1
    );
    assert_eq!(assignments(COMPOSE, "MATCHING_JOURNAL_PATH"), 1);
    assert_eq!(assignments(&b, "MATCHING_JOURNAL_PATH"), 1);
    assert_eq!(
        count(
            &b,
            "MATCHING_JOURNAL_PATH: /data/matching/engine_journal.ndjson"
        ),
        0,
        "a hard-coded path no host pin reaches"
    );
}

/// `engine-kill-switch-compose-pin.test.ts`: the host can halt the engine; compose defaults it off with the custody
/// switch off, and the engine itself leaves an unset switch to custody (OWNER 288).
#[test]
fn the_engine_switch_reaches_the_container_defaulted_off_with_custody_off() {
    let b = block("svc-matching");
    assert_eq!(
        count(
            &b,
            "MATCHING_ENGINE_ENABLED: ${MATCHING_ENGINE_ENABLED:-false}"
        ),
        1
    );
    assert!(!b.contains("${MATCHING_ENGINE_ENABLED:-true}"));
    assert_eq!(
        count(&b, "LEDGER_CUSTODY_LAYER: ${LEDGER_CUSTODY_LAYER:-off}"),
        1
    );
    assert_eq!(assignments(COMPOSE, "MATCHING_ENGINE_ENABLED"), 1);
    assert_eq!(assignments(&b, "MATCHING_ENGINE_ENABLED"), 1);
    assert_eq!(
        assignments(&b, "INTERNAL_SERVICE_SECRET"),
        0,
        "only *internal-secret sets it"
    );
    // env.rs: an unset switch follows the custody switch (`resolveOwnOrderBook`), never a default of its own.
    assert!(
        live(ENV_RS)
            .contains("resolve_own_order_book(\"MATCHING_ENGINE_ENABLED\", asked, custody)")
    );
}

/// `snapshot-every-compose-pin.test.ts`: the owner's cadence passes through blank, never an invented 500, and a blank
/// refuses boot.
#[test]
fn the_snapshot_cadence_passes_through_blank_and_is_never_invented() {
    let b = block("svc-matching");
    assert_eq!(
        count(&b, "MATCHING_SNAPSHOT_EVERY: ${MATCHING_SNAPSHOT_EVERY:-}"),
        1
    );
    assert!(!b.contains("${MATCHING_SNAPSHOT_EVERY:-500}"));
    assert_eq!(assignments(COMPOSE, "MATCHING_SNAPSHOT_EVERY"), 1);
    assert_eq!(
        assignments(&b, "MATCHING_RULEBOOK_VERSION"),
        0,
        "the journal is the rulebook's source"
    );
    // env.rs: a blank cadence reads as `NaN`, which no integer check passes, so it refuses; no default.
    assert!(live(ENV_RS).contains("o.f.blank(\"MATCHING_SNAPSHOT_EVERY\").unwrap_or(\"NaN\")"));
}

/// The compose test of `operator-desk.router.test.ts`: the founder door verifies the edge principal and holds no JWT
/// secret.
#[test]
fn the_founder_door_takes_the_edge_secret_and_no_jwt_secret() {
    let b = block("svc-matching");
    assert_eq!(
        count(&b, "<<: [*service-env, *internal-secret, *edge-secret]"),
        1
    );
    assert!(!b.contains("JWT_ACCESS_SECRET"));
}

/// `hmac-body-bind-require-pin.test.ts`: order writes refuse an unbound v1 signature whatever the fleet's
/// `INTERNAL_SERVICE_BODY_BIND` says.
#[test]
fn the_doors_require_a_body_bound_signature_whatever_the_fleet_default() {
    let main = live(MAIN_RS);
    assert_eq!(main.matches("body_bind: BodyBind::Require,").count(), 1);
    assert!(!main.contains("INTERNAL_SERVICE_BODY_BIND"));
}

/// `observability-wiring.test.ts`: the scrape job reaches the compose service on the port it listens on, at the path
/// it serves, with no label the exposition already carries.
#[test]
fn the_scrape_job_reaches_the_port_and_path_the_service_serves() {
    let lines: Vec<&str> = PROMETHEUS.lines().collect();
    let starts: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.trim() == "- job_name: svc-matching")
        .map(|(i, _)| i)
        .collect();
    assert_eq!(starts.len(), 1, "one svc-matching scrape job");
    let job: Vec<&str> = lines[starts[0] + 1..]
        .iter()
        .take_while(|l| l.starts_with("    ") || l.trim().is_empty())
        .copied()
        .collect();
    let job = job.join("\n");
    assert_eq!(
        count(
            &job,
            &format!("metrics_path: {}", service_kit::metrics::METRICS_PATH)
        ),
        1
    );
    assert_eq!(count(&job, "- targets: ['svc-matching:4005']"), 1);
    assert!(!job.contains("localhost") && !job.contains("127.0.0.1"));
    assert!(
        !job.contains("labels:"),
        "the exposition carries its own labels"
    );
    assert!(COMPOSE.contains("\n  svc-matching:\n"));
    assert_eq!(count(&block("svc-matching"), "HTTP_PORT: '4005'"), 1);
}
