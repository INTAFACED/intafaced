//! `shared-conformance.pin.test.ts` (`services/svc-matching/src/engine/`), ported pin for pin onto the Rust engine.
//! Each test is named after the TypeScript `it` it ports.
//!
//! The law is `docs/adr/2026-09-18-matching-shared-conformance.md`: the shared matching rows INTACORE must import. The
//! TypeScript pins read the TypeScript engine's sources (`core-tif.ts`, `types.ts`, `self-trade.ts`, `book.ts`) for
//! phrases. Those files go with the TypeScript service, so each pin here holds the same row on the Rust: the ADR and
//! `packages/exchange-contract/src/schemas.ts` are read as before; the engine's side of each row is its Rust type or
//! its behaviour (an enum matched exhaustively, a fill, a refusal), and `book`'s purity is a scan of `src/book/`. The
//! last pin names the Rust tests that hold determinism and one-book fairness, as the TypeScript pin named its files.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::fs;
use std::path::Path;

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use svc_matching::book::OrderBook;
use svc_matching::book::types::{CancelReason, EngineOrder, OrderType, Side, Tif};
use svc_matching::book::wire::{from_wire, to_wire};

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

fn root() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read(path: &str) -> String {
    fs::read_to_string(root().join(path)).unwrap_or_else(|e| panic!("{path}: {e}"))
}

const ADR: &str = "docs/adr/2026-09-18-matching-shared-conformance.md";
const CONTRACT_SCHEMAS: &str = "packages/exchange-contract/src/schemas.ts";
/// An order's side and time in force: contracts declares them, exchange-contract re-exports them.
const ORDER_ENUMS: &str = "packages/contracts/src/order-enums.ts";

/// `enumValues`: the quoted values of `export const <name> = z.enum([...])`.
fn enum_values(source: &str, name: &str) -> Vec<String> {
    let head = format!("export const {name} = z.enum([");
    let start = source
        .find(&head)
        .unwrap_or_else(|| panic!("{name} declared as a z.enum"))
        + head.len();
    let inner = &source[start..start + source[start..].find(']').unwrap()];
    inner
        .split(',')
        .map(|v| v.trim().trim_matches('\'').to_owned())
        .filter(|v| !v.is_empty())
        .collect()
}

/// Every `Tif`; the match makes a new variant a compile error here until it is listed.
fn all_tif() -> Vec<Tif> {
    let all = [
        Tif::Gtc,
        Tif::Ioc,
        Tif::Fok,
        Tif::Po,
        Tif::Moc,
        Tif::Gtd,
        Tif::Gtt,
    ];
    for t in all {
        match t {
            Tif::Gtc | Tif::Ioc | Tif::Fok | Tif::Po | Tif::Moc | Tif::Gtd | Tif::Gtt => {}
        }
    }
    all.to_vec()
}

fn all_sides() -> Vec<Side> {
    let all = [Side::Buy, Side::Sell];
    for s in all {
        match s {
            Side::Buy | Side::Sell => {}
        }
    }
    all.to_vec()
}

fn all_order_types() -> Vec<OrderType> {
    let all = [
        OrderType::Market,
        OrderType::Limit,
        OrderType::Stop,
        OrderType::StopLimit,
    ];
    for t in all {
        match t {
            OrderType::Market | OrderType::Limit | OrderType::Stop | OrderType::StopLimit => {}
        }
    }
    all.to_vec()
}

fn a(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

fn limit(id: &str, account: &str, side: Side, qty: &str, price: &str) -> EngineOrder {
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

#[test]
fn adr_exists_and_names_the_shared_rows_a_chain_engineer_would_open() {
    let text = read(ADR);
    for token in [
        "GTC",
        "IOC",
        "FOK",
        "PO",
        "GTD",
        "GTT",
        "tif_missing",
        "CANCEL_RESTING_CONTINUE",
        "self_trade_prevention",
        "taker pays the book",
        "byte-identical",
        "take_profit",
        "precision.price",
        "Do not copy the TypeScript engine",
    ] {
        assert!(text.contains(token), "ADR missing token: {token}");
    }
    assert!(text.contains("**Status:** **Proposed (spec).**"));
    assert!(!text.contains("self-Accepted"));
}

/// `KNOWN_TIF` is the Rust `Tif`; "missing TIF is not GTC" is held by the order's wire form, which refuses an order
/// with no `tif` rather than defaulting it.
#[test]
fn tif_enum_is_one_list_exchange_contract_equals_the_engine_tif() {
    let contract = enum_values(&read(ORDER_ENUMS), "timeInForceSchema");
    let engine: Vec<String> = all_tif()
        .into_iter()
        .map(|t| t.as_str().to_owned())
        .collect();
    assert_eq!(contract, engine);
    assert_eq!(engine, ["GTC", "IOC", "FOK", "PO", "MOC", "GTD", "GTT"]);
    for t in &engine {
        assert_eq!(Tif::parse(t).map(Tif::as_str), Some(t.as_str()));
    }
    assert_eq!(Tif::parse(""), None);
    assert_eq!(Tif::parse("gtc"), None);

    let wire = to_wire(&limit("o-1", "desk", Side::Buy, "1", "100"), None);
    let Json::Object(fields) = wire else {
        panic!("an order's wire form is an object");
    };
    let without_tif = Json::Object(fields.into_iter().filter(|(k, _)| k != "tif").collect());
    assert!(
        from_wire(&without_tif).is_err(),
        "an order with no tif is read as some tif"
    );
}

#[test]
fn sides_are_buy_sell_only() {
    let contract = enum_values(&read(ORDER_ENUMS), "orderSideSchema");
    assert_eq!(contract, ["buy", "sell"]);
    let engine: Vec<&str> = all_sides().into_iter().map(Side::as_str).collect();
    assert_eq!(engine, ["buy", "sell"]);
}

#[test]
fn public_order_types_include_take_profit_engine_native_types_do_not() {
    let contract = enum_values(&read(CONTRACT_SCHEMAS), "orderTypeSchema");
    assert_eq!(
        contract,
        ["market", "limit", "stop", "stop_limit", "take_profit"]
    );
    let engine: Vec<&str> = all_order_types()
        .into_iter()
        .map(OrderType::as_str)
        .collect();
    let public_minus_take_profit: Vec<&str> = contract
        .iter()
        .map(String::as_str)
        .filter(|t| *t != "take_profit")
        .collect();
    assert_eq!(engine, public_minus_take_profit);
    assert_eq!(OrderType::parse("take_profit"), None);
}

#[test]
fn stp_v1_is_expire_resting_continue_taker_never_a_self_fill() {
    assert_eq!(
        CancelReason::SelfTradePrevention.as_str(),
        "self_trade_prevention"
    );

    let mut book = OrderBook::new("BTC/USDT");
    assert!(
        book.submit(&limit("own", "acct-a", Side::Sell, "1", "100"), None)
            .accepted
    );
    assert!(
        book.submit(&limit("stranger", "acct-b", Side::Sell, "1", "101"), None)
            .accepted
    );

    let take = book.submit(&limit("taker", "acct-a", Side::Buy, "1", "101"), None);

    assert!(take.accepted);
    // The resting maker of the same account expires; the taker continues to the stranger.
    assert_eq!(take.cancellations.len(), 1);
    assert_eq!(take.cancellations[0].order_id, "own");
    assert_eq!(
        take.cancellations[0].reason,
        CancelReason::SelfTradePrevention
    );
    assert_eq!(take.fills.len(), 1);
    assert_eq!(take.fills[0].maker_order_id, "stranger");
    assert!(
        take.fills
            .iter()
            .all(|f| f.maker_account_id != f.taker_account_id)
    );
}

#[test]
fn fill_price_is_the_maker_price_taker_pays_the_book() {
    for (side, maker_price, taker_price) in [(Side::Sell, "100", "105"), (Side::Buy, "100", "95")] {
        let mut book = OrderBook::new("BTC/USDT");
        assert!(
            book.submit(&limit("maker", "acct-m", side, "1", maker_price), None)
                .accepted
        );
        let take = book.submit(
            &limit("taker", "acct-t", side.opposite(), "1", taker_price),
            None,
        );
        assert_eq!(take.fills.len(), 1);
        assert_eq!(format_amount(take.fills[0].price), maker_price);
    }
}

#[test]
fn book_matching_path_forbids_clock_randomness_and_float_money() {
    for (name, text) in sources("book") {
        let body = strip_comments(&text);
        for word in identifiers(&body) {
            for bad in [
                "SystemTime",
                "Instant",
                "getrandom",
                "rand",
                "thread_rng",
                "f32",
                "f64",
                "Date",
            ] {
                assert_ne!(word, bad, "{name}: {bad}");
            }
        }
        assert!(!body.contains("Utc::now"), "{name}: Utc::now");
        assert!(!body.contains(" as f"), "{name}: a cast to a float");
    }
    let header =
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/book/order_book.rs"))
            .unwrap();
    let header = &header[..header.find("\nuse ").unwrap()];
    assert!(header.contains("price-time priority"));
    assert!(header.contains("no clock"));
    assert!(header.contains("no randomness"));
    assert!(header.contains("Every price and quantity is an [`Amount`]"));
}

/// The TypeScript pin names `book.test.ts`, `dual-target-one-book.test.ts`, `core-tif.test.ts` and
/// `serializeBooks`; their Rust ports are named here.
#[test]
fn determinism_pins_and_one_book_fairness_pins_still_exist() {
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let test = |file: &str| fs::read_to_string(crate_dir.join("tests").join(file)).unwrap();

    let book = test("book.rs");
    for pin in [
        "fn fills_the_earliest_order_first_when_prices_are_equal()",
        "fn fills_the_better_price_first_regardless_of_arrival_order()",
        "fn round_trips_through_a_snapshot_byte_for_byte()",
        "fn contains_no_floating_point_value_anywhere_every_amount_is_a_decimal_string()",
    ] {
        assert!(book.contains(pin), "tests/book.rs: {pin}");
    }
    let one_book = test("ported_f_one_book.rs");
    for pin in [
        "fn house_resting_later_at_the_same_price_does_not_jump_the_customer_queue()",
        "fn matching_path_never_branches_on_house_tenant_or_vip_identity_source_scan()",
        "fn matching_engine_keeps_one_order_book_map_no_parallel_house_books_field()",
    ] {
        assert!(one_book.contains(pin), "tests/ported_f_one_book.rs: {pin}");
    }
    let tif = test("engine_calls.rs");
    assert!(
        tif.contains(
            "fn present_gtc_ioc_fok_po_gtd_gtt_with_required_fields_are_not_tif_missing()"
        )
    );
    let engine = fs::read_to_string(crate_dir.join("src/engine/mod.rs")).unwrap();
    assert!(engine.contains("pub fn serialize(&self) -> String"));
}
