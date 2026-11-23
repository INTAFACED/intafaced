//! The operator-approval payload hash the founder console computes (`apps/admin/src/lib/desk/approval-hash.ts`) must be
//! the one svc-ledger consumes. `apps/admin/src/lib/desk/approval-hash.test.ts` holds the console to this table; this
//! test holds `approval::payload_hash` to the same table, so a change on either side fails one of the two.
#![allow(clippy::indexing_slicing, reason = "a test")]

use svc_ledger::approval::payload_hash;
use svc_ledger::desk::{ACCOUNT_METADATA_DELETE_ACTION, ACCOUNT_METADATA_DELETE_TARGET};

type Vector = (
    &'static str,
    &'static [(&'static str, &'static str)],
    &'static str,
);

const TABLE: [Vector; 9] = [
    // The stack's platform posting freeze (`POSTING_FREEZE_REASON`, tooling/scripts/local-test-gates.mjs), pinned there too.
    (
        "ledger.freeze",
        &[(
            "reason",
            "LOCAL TEST — not a real approval: platform posting freeze for a journey step",
        )],
        "sha256:75e03078ba5a7d6c65daafd26a9d40eb1ad8f0b1af47d76609c55bc44646b769",
    ),
    (
        "ledger.freeze",
        &[("reason", "reconciliation mismatch on USD")],
        "sha256:2508cfa0885caf3c32a493d0475e9bd1dc8fcbefb7d1856bde4f633d2f719cb8",
    ),
    (
        "ledger.unfreeze",
        &[],
        "sha256:465e5da4d26d18b0df079034b1ed4c1004cce88f549c4c9df87b1fa269250b3f",
    ),
    (
        "ledger.reconciliation_control.run",
        &[
            ("controlId", "0b4f6c2e-1111-4222-8333-444455556666"),
            ("asOf", "now"),
            ("margin", "unset"),
            ("reason", "LOCAL TEST run the USDT floor control"),
        ],
        "sha256:002aaed7508469211cec2969fbd0f82bbd2d36f0bd9e0b5932622943619bbfe2",
    ),
    (
        "ledger.reconciliation_control.run",
        &[
            ("controlId", "0b4f6c2e-1111-4222-8333-444455556666"),
            ("asOf", "2026-10-23T06:30:00.000Z"),
            ("margin", "0"),
            ("reason", "LOCAL TEST run the USDT floor control"),
        ],
        "sha256:f6395d16c634aacb4dec1b374417181e5f0b389da25158df8dd18084b95d002c",
    ),
    (
        "ledger.reconciliation_control.lifecycle",
        &[
            ("controlId", "0b4f6c2e-1111-4222-8333-444455556666"),
            ("lifecycle", "pause"),
            ("reason", "LOCAL TEST pause while the rail is down"),
        ],
        "sha256:8e7b2b388e2b5ef43900987d8404d1ae0dfe3baf900f787f0d2b246a1751b68e",
    ),
    (
        "ledger.reconciliation_control.lifecycle",
        &[
            ("controlId", "0b4f6c2e-1111-4222-8333-444455556666"),
            ("lifecycle", "resume"),
            ("reason", "LOCAL TEST pause while the rail is down"),
        ],
        "sha256:2ed9b841e1538ef3b2f355e2153f20aef097adc8649ec694884647be68019497",
    ),
    (
        "ledger.reconciliation_control.lifecycle",
        &[
            ("controlId", "0b4f6c2e-1111-4222-8333-444455556666"),
            ("lifecycle", "retire"),
            ("reason", "LOCAL TEST pause while the rail is down"),
        ],
        "sha256:341311d26cbc5549b7c1778ad0d1f758f64760a5930d98447121a1d051409fbe",
    ),
    (
        "ledger.account_metadata.delete",
        &[
            ("accountId", "0b4f6c2e-1111-4222-8333-444455556666"),
            ("key", "desk.label"),
            ("reason", "LOCAL TEST remove the desk label"),
        ],
        "sha256:0674c45c26211a2014bae89ae98f9ad81d7dedacecf027f8fb11d29fd7bf32bf",
    ),
];

#[test]
fn the_payload_hash_is_the_consoles() {
    for (action, fields, hash) in TABLE {
        assert_eq!(payload_hash(action, fields), hash, "{action} {fields:?}");
    }
}

#[test]
fn the_account_metadata_delete_is_named_as_the_console_names_it() {
    assert_eq!(
        ACCOUNT_METADATA_DELETE_ACTION,
        "ledger.account_metadata.delete"
    );
    assert_eq!(
        ACCOUNT_METADATA_DELETE_TARGET,
        "posting_account_metadata.delete"
    );
}
