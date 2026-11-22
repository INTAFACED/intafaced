//! `dual-target-one-book.test.ts` (`services/svc-matching/src/engine/`), ported test for test onto the Rust book and
//! the Rust sources. Each test is named after the TypeScript `it` it ports.
//!
//! The promise: one matching book per market, and no structural house preference inside the matcher. Account ids are
//! opaque; only price-time priority decides. The behavioural pins run the Rust `OrderBook`. The two source scans read
//! the Rust matcher (`src/book/` and `src/engine/`, the TypeScript's `engine/` folder) instead of the `.ts` files, with
//! the same forbidden names in Rust's spelling (`is_house`, `tenant_id`, `priority_boost`, ...). The scan of
//! `EngineOrder` reads its struct in `src/book/types.rs`; the one-book scan reads `MatchingEngine`'s fields in
//! `src/engine/mod.rs`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::fs;
use std::path::Path;

use service_kit::money::{Amount, format_amount, parse_amount};
use svc_matching::book::OrderBook;
use svc_matching::book::types::{EngineOrder, OrderType, Side, SubmitResult, Tif};

/// `stripComments`: drop `/* ... */` blocks and every line that starts with `//` (doc comments included).
fn strip_comments(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        rest = rest[start..]
            .find("*/")
            .map_or("", |end| &rest[start + end + 2..]);
    }
    out.push_str(rest);
    out.lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Every `.rs` file under `src/<dir>`, recursively, as (path, text).
fn sources(dir: &str) -> Vec<(String, String)> {
    fn walk(path: &Path, out: &mut Vec<(String, String)>) {
        let mut entries: Vec<_> = fs::read_dir(path)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        entries.sort();
        for p in entries {
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push((p.display().to_string(), fs::read_to_string(&p).unwrap()));
            }
        }
    }
    let mut out = Vec::new();
    walk(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(dir),
        &mut out,
    );
    assert!(!out.is_empty(), "no sources under src/{dir}");
    out
}

/// The identifiers of a text: runs of letters, digits and `_`.
fn identifiers(text: &str) -> Vec<&str> {
    text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .collect()
}

fn a(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

fn order(id: &str, account: &str, side: Side, qty: &str, price: &str) -> EngineOrder {
    EngineOrder::new(
        id,
        account,
        OrderType::Limit,
        side,
        a(qty),
        Some(a(price)),
        Tif::Gtc,
    )
}

fn seed(book: &mut OrderBook, o: &EngineOrder) {
    let result = book.submit(o, None);
    assert!(result.accepted, "seed rejected: {:?}", result.rejected);
}

/// `fillFingerprint`: the fill sequence, whatever the account labels.
fn fingerprint(result: &SubmitResult) -> Vec<String> {
    result
        .fills
        .iter()
        .map(|f| {
            format!(
                "{}>{}@{}x{}",
                f.maker_order_id,
                f.taker_order_id,
                format_amount(f.price),
                format_amount(f.qty)
            )
        })
        .collect()
}

/// The body of `pub struct <name> { ... }` in `text`.
fn struct_body<'a>(text: &'a str, name: &str) -> &'a str {
    let start = text
        .find(&format!("pub struct {name} {{"))
        .unwrap_or_else(|| panic!("pub struct {name} is not in the file"));
    let body = &text[start..];
    &body[..body.find("\n}\n").unwrap()]
}

#[test]
fn engine_order_has_no_tenant_house_or_plane_privilege_field_one_book_semantics() {
    let types = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/book/types.rs"))
        .unwrap();
    let body = struct_body(&types, "EngineOrder");
    assert!(body.contains("pub account_id: String"));
    for word in identifiers(body) {
        let lower = word.to_ascii_lowercase();
        for part in lower.split('_') {
            assert!(
                !["tenant", "house", "vip", "plane", "preference"].contains(&part),
                "EngineOrder names {word}"
            );
        }
        let joined = lower.replace('_', "");
        assert!(
            !["priorityboost", "isinternal"].contains(&joined.as_str()),
            "EngineOrder names {word}"
        );
    }
}

#[test]
fn matching_path_never_branches_on_house_tenant_or_vip_identity_source_scan() {
    // Allowed, as in the TypeScript: the opaque `account_id ==` self-trade check (the same account, not a privileged
    // class). Forbidden: any privilege discriminator.
    let named: [(&str, &str); 9] = [
        ("housetenant", "house-tenant privilege flag"),
        ("ishouse", "house-tenant privilege flag"),
        ("tenantid", "tenant-class branch"),
        ("tenantkind", "tenant-class branch"),
        ("tenanttype", "tenant-class branch"),
        ("vip", "queue privilege"),
        ("priorityboost", "queue privilege"),
        ("queuejump", "queue privilege"),
        ("preferinternal", "structural house preference"),
    ];
    let prefixed: [(&str, &str); 2] = [
        ("internalpreference", "structural house preference"),
        ("houseprefer", "structural house preference"),
    ];
    let mut scanned = 0;
    for dir in ["book", "engine"] {
        for (name, text) in sources(dir) {
            scanned += 1;
            let body = strip_comments(&text);
            for word in identifiers(&body) {
                assert!(
                    !word.starts_with("HOUSE_"),
                    "{name}: house-tenant privilege flag ({word})"
                );
                let joined = word.to_ascii_lowercase().replace('_', "");
                for (bad, why) in named {
                    assert_ne!(joined, bad, "{name}: {why} ({word})");
                }
                for (bad, why) in prefixed {
                    assert!(!joined.starts_with(bad), "{name}: {why} ({word})");
                }
            }
            for line in body.lines() {
                let lower = line.to_ascii_lowercase();
                let branches = identifiers(&lower).contains(&"if") || lower.contains("match ");
                assert!(
                    !(branches && lower.contains("house")),
                    "{name}: branch on house identity: {line}"
                );
                assert!(
                    !lower.replace(' ', "").contains("account_id==\"house"),
                    "{name}: literal house account privilege: {line}"
                );
                assert!(
                    !lower.replace(' ', "").contains("contains(\"house"),
                    "{name}: house allowlist in matcher: {line}"
                );
            }
        }
    }
    assert!(scanned > 5, "scanned only {scanned} files");
}

#[test]
fn house_resting_later_at_the_same_price_does_not_jump_the_customer_queue() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        &order("cust-first", "customer-a", Side::Sell, "1", "100"),
    );
    seed(
        &mut book,
        &order("house-second", "house-mm", Side::Sell, "1", "100"),
    );

    let take = book.submit(&order("taker", "customer-b", Side::Buy, "1", "100"), None);

    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);
    assert_eq!(take.fills[0].maker_order_id, "cust-first");
    assert_eq!(take.fills[0].maker_account_id, "customer-a");
}

#[test]
fn a_worse_house_quote_loses_to_a_better_customer_quote_even_when_house_arrived_first() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        &order("house-worse", "house-mm", Side::Sell, "1", "101"),
    );
    seed(
        &mut book,
        &order("cust-better", "customer-a", Side::Sell, "1", "100"),
    );

    let take = book.submit(&order("taker", "customer-b", Side::Buy, "1", "101"), None);

    let makers: Vec<&str> = take
        .fills
        .iter()
        .map(|f| f.maker_order_id.as_str())
        .collect();
    assert_eq!(makers, ["cust-better"]);
    assert_eq!(format_amount(take.fills[0].price), "100");
}

#[test]
fn house_as_taker_still_pays_the_resting_maker_price_no_house_price_prefer() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        &order("cust-maker", "customer-a", Side::Sell, "1", "100"),
    );

    let take = book.submit(
        &order("house-taker", "house-mm", Side::Buy, "1", "105"),
        None,
    );

    assert_eq!(take.fills.len(), 1);
    assert_eq!(take.fills[0].maker_order_id, "cust-maker");
    assert_eq!(format_amount(take.fills[0].price), "100");
    assert_eq!(take.fills[0].taker_account_id, "house-mm");
}

#[test]
fn relabelling_accounts_house_and_customer_leaves_the_fill_fingerprint_unchanged_opaque_ids() {
    let run = |first: &str, second: &str| {
        let mut book = OrderBook::new("ETH/USDT");
        seed(&mut book, &order("m1", first, Side::Sell, "2", "50"));
        seed(&mut book, &order("m2", second, Side::Sell, "2", "50"));
        let take = book.submit(&order("t", "taker", Side::Buy, "3", "50"), None);
        fingerprint(&take)
    };

    assert_eq!(run("house-mm", "customer-a"), run("customer-a", "house-mm"));
    assert_eq!(run("house-mm", "customer-a"), ["m1>t@50x2", "m2>t@50x1"]);
}

#[test]
fn matching_engine_keeps_one_order_book_map_no_parallel_house_books_field() {
    let engine =
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/engine/mod.rs"))
            .unwrap();
    let body = strip_comments(struct_body(&engine, "MatchingEngine"));
    let book_fields: Vec<&str> = body
        .lines()
        .map(str::trim)
        .filter(|l| l.contains("OrderBook"))
        .collect();
    assert_eq!(book_fields, ["books: HashMap<String, OrderBook>,"]);
    for (name, text) in sources("engine") {
        for word in identifiers(&strip_comments(&text)) {
            let joined = word.to_ascii_lowercase().replace('_', "");
            assert!(
                !["housebooks", "internalbooks", "secondbook", "parallelbook"]
                    .contains(&joined.as_str()),
                "{name}: {word}"
            );
        }
    }
}
