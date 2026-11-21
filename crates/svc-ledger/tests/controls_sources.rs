//! A control's outside side (`ledger/reconciliation-sources.test.ts`, case for case): one rail's statement, the whole
//! book, and the open items svc-pay lists for a rail, each read through a fake `fetch`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use std::sync::{Arc, Mutex};

use service_kit::http::{Fetch, FetchError, HttpRequest, HttpResponse};
use service_kit::json::{self, Json};
use service_kit::time::js_date;
use svc_ledger::controls::sources::{
    Http, OpenItemsRead, OpenItemsSource, Signer, SnapshotRead, Sources,
};

type Answer = Box<dyn Fn(&HttpRequest) -> Result<HttpResponse, FetchError> + Send + Sync>;

#[derive(Clone)]
struct Fake {
    answer: Arc<Answer>,
    calls: Arc<Mutex<Vec<HttpRequest>>>,
}

impl Fake {
    fn new(
        answer: impl Fn(&HttpRequest) -> Result<HttpResponse, FetchError> + Send + Sync + 'static,
    ) -> Fake {
        Fake {
            answer: Arc::new(Box::new(answer)),
            calls: Arc::new(Mutex::new(Vec::new())),
        }
    }
    fn calls(&self) -> Vec<HttpRequest> {
        self.calls.lock().unwrap().clone()
    }
}

impl Fetch for Fake {
    fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
        self.calls.lock().unwrap().push(req.clone());
        (self.answer)(req)
    }
}

fn json_answer(body: &str, status: u16) -> Result<HttpResponse, FetchError> {
    Ok(HttpResponse {
        status,
        body: body.to_owned(),
    })
}

fn thrown() -> Result<HttpResponse, FetchError> {
    Err(FetchError {
        message: "refused".to_owned(),
    })
}

fn read_at() -> i64 {
    js_date("2026-10-29T12:00:00.000Z").unwrap().0
}

fn ms(s: &str) -> i64 {
    js_date(s).unwrap().0
}

/// `statement(over)`: each override replaces its key's raw JSON; `extra` adds a key.
fn statement(over: &[(&str, &str)]) -> String {
    let mut fields = vec![
        ("source", "\"rail\"".to_owned()),
        ("rail", "\"test\"".to_owned()),
        ("asOf", "\"2026-10-29T11:59:00.000Z\"".to_owned()),
        (
            "balances",
            "[{\"assetId\":\"USDT\",\"amount\":\"-125.50\"}]".to_owned(),
        ),
    ];
    for (k, v) in over {
        match fields.iter_mut().find(|(key, _)| key == k) {
            Some(f) => f.1 = (*v).to_owned(),
            None => fields.push((k, (*v).to_owned())),
        }
    }
    let inner: Vec<String> = fields.iter().map(|(k, v)| format!("\"{k}\":{v}")).collect();
    format!("{{{}}}", inner.join(","))
}

fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
    list.iter()
        .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
        .collect()
}

fn sources(
    book: Option<&str>,
    rails: &[(&str, &str)],
    fetch: &Fake,
    open: Option<OpenItemsSource>,
) -> Http {
    Http {
        outside_snapshot_url: book.map(str::to_owned),
        rail_statement_urls: pairs(rails),
        fetch: Arc::new(fetch.clone()),
        timeout_ms: 1000,
        open_items: open,
    }
}

fn query(url: &str) -> Vec<(String, String)> {
    url::Url::parse(url)
        .unwrap()
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

fn param(url: &str, key: &str) -> Option<String> {
    query(url)
        .into_iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v)
}

#[test]
fn reads_only_the_named_rails_url_with_rail_and_as_of_and_keeps_the_signed_amount_as_given() {
    let fetch = Fake::new(|_| json_answer(&statement(&[]), 200));
    let s = sources(
        Some("http://127.0.0.1:9/book"),
        &[("test", "http://127.0.0.1:9/rails")],
        &fetch,
        None,
    );
    assert_eq!(
        s.rail_statement(read_at(), "test"),
        SnapshotRead::Snapshot {
            as_of: Some("2026-10-29T11:59:00.000Z".to_owned()),
            balances: pairs(&[("USDT", "-125.50")]),
        }
    );
    let calls = fetch.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(url::Url::parse(&calls[0].url).unwrap().path(), "/rails");
    assert_eq!(param(&calls[0].url, "rail").as_deref(), Some("test"));
    assert_eq!(
        param(&calls[0].url, "asOf").as_deref(),
        Some("2026-10-29T12:00:00.000Z")
    );
}

#[test]
fn is_unset_for_a_rail_with_no_url_and_never_falls_back_to_the_whole_book_snapshot() {
    let fetch = Fake::new(|_| {
        json_answer(
            "{\"source\":\"rail\",\"asOf\":\"2026-10-29T11:59:00.000Z\",\"balances\":[]}",
            200,
        )
    });
    let s = sources(
        Some("http://127.0.0.1:9/book"),
        &[("test", "http://127.0.0.1:9/rails")],
        &fetch,
        None,
    );
    assert_eq!(
        s.rail_statement(read_at(), "crypto-native"),
        SnapshotRead::Unset
    );
    assert!(fetch.calls().is_empty());
}

#[test]
fn is_unavailable_for_a_statement_of_another_rail_a_late_as_of_a_non_200_a_malformed_body_or_a_failed_fetch()
 {
    let answers: Vec<Box<dyn Fn() -> Result<HttpResponse, FetchError> + Send + Sync>> = vec![
        Box::new(|| json_answer(&statement(&[("rail", "\"crypto-native\"")]), 200)),
        Box::new(|| json_answer(&statement(&[("asOf", "\"2026-10-29T12:00:01.000Z\"")]), 200)),
        Box::new(|| json_answer(&statement(&[]), 503)),
        Box::new(|| {
            json_answer(
                &statement(&[("balances", "[{\"assetId\":\"USDT\",\"amount\":12.5}]")]),
                200,
            )
        }),
        Box::new(|| json_answer(&statement(&[("extra", "true")]), 200)),
        Box::new(thrown),
    ];
    for (n, answer) in answers.into_iter().enumerate() {
        let fetch = Fake::new(move |_| answer());
        let s = sources(None, &[("test", "http://127.0.0.1:9/rails")], &fetch, None);
        assert_eq!(
            s.rail_statement(read_at(), "test"),
            SnapshotRead::Unavailable,
            "answer {n}"
        );
    }
}

#[test]
fn keeps_the_whole_book_snapshot_read_unchanged_when_no_rail_is_named() {
    let fetch = Fake::new(|_| {
        json_answer(
            "{\"source\":\"rail\",\"asOf\":\"2026-10-29T11:00:00.000Z\",\"balances\":[{\"assetId\":\"BTC\",\"amount\":\"2\"}]}",
            200,
        )
    });
    let s = sources(
        Some("http://127.0.0.1:9/book"),
        &[("test", "http://127.0.0.1:9/rails")],
        &fetch,
        None,
    );
    assert!(matches!(
        s.outside_balance(read_at()),
        SnapshotRead::Snapshot { .. }
    ));
    let calls = fetch.calls();
    assert_eq!(url::Url::parse(&calls[0].url).unwrap().path(), "/book");
    assert_eq!(param(&calls[0].url, "rail"), None);
    assert_eq!(
        sources(None, &[], &fetch, None).outside_balance(read_at()),
        SnapshotRead::Unset
    );
}

// Per-rail open items (lead ruling 2026-10-30).

fn item(id: &str, signed: &str) -> String {
    item_with(id, signed, &[])
}

/// `item(id, signedAmount)` with raw-JSON overrides.
fn item_with(id: &str, signed: &str, over: &[(&str, &str)]) -> String {
    let negative = signed.starts_with('-');
    let mut fields: Vec<(&str, String)> = vec![
        ("depositId", format!("\"{id}\"")),
        (
            "kind",
            if negative {
                "\"reversal_unfunded\""
            } else {
                "\"held\""
            }
            .to_owned(),
        ),
        ("userId", "\"u-1\"".to_owned()),
        ("assetId", "\"USDT\"".to_owned()),
        ("networkId", "\"ethereum\"".to_owned()),
        ("txHash", format!("\"0x{id}\"")),
        ("outputIndex", "0".to_owned()),
        ("amount", format!("\"{}\"", signed.replace('-', ""))),
        ("signedAmount", format!("\"{signed}\"")),
        (
            "status",
            if negative {
                "\"needs_review\""
            } else {
                "\"held_travel_rule\""
            }
            .to_owned(),
        ),
        (
            "reason",
            if negative {
                "\"reversal_unfunded\""
            } else {
                "null"
            }
            .to_owned(),
        ),
        ("detectedAt", "\"2026-10-29T11:00:00.000Z\"".to_owned()),
    ];
    for (k, v) in over {
        if let Some(f) = fields.iter_mut().find(|(key, _)| key == k) {
            f.1 = (*v).to_owned();
        }
    }
    let inner: Vec<String> = fields.iter().map(|(k, v)| format!("\"{k}\":{v}")).collect();
    format!("{{{}}}", inner.join(","))
}

fn sums(held: &str, unfunded: &str, net: &str, held_count: i64, unfunded_count: i64) -> String {
    format!(
        "[{{\"networkId\":\"ethereum\",\"assetId\":\"USDT\",\"held\":\"{held}\",\"heldCount\":{held_count},\"reversalUnfunded\":\"{unfunded}\",\"reversalUnfundedCount\":{unfunded_count},\"net\":\"{net}\"}}]"
    )
}

fn page(items: &[String], total: i64, sums: &str) -> String {
    format!(
        "{{\"items\":[{}],\"total\":{total},\"sums\":{sums}}}",
        items.join(",")
    )
}

fn signer() -> Signer {
    Arc::new(|payload: &str, _url: &str| Ok(vec![("x-signed".to_owned(), payload.to_owned())]))
}

fn open(urls: &[(&str, &str)]) -> Option<OpenItemsSource> {
    Some(OpenItemsSource {
        urls: pairs(urls),
        sign: signer(),
    })
}

const ITEMS_URL: (&str, &str) = ("test", "http://127.0.0.1:9/items");

/// The page asked for: its offset and limit.
fn asked(req: &HttpRequest) -> (i64, i64) {
    let body = json::parse(req.body.as_deref().unwrap()).unwrap();
    let n = |k: &str| match body.get(k) {
        Some(Json::Number(v)) => {
            #[expect(clippy::cast_possible_truncation, reason = "a small page number")]
            let whole = *v as i64;
            whole
        }
        _ => panic!("no {k}"),
    };
    (n("offset"), n("limit"))
}

fn open_read(fetch: &Fake) -> OpenItemsRead {
    sources(None, &[], fetch, open(&[ITEMS_URL])).open_items("test")
}

fn header<'a>(req: &'a HttpRequest, name: &str) -> Option<&'a str> {
    req.headers
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

#[test]
fn pages_through_every_item_signs_each_exact_body_and_names_each_by_id_with_its_signed_amount() {
    let all: Vec<String> = (0..201).map(|i| item(&format!("d{i}"), "1")).collect();
    let fetch = Fake::new(move |req| {
        let (offset, limit) = asked(req);
        let from = usize::try_from(offset).unwrap().min(all.len());
        let to = usize::try_from(offset + limit).unwrap().min(all.len());
        json_answer(
            &page(&all[from..to], 201, &sums("201", "0", "201", 201, 0)),
            200,
        )
    });
    let OpenItemsRead::Items(items) = open_read(&fetch) else {
        panic!("not items");
    };
    assert_eq!(items.len(), 201);
    assert_eq!(
        items[200].item.compact(),
        "{\"source\":\"svc-pay\",\"id\":\"d200\",\"kind\":\"held\",\"assetId\":\"USDT\",\"amount\":\"1\"}"
    );
    assert_eq!(items[200].seen_at, Some(ms("2026-10-29T11:00:00.000Z")));
    let calls = fetch.calls();
    let bodies: Vec<&str> = calls.iter().map(|c| c.body.as_deref().unwrap()).collect();
    assert_eq!(
        bodies,
        [
            "{\"rail\":\"test\",\"offset\":0,\"limit\":200}",
            "{\"rail\":\"test\",\"offset\":200,\"limit\":200}",
        ]
    );
    let signed: Vec<&str> = calls
        .iter()
        .map(|c| header(c, "x-signed").unwrap())
        .collect();
    assert_eq!(signed, bodies);
    // One deadline for the whole read, never one per page: each page has what is left of it, never a fresh one.
    let first = calls[0].timeout_ms.unwrap();
    let second = calls[1].timeout_ms.unwrap();
    assert!(first <= 1000 && second <= first, "{first} then {second}");
}

#[test]
fn is_unset_for_a_rail_with_no_url_or_no_source_and_reads_nothing() {
    let fetch = Fake::new(|_| json_answer("{}", 200));
    assert!(sources(None, &[], &fetch, open(&[ITEMS_URL])).has_open_items("test"));
    assert!(!sources(None, &[], &fetch, open(&[ITEMS_URL])).has_open_items("crypto-native"));
    assert!(!sources(None, &[], &fetch, None).has_open_items("test"));
    assert_eq!(
        sources(None, &[], &fetch, open(&[ITEMS_URL])).open_items("crypto-native"),
        OpenItemsRead::Unset
    );
    assert_eq!(
        sources(None, &[], &fetch, None).open_items("test"),
        OpenItemsRead::Unset
    );
    assert!(fetch.calls().is_empty());
}

#[test]
fn is_unavailable_never_a_partial_list_on_a_refusal_a_bad_body_a_total_or_sums_that_move_between_pages_or_items_that_miss_the_sums()
 {
    let two = || vec![item("a", "5"), item("b", "-2")];
    let pages = Arc::new(Mutex::new(0));
    let short = pages.clone();
    let answers: Vec<Box<dyn Fn() -> Result<HttpResponse, FetchError> + Send + Sync>> = vec![
        Box::new(|| json_answer("{\"error\":\"pay.unauthenticated\"}", 401)),
        Box::new(move || {
            json_answer(
                &format!(
                    "{{\"items\":[{}],\"total\":2,\"sums\":{},\"extra\":1}}",
                    two().join(","),
                    sums("5", "2", "3", 1, 1)
                ),
                200,
            )
        }),
        Box::new(thrown),
        // The items add up to 3, the sums claim 4: the list is not the whole of them.
        Box::new(move || json_answer(&page(&two(), 2, &sums("6", "2", "4", 1, 1)), 200)),
        // The total says 3 but only two items ever come.
        Box::new(move || {
            let mut n = short.lock().unwrap();
            let items = if *n == 0 { two() } else { Vec::new() };
            *n += 1;
            json_answer(&page(&items, 3, &sums("5", "2", "3", 1, 1)), 200)
        }),
        // A duplicate id across pages.
        Box::new(|| {
            json_answer(
                &page(
                    &[item("a", "5"), item("a", "5")],
                    2,
                    &sums("10", "0", "10", 2, 0),
                ),
                200,
            )
        }),
        // More than the cap: refused, not truncated.
        Box::new(|| json_answer(&page(&[], 2001, "[]"), 200)),
    ];
    for (n, answer) in answers.into_iter().enumerate() {
        let fetch = Fake::new(move |_| answer());
        assert_eq!(open_read(&fetch), OpenItemsRead::Unavailable, "answer {n}");
    }
    // The total moves between page one and page two.
    let moving = Fake::new(|req| {
        let (offset, _) = asked(req);
        if offset == 0 {
            let items: Vec<String> = (0..200).map(|i| item(&format!("m{i}"), "1")).collect();
            json_answer(&page(&items, 201, &sums("201", "0", "201", 201, 0)), 200)
        } else {
            json_answer(
                &page(&[item("m200", "1")], 202, &sums("202", "0", "202", 1, 1)),
                200,
            )
        }
    });
    assert_eq!(open_read(&moving), OpenItemsRead::Unavailable);
}

fn one_page(
    items: Vec<String>,
    held: &str,
    held_count: i64,
    unfunded: &str,
    unfunded_count: i64,
    net: &str,
) -> OpenItemsRead {
    let total = i64::try_from(items.len()).unwrap();
    let body = page(
        &items,
        total,
        &sums(held, unfunded, net, held_count, unfunded_count),
    );
    open_read(&Fake::new(move |_| json_answer(&body, 200)))
}

#[test]
fn is_unavailable_when_an_item_carries_the_wrong_sign_for_its_kind_or_a_non_positive_amount_and_keeps_when_each_was_seen()
 {
    // A held item whose signed amount is negative: the sums still add up, the sign does not.
    assert_eq!(
        one_page(
            vec![item_with("h", "5", &[("signedAmount", "\"-5\"")])],
            "5",
            1,
            "0",
            0,
            "5"
        ),
        OpenItemsRead::Unavailable
    );
    // An uncovered reversal listed as positive.
    assert_eq!(
        one_page(
            vec![item_with("r", "-2", &[("signedAmount", "\"2\"")])],
            "0",
            0,
            "2",
            1,
            "-2"
        ),
        OpenItemsRead::Unavailable
    );
    // A zero amount names nothing.
    assert_eq!(
        one_page(
            vec![item_with("z", "0", &[("kind", "\"held\"")])],
            "0",
            1,
            "0",
            0,
            "0"
        ),
        OpenItemsRead::Unavailable
    );
    // Each item keeps when svc-pay saw it, to the millisecond: the run, not the read, leaves out what its statement
    // can't hold.
    let OpenItemsRead::Items(items) = one_page(
        vec![item_with(
            "late",
            "5",
            &[("detectedAt", "\"2026-10-29T12:00:00.001Z\"")],
        )],
        "5",
        1,
        "0",
        0,
        "5",
    ) else {
        panic!("not items");
    };
    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0].item.compact(),
        "{\"source\":\"svc-pay\",\"id\":\"late\",\"kind\":\"held\",\"assetId\":\"USDT\",\"amount\":\"5\"}"
    );
    assert_eq!(items[0].seen_at, Some(ms("2026-10-29T12:00:00.001Z")));
}

#[test]
fn is_unavailable_when_two_kinds_swap_behind_a_net_and_a_total_that_still_add_up() {
    // Listed: held 5 and held 1 (net 6). Claimed: held 7 and an uncovered reversal of 1 (net 6, two items).
    let items = || vec![item("a", "5"), item("b", "1")];
    assert_eq!(
        one_page(items(), "7", 1, "1", 1, "6"),
        OpenItemsRead::Unavailable
    );
    // The same items with counts that miss: amounts agree, the count says three held.
    assert_eq!(
        one_page(items(), "6", 3, "0", 0, "6"),
        OpenItemsRead::Unavailable
    );
}

#[test]
fn sends_only_a_body_the_door_accepts() {
    let fetch = Fake::new(|_| json_answer(&page(&[], 0, "[]"), 200));
    let s = sources(
        None,
        &[],
        &fetch,
        open(&[("Not A Rail", "http://127.0.0.1:9/items")]),
    );
    assert_eq!(s.open_items("Not A Rail"), OpenItemsRead::Unavailable);
    assert!(fetch.calls().is_empty());
}
