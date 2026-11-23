//! Ported from the TypeScript service's `user-copy.test.ts`: every message a door's refusal carries goes through
//! `errors::user_copy` (`userCopy`), which reads the copy recorded from `@intafaced/i18n` (`src/errors_table.rs`) and
//! answers the code itself where the catalogue has none, never invented English. Each test is named after the `it` it
//! ports.
//!
//! Not ported: the first test's `error.notFound` and `error.generic` lines. No svc-matching door answers either key
//! (the table holds every `matching.*` code the TypeScript names and the catalogue codes its doors answer with), so
//! no Rust call reads them; the matching codes that alias `error.notFound` are asserted below.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use svc_matching::errors::user_copy;

/// Case-insensitive: none of `phrases` is in `text`.
fn invents_none(text: &str, phrases: &[&str]) {
    let lower = text.to_lowercase();
    for p in phrases {
        assert!(!lower.contains(p), "{text:?} invents {p:?}");
    }
}

#[test]
fn user_copy_resolves_a_known_catalog_key() {
    assert_eq!(
        user_copy("matching.order_not_found"),
        "We could not find that."
    );
    assert_eq!(
        user_copy("matching.market_not_found"),
        "We could not find that."
    );
    assert_eq!(
        user_copy("matching.unauthenticated"),
        "Sign in to continue."
    );
    assert_eq!(user_copy("error.unauthorized"), "Sign in to continue.");
    assert_eq!(
        user_copy("error.forbidden"),
        "You do not have access to this."
    );
}

#[test]
fn user_copy_renders_the_dotted_key_when_the_key_is_not_in_the_catalog() {
    let missing = "matching.refuse.this.key.does.not.exist";
    let rendered = user_copy(missing);
    assert_eq!(rendered, missing);
    assert!(!rendered.contains(' '));
    invents_none(
        &rendered,
        &[
            "please try",
            "something went wrong",
            "could not find",
            "not live",
            "not a market",
        ],
    );
}

#[test]
fn user_copy_does_not_invent_engine_refuse_copy_for_unkeyed_matching_codes() {
    let post_only = user_copy("matching.post_only_would_cross");
    assert_eq!(post_only, "matching.post_only_would_cross");
    assert!(!post_only.contains(' '));
    invents_none(&post_only, &["would cross", "post-only", "rejected"]);

    let disabled = user_copy("matching.engine_flag_off");
    assert_eq!(disabled, "matching.engine_flag_off");
    assert!(!disabled.contains(' '));
    invents_none(&disabled, &["flag is off", "disabled", "not ready"]);

    let unpublished = user_copy("matching.rulebook_unpublished");
    assert_eq!(unpublished, "matching.rulebook_unpublished");
    assert!(!unpublished.contains(' '));
    invents_none(
        &unpublished,
        &["best execution", "certified venue", "not published"],
    );
}
