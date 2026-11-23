//! The operator-approval payload hash the founder console computes (`apps/admin/src/lib/desk/approval-hash.ts`) must be
//! the one svc-academy consumes. `apps/admin/src/lib/desk/approval-hash.test.ts` holds the console to this table; this
//! test holds `access::payload_hash` to the same table, so a change on either side fails one of the two.
#![allow(clippy::indexing_slicing, reason = "a test")]

use svc_academy::access::payload_hash;

type Vector = (
    &'static str,
    &'static [(&'static str, &'static str)],
    &'static str,
);

const TABLE: [Vector; 7] = [
    (
        "academy.ambassador.freeze",
        &[
            ("userId", "9f8e7d6c-1111-4222-8333-444455556666"),
            ("reason", "conduct complaint review"),
        ],
        "sha256:f72da170d1ce22fb5f604e7bf2418259cd0b08e765a1fe47018d47acdb161127",
    ),
    (
        "academy.ambassador.unfreeze",
        &[("userId", "9f8e7d6c-1111-4222-8333-444455556666")],
        "sha256:a42c67c92f016b89a8050ef201ff4432b8c22f8f3044ff92fb6ccc350c10ffb5",
    ),
    (
        "academy.ambassador.appoint",
        &[("userId", "9f8e7d6c-1111-4222-8333-444455556666")],
        "sha256:83ddb154b75960080557fdf60fc61fbe118c26cf8b45961c4a4c2c64a60e3576",
    ),
    (
        "academy.residency.decide",
        &[
            ("id", "5a3b9c10-1111-4222-8333-444455556666"),
            ("decision", "accepted"),
        ],
        "sha256:e43a13649245019c382887432eb8d7ada267cef1aac4d1243f9d7f3f0993a0c1",
    ),
    (
        "academy.residency.decide",
        &[
            ("id", "5a3b9c10-1111-4222-8333-444455556666"),
            ("decision", "rejected"),
        ],
        "sha256:d6b3c1313d266835bfa7d5274994e7c5d9b3a4a5192c4877dacfa66aac55d552",
    ),
    (
        "academy.cert.revoke",
        &[
            ("publicId", "0123456789abcdef0123456789abcdef"),
            ("reason", "TEST issued in error, revoke it"),
        ],
        "sha256:5c6d96be011ca9e9fcc318373c758c0eff3405d4ab1b678175d0c52ee1afa3b6",
    ),
    (
        "academy.cert.exception",
        &[
            ("userId", "9f8e7d6c-1111-4222-8333-444455556666"),
            ("certId", "foundations-v1"),
            ("reason", "TEST issued in error, revoke it"),
        ],
        "sha256:c94f273d8152b20b949d0f4bfbf667131516e1b1dc1911b29d9f795be81e9aed",
    ),
];

#[test]
fn the_payload_hash_is_the_consoles() {
    for (action, fields, hash) in TABLE {
        assert_eq!(payload_hash(action, fields), hash, "{action} {fields:?}");
    }
}
