//! `tests/fixtures/ops-approval.golden.json`: what svc-bank binds an operator's approval to, as this crate computes it.
//! The console (`apps/admin/src/lib/desk/approval-hash.test.ts`) and the local stack's gates
//! (`tooling/scripts/local-test-gates.test.mjs`) propose approvals svc-bank must accept; each holds its own hash to this
//! file, and this test holds the file to the crate (`transfers::step_up::payload_hash`, `transfers::terms::publish_fields`,
//! `ramps::book::fraud::fields`).
//! A change to either function fails here until the file is rewritten (`WRITE_GOLDEN=1`), and then fails there until
//! the console and the gates follow.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use std::path::PathBuf;

use service_kit::json::Json;
use service_kit::money::parse_amount;
use svc_bank::ramps::book::fraud;
use svc_bank::transfers::step_up::payload_hash;
use svc_bank::transfers::terms::publish_fields;

const CARD: &str = "9f8e7d6c-1111-4222-8333-444455556666";

fn fields_json(fields: &[(String, String)]) -> Json {
    Json::Object(
        fields
            .iter()
            .map(|(k, v)| (k.clone(), Json::str(v.clone())))
            .collect(),
    )
}

fn pairs(fields: &[(&str, &str)]) -> Vec<(String, String)> {
    fields
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

/// The file as the crate makes it.
fn golden() -> Json {
    let vectors: Vec<(&str, Vec<(String, String)>)> = vec![
        ("bank.ops.x", pairs(&[("fee", "0"), ("assetId", "USDT")])),
        (
            "bank.ops.x",
            pairs(&[
                ("reason", "LOCAL TEST: x"),
                ("address", "0xabc"),
                ("network", "*"),
            ]),
        ),
        ("bank.ops.x", Vec::new()),
        (
            "bank.ops.setCardStatus",
            pairs(&[("cardId", CARD), ("status", "frozen")]),
        ),
        (
            "bank.ops.setCardStatus",
            pairs(&[("cardId", CARD), ("status", "active")]),
        ),
        (
            "bank.ops.requestCardProgrammeFunding",
            pairs(&[("kind", "fund"), ("amount", "1000"), ("threshold", "")]),
        ),
        (
            "bank.ops.requestCardProgrammeFunding",
            pairs(&[
                ("kind", "auto_reload"),
                ("amount", "1000"),
                ("threshold", "500"),
            ]),
        ),
    ];
    let hashes = vectors
        .iter()
        .map(|(action, fields)| {
            Json::obj([
                ("actionType", Json::str(*action)),
                ("fields", fields_json(fields)),
                ("payloadHash", Json::str(payload_hash(action, fields))),
            ])
        })
        .collect();
    // The local stack's TEST transfer terms (local-test-gates.mjs `TEST_TRANSFER_TERMS`) as `ops.publishTransferTerms`
    // binds them.
    let terms = [("USDT", "1000", "5000", "0"), ("USDC", "1000", "5000", "0")]
        .iter()
        .map(|(asset, per, daily, fee)| {
            let fields = publish_fields(
                asset,
                parse_amount(per).unwrap(),
                parse_amount(daily).unwrap(),
                parse_amount(fee).unwrap(),
            );
            Json::obj([
                (
                    "input",
                    Json::obj([
                        ("assetId", Json::str(*asset)),
                        ("perTransferLimit", Json::str(*per)),
                        ("dailyLimit", Json::str(*daily)),
                        ("fee", Json::str(*fee)),
                    ]),
                ),
                ("actionType", Json::str("bank.ops.publishTransferTerms")),
                ("fields", fields_json(&fields)),
                (
                    "payloadHash",
                    Json::str(payload_hash("bank.ops.publishTransferTerms", &fields)),
                ),
            ])
        })
        .collect();
    // The fraud list's changes (`ops.setDestinationFraudListing`): the fields the approval is bound to, normalised, for
    // the gates' cases and the local stack's TEST listing (local-test-gates.mjs `TEST_FRAUD_LIST`).
    let fraud_cases: [(&str, &str, bool, i64, &str); 3] = [
        (
            "*",
            "0x7E5700000000000000000000000000000000FA1D",
            true,
            0,
            " LOCAL TEST: x ",
        ),
        ("Base", "bc1Qx", false, 2, "LOCAL TEST: y"),
        (
            "*",
            "0x7e5700000000000000000000000000000000fa1d",
            true,
            0,
            "LOCAL TEST: J-wallet-05 #2 fraud-listed address",
        ),
    ];
    let fraud_list = fraud_cases
        .iter()
        .map(|(network, address, listed, expected_revision, reason)| {
            let fields = fraud::fields(&fraud::Change {
                network,
                address,
                listed: *listed,
                expected_revision: *expected_revision,
                reason,
            })
            .unwrap();
            Json::obj([
                (
                    "input",
                    Json::obj([
                        ("network", Json::str(*network)),
                        ("address", Json::str(*address)),
                        ("listed", Json::Bool(*listed)),
                        ("expectedRevision", Json::int(*expected_revision)),
                        ("reason", Json::str(*reason)),
                    ]),
                ),
                ("actionType", Json::str(fraud::SET_ACTION)),
                ("fields", fields_json(&fields)),
                (
                    "payloadHash",
                    Json::str(payload_hash(fraud::SET_ACTION, &fields)),
                ),
            ])
        })
        .collect();
    Json::obj([
        // What every bank ops approval is consumed against (`ops_approval::consume`).
        (
            "consume",
            Json::obj([
                ("targetService", Json::str("svc-bank")),
                ("targetId", Json::str("the action type")),
                ("expectedVersion", Json::str("1")),
            ]),
        ),
        ("hashes", Json::Array(hashes)),
        ("transferTerms", Json::Array(terms)),
        ("fraudList", Json::Array(fraud_list)),
    ])
}

#[test]
fn the_golden_file_is_what_the_crate_binds_an_approval_to() {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ops-approval.golden.json");
    let want = format!("{}\n", golden().pretty());
    if std::env::var("WRITE_GOLDEN").is_ok_and(|v| v == "1") {
        std::fs::write(&path, &want).unwrap();
    }
    let have = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        have == want,
        "{} is not what svc-bank binds approvals to: rerun with WRITE_GOLDEN=1, then make the console and the gates follow",
        path.display()
    );
}
