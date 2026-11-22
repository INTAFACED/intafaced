//! Ported from the TypeScript service's `env-engine-enabled-kill-switch.test.ts`, `env-operator-ids-refuse-boot.test.ts`
//! and `env-snapshot-every-refuse-closed.test.ts`: the production loader (`svc_matching::env::load`, which the binary
//! calls at boot) refuses or parses each environment as those files assert. Each test is named after the `it` it ports,
//! prefixed with its file's topic (`kill`, `operators`, `snapshot`).
//!
//! Not ported, and why:
//! - `kill`, "boolean false disables and boolean true enables": the TypeScript hands `loadEnv` a JavaScript boolean.
//!   An environment here is text (`BTreeMap<String, String>`), so a boolean cannot reach the loader; the text
//!   tokens it stands for are proven below, and its custody-unset refusal is `kill_refuses_boot_...`.
//! - `snapshot`, "env.ts keeps the refuse-closed shape production loadEnv parses": a regular expression over
//!   `env.ts`'s source text. What it guarded (no invented `.default(500)`, blank is not 0) is held by behaviour:
//!   `snapshot_unset_...`, `snapshot_blank_...` and `snapshot_whitespace_...` below refuse, and
//!   `snapshot_explicit_0_...` parses 0.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;

use service_kit::json::Json;
use svc_matching::env::{self, MatchingEnv};

const SECRET: &str = "ssssssssssssssssssssssssssssssss";
const OPERATORS_FATAL: &str =
    "FATAL: MATCHING_OPERATOR_IDS must list at least two distinct operator user ids";
const ON_WITH_CUSTODY_OFF: &str = "MATCHING_ENGINE_ENABLED is on but LEDGER_CUSTODY_LAYER is off";

/// The minimum boot environment, then each override (`None` unsets the variable, as `vi.stubEnv(key, undefined)`).
fn source(base: &[(&str, &str)], overrides: &[(&str, Option<&str>)]) -> BTreeMap<String, String> {
    let mut vars: BTreeMap<String, String> = BTreeMap::new();
    vars.insert("NODE_ENV".to_owned(), "test".to_owned());
    vars.insert("INTERNAL_SERVICE_SECRET".to_owned(), SECRET.to_owned());
    for (k, v) in base {
        vars.insert((*k).to_owned(), (*v).to_owned());
    }
    for (k, v) in overrides {
        match v {
            Some(v) => vars.insert((*k).to_owned(), (*v).to_owned()),
            None => vars.remove(*k),
        };
    }
    vars
}

fn load(base: &[(&str, &str)], overrides: &[(&str, Option<&str>)]) -> Result<MatchingEnv, String> {
    env::load(&source(base, overrides)).map_err(|e| e.message)
}

fn refused(base: &[(&str, &str)], overrides: &[(&str, Option<&str>)]) -> String {
    match load(base, overrides) {
        Ok(e) => panic!("{overrides:?} booted: {}", e.json.compact()),
        Err(m) => m,
    }
}

fn enabled(e: &MatchingEnv) -> bool {
    match e.get("MATCHING_ENGINE_ENABLED") {
        Some(Json::Bool(b)) => *b,
        other => panic!("MATCHING_ENGINE_ENABLED is a boolean: {other:?}"),
    }
}

// ═══ env-engine-enabled-kill-switch.test.ts ═════════════════════════════

/// The kill switch cards' `BASE_ENV`: custody on, so they test the parser and nothing else.
const KILL_BASE: &[(&str, &str)] = &[
    ("LEDGER_CUSTODY_LAYER", "on"),
    ("MATCHING_SNAPSHOT_EVERY", "500"),
    ("MATCHING_OPERATOR_IDS", "op-a,op-b"),
];

fn kill(overrides: &[(&str, Option<&str>)]) -> Result<MatchingEnv, String> {
    load(KILL_BASE, overrides)
}

#[test]
fn kill_trims_kill_tokens_and_blank_or_whitespace_disables_the_engine() {
    for token in [
        "0", "false", "off", "no", "false ", "off ", "no ", " 0 ", " FALSE ", " OFF ", " NO ", "",
        "   ", "\t",
    ] {
        let loaded = kill(&[("MATCHING_ENGINE_ENABLED", Some(token))]).unwrap();
        assert!(!enabled(&loaded), "{token:?} left the engine on");
    }
}

#[test]
fn kill_with_custody_on_keeps_an_unset_value_enabled_and_trimmed_true_yes_on_1_enable() {
    let unset = kill(&[]).unwrap();
    assert!(enabled(&unset));
    for token in [
        "true", "yes", "on", "1", " true ", " yes ", " on ", " 1 ", "TRUE", "YES", "ON",
    ] {
        let loaded = kill(&[("MATCHING_ENGINE_ENABLED", Some(token))]).unwrap();
        assert!(enabled(&loaded), "{token:?} left the engine off");
    }
}

#[test]
fn kill_with_custody_off_or_unset_an_unset_value_leaves_our_own_engine_off() {
    for custody in [None, Some(""), Some("off"), Some(" OFF ")] {
        let loaded = kill(&[("LEDGER_CUSTODY_LAYER", custody)]).unwrap();
        assert!(
            !enabled(&loaded),
            "custody {custody:?} turned the engine on"
        );
        assert_eq!(
            loaded.str("LEDGER_CUSTODY_LAYER"),
            Some("off"),
            "{custody:?}"
        );
    }
}

#[test]
fn kill_refuses_boot_when_the_engine_is_set_on_with_custody_off_and_lets_the_kill_switch_stay_off()
{
    for token in ["true", "on", "1"] {
        let message = refused(
            KILL_BASE,
            &[
                ("LEDGER_CUSTODY_LAYER", Some("off")),
                ("MATCHING_ENGINE_ENABLED", Some(token)),
            ],
        );
        assert!(message.contains(ON_WITH_CUSTODY_OFF), "{token}: {message}");
    }
    // Custody unset is off too (the TypeScript's boolean `true` with custody undefined).
    let unset = refused(
        KILL_BASE,
        &[
            ("LEDGER_CUSTODY_LAYER", None),
            ("MATCHING_ENGINE_ENABLED", Some("true")),
        ],
    );
    assert!(unset.contains(ON_WITH_CUSTODY_OFF), "{unset}");
    let killed = kill(&[
        ("LEDGER_CUSTODY_LAYER", Some("off")),
        ("MATCHING_ENGINE_ENABLED", Some("false")),
    ])
    .unwrap();
    assert!(!enabled(&killed));
}

#[test]
fn kill_refuses_boot_on_a_custody_value_that_is_neither_on_nor_off() {
    let message = refused(KILL_BASE, &[("LEDGER_CUSTODY_LAYER", Some("true"))]);
    assert!(
        message.contains("LEDGER_CUSTODY_LAYER must be \"on\" or \"off\""),
        "{message}"
    );
}

// ═══ env-operator-ids-refuse-boot.test.ts ═══════════════════════════════

const OPERATORS_BASE: &[(&str, &str)] = &[("MATCHING_SNAPSHOT_EVERY", "500")];

fn operators(value: Option<&str>) -> Result<MatchingEnv, String> {
    load(OPERATORS_BASE, &[("MATCHING_OPERATOR_IDS", value)])
}

#[test]
fn operators_refuse_boot_unset_blank_whitespace_commas_one_id_and_the_same_id_twice() {
    for (label, value) in [
        ("unset", None),
        ("blank", Some("")),
        ("whitespace", Some("   ")),
        ("commas only", Some(" , ,")),
        ("one id", Some("aaaaaaaa-0000-4000-8000-00000000000a")),
        (
            "one id with a trailing comma",
            Some("aaaaaaaa-0000-4000-8000-00000000000a,"),
        ),
        ("the same id twice", Some("op-a,op-a")),
        (
            "the same id twice, different case and spacing",
            Some("OP-A , op-a"),
        ),
    ] {
        match operators(value) {
            Ok(e) => panic!("{label} booted: {}", e.json.compact()),
            Err(m) => assert!(m.contains(OPERATORS_FATAL), "{label}: {m}"),
        }
    }
}

#[test]
fn operators_two_distinct_ids_boot_whitespace_trimmed() {
    let env = operators(Some(
        " aaaaaaaa-0000-4000-8000-00000000000a ,\tbbbbbbbb-0000-4000-8000-00000000000b ",
    ))
    .unwrap();
    assert!(
        env.str("MATCHING_OPERATOR_IDS")
            .unwrap()
            .contains("bbbbbbbb")
    );
    // What the binary hands the door (`DoorConfig::operator_ids`), as `parseOperatorIds` reads it.
    assert_eq!(
        env.operator_ids(),
        vec![
            "aaaaaaaa-0000-4000-8000-00000000000a".to_owned(),
            "bbbbbbbb-0000-4000-8000-00000000000b".to_owned(),
        ]
    );
}

// ═══ env-snapshot-every-refuse-closed.test.ts ═══════════════════════════

const SNAPSHOT_BASE: &[(&str, &str)] = &[("MATCHING_OPERATOR_IDS", "op-a,op-b")];

fn snapshot(value: Option<&str>) -> Result<MatchingEnv, String> {
    load(SNAPSHOT_BASE, &[("MATCHING_SNAPSHOT_EVERY", value)])
}

fn snapshot_refused(value: Option<&str>) {
    match snapshot(value) {
        Ok(e) => panic!(
            "{value:?} booted with MATCHING_SNAPSHOT_EVERY {:?}",
            e.int("MATCHING_SNAPSHOT_EVERY")
        ),
        Err(m) => assert!(m.contains("MATCHING_SNAPSHOT_EVERY"), "{value:?}: {m}"),
    }
}

#[test]
fn snapshot_unset_matching_snapshot_every_refuses_no_invented_500() {
    snapshot_refused(None);
}

#[test]
fn snapshot_blank_matching_snapshot_every_refuses_empty_is_not_0() {
    snapshot_refused(Some(""));
}

#[test]
fn snapshot_whitespace_matching_snapshot_every_refuses() {
    snapshot_refused(Some("   "));
}

#[test]
fn snapshot_explicit_500_is_owner_published_not_invented() {
    assert_eq!(
        snapshot(Some("500"))
            .unwrap()
            .int("MATCHING_SNAPSHOT_EVERY"),
        Some(500)
    );
}

#[test]
fn snapshot_explicit_0_disables_snapshotting_owner_published_not_blank() {
    assert_eq!(
        snapshot(Some("0")).unwrap().int("MATCHING_SNAPSHOT_EVERY"),
        Some(0)
    );
}
