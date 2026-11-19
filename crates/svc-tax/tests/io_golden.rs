//! The I/O golden, replayed in Rust. `crates/svc-tax/tests/fixtures/io-golden.json` holds what the TypeScript clients
//! sent (method, URL, the headers they set, body) for scripted upstream answers, and what each made of the answers; its
//! own test (`services/svc-tax/src/io-golden.test.ts`) holds the TypeScript clients to it. Here the Rust clients get the
//! same answers, and must send the same requests, signatures included, and come to the same result.
//!
//! Requests are compared as a multiset: the TypeScript walks pages with `Promise.all` and Rust with scoped threads, so
//! the order between independent reads is not fixed in either. Headers are compared as a set of pairs.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::sync::{Arc, Mutex};

use svc_tax::clients::bank::BankOwnSpaces;
use svc_tax::clients::ledger::HttpLedger;
use svc_tax::clients::prices::TradePrices;
use svc_tax::clients::venue::TradeVenueActivity;
use svc_tax::http::{FETCH_FAILED, Fetch, FetchError, HttpRequest, HttpResponse};
use svc_tax::json::{self, Json};
use svc_tax::ports::{
    AccountLine, CloseSeriesSource, Ledger, OwnSpaces, PriceAtTime, SeriesTimeframe, TradeFills,
    VenueActivity, VenueActivitySource,
};
use svc_tax::s2s::{self, CallSigner, Mode, ServiceSigner, SignedContext};
use svc_tax::tax::{Account, Failure, Range};
use svc_tax::time::Instant;

const GOLDEN: &str = include_str!("fixtures/io-golden.json");

fn golden() -> Json {
    json::parse(GOLDEN).expect("the golden is JSON")
}

fn s(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(x)) => x.clone(),
        other => panic!("{key}: not a string: {other:?}"),
    }
}

fn arr<'a>(v: &'a Json, key: &str) -> &'a [Json] {
    match v.get(key) {
        Some(Json::Array(x)) => x,
        other => panic!("{key}: not an array: {other:?}"),
    }
}

fn num(v: &Json) -> i64 {
    match v {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "epoch ms in the golden are integers"
        )]
        Json::Number(n) => *n as i64,
        other => panic!("not a number: {other:?}"),
    }
}

fn text(v: &Json) -> String {
    match v {
        Json::String(x) => x.clone(),
        other => panic!("not a string: {other:?}"),
    }
}

/// Object keys sorted at every depth: the result's shape and values, not V8's key order.
fn sorted(v: &Json) -> Json {
    match v {
        Json::Object(fields) => {
            let mut f: Vec<(String, Json)> =
                fields.iter().map(|(k, x)| (k.clone(), sorted(x))).collect();
            f.sort_by(|a, b| a.0.cmp(&b.0));
            Json::Object(f)
        }
        Json::Array(xs) => Json::Array(xs.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

// ── The fake upstream ───────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct Exchange {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    reply: Option<HttpResponse>,
}

fn exchanges(scenario: &Json) -> Vec<Exchange> {
    arr(scenario, "exchanges")
        .iter()
        .map(|x| {
            let req = x.get("request").unwrap();
            let res = x.get("response").unwrap();
            let mut headers: Vec<(String, String)> = match req.get("headers") {
                Some(Json::Array(pairs)) => pairs
                    .iter()
                    .map(|p| match p {
                        Json::Array(kv) => (text(&kv[0]).to_lowercase(), text(&kv[1])),
                        _ => panic!("a header is a pair"),
                    })
                    .collect(),
                _ => panic!("headers"),
            };
            headers.sort();
            Exchange {
                method: s(req, "method"),
                url: s(req, "url"),
                headers,
                body: match req.get("body") {
                    Some(Json::String(b)) => Some(b.clone()),
                    _ => None,
                },
                reply: res.get("status").map(|st| HttpResponse {
                    status: u16::try_from(num(st)).unwrap(),
                    body: s(res, "body"),
                }),
            }
        })
        .collect()
}

/// Answers each request with the recorded reply to the same method, URL and body, each recorded exchange once.
struct Scripted {
    left: Mutex<Vec<Exchange>>,
    sent: Mutex<Vec<Exchange>>,
}

impl Scripted {
    fn new(script: Vec<Exchange>) -> Arc<Scripted> {
        Arc::new(Scripted {
            left: Mutex::new(script),
            sent: Mutex::new(Vec::new()),
        })
    }
}

impl Fetch for Scripted {
    fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
        let mut headers: Vec<(String, String)> = req
            .headers
            .iter()
            .map(|(k, v)| (k.to_lowercase(), v.clone()))
            .collect();
        headers.sort();
        self.sent.lock().unwrap().push(Exchange {
            method: req.method.clone(),
            url: req.url.clone(),
            headers,
            body: req.body.clone(),
            reply: None,
        });
        let mut left = self.left.lock().unwrap();
        let at = left
            .iter()
            .position(|x| x.method == req.method && x.url == req.url && x.body == req.body);
        let Some(at) = at else {
            return Err(FetchError {
                message: format!("unscripted request {} {}", req.method, req.url),
            });
        };
        left.remove(at).reply.ok_or_else(|| FetchError {
            message: FETCH_FAILED.to_owned(),
        })
    }
}

fn key(x: &Exchange) -> String {
    format!("{} {} {:?} {:?}", x.method, x.url, x.headers, x.body)
}

// ── The clients, as the TypeScript builds them ──────────────────────────────────────────────────────────────────────

const NOW_S: i64 = 1_795_046_400;

fn clock() -> Arc<dyn Fn() -> i64 + Send + Sync> {
    Arc::new(|| NOW_S)
}

fn signer(v: &Json) -> Arc<ServiceSigner> {
    let ring = format!(
        r#"{{"keys":[{{"kid":"svc-tax.a","svc":"svc-tax","use":"s2s","x":"{}"}}]}}"#,
        s(v, "publicKey")
    );
    let keyring = s2s::parse_keyring(&ring).unwrap();
    let nonce = u8::try_from(num(v.get("nonceByte").unwrap())).unwrap();
    Arc::new(
        ServiceSigner::new("svc-tax", "svc-tax.a", &s(v, "pkcs8"), &keyring)
            .unwrap()
            .with_sources(clock(), Arc::new(move || Some([nonce; 16]))),
    )
}

fn call_signer(v: &Json, mode: Option<Mode>) -> CallSigner {
    let mut c = CallSigner::new(
        "svc-tax",
        "svc-ledger",
        &s(v, "secret"),
        mode.map(|m| (signer(v), m)),
    );
    c.clock = clock();
    c
}

// ── Results, in the TypeScript's canonical form ─────────────────────────────────────────────────────────────────────

fn amount(a: i128) -> Json {
    Json::str(a.to_string())
}

fn failure(f: &Failure) -> Json {
    Json::obj([(
        "error",
        match f {
            Failure::Refused(e) => Json::obj([
                ("code", Json::str(e.code)),
                ("message", Json::str(e.message.clone())),
            ]),
            Failure::Internal(m) => Json::obj([("message", Json::str(m.clone()))]),
        },
    )])
}

fn ok(v: Json) -> Json {
    Json::obj([("ok", v)])
}

fn outcome<T>(r: Result<T, Failure>, render: impl Fn(T) -> Json) -> Json {
    r.map_or_else(|f| failure(&f), |v| ok(render(v)))
}

fn line(l: &AccountLine) -> Vec<(String, Json)> {
    vec![
        ("txId".into(), Json::str(l.tx_id.clone())),
        ("postedAt".into(), Json::str(l.posted_at.iso())),
        ("assetId".into(), Json::str(l.asset_id.clone())),
        ("amount".into(), amount(l.amount)),
        ("reason".into(), Json::str(l.reason.clone())),
        (
            "direction".into(),
            Json::str(if l.debit { "debit" } else { "credit" }),
        ),
    ]
}

fn fills(t: TradeFills) -> Json {
    let mut out = vec![
        (
            "fills".to_owned(),
            Json::Array(
                t.fills
                    .iter()
                    .map(|f| {
                        let leg = |asset: &str, a: i128| {
                            Json::obj([("assetId", Json::str(asset)), ("amount", amount(a))])
                        };
                        let mut o = vec![
                            ("txId".to_owned(), Json::str(f.tx_id.clone())),
                            ("postedAt".to_owned(), Json::str(f.posted_at.iso())),
                            (
                                "received".to_owned(),
                                leg(&f.received.asset_id, f.received.amount),
                            ),
                            (
                                "paid".to_owned(),
                                f.paid
                                    .as_ref()
                                    .map_or(Json::Null, |p| leg(&p.asset_id, p.amount)),
                            ),
                            ("fee".to_owned(), f.fee.map_or(Json::Null, amount)),
                        ];
                        if let Some(a) = &f.fee_asset_id {
                            o.push(("feeAssetId".to_owned(), Json::str(a.clone())));
                        }
                        Json::Object(o)
                    })
                    .collect(),
            ),
        ),
        ("truncated".to_owned(), Json::Bool(t.truncated)),
        (
            "outsideInflows".to_owned(),
            Json::Array(
                t.outside_inflows
                    .iter()
                    .cloned()
                    .map(Json::String)
                    .collect(),
            ),
        ),
    ];
    if let Some(inflows) = t.inflows {
        out.push((
            "inflows".to_owned(),
            Json::Array(
                inflows
                    .iter()
                    .map(|i| {
                        Json::obj([
                            ("txId", Json::str(i.tx_id.clone())),
                            ("postedAt", Json::str(i.posted_at.iso())),
                            ("assetId", Json::str(i.asset_id.clone())),
                            ("amount", amount(i.amount)),
                            ("reason", Json::str(i.reason.clone())),
                        ])
                    })
                    .collect(),
            ),
        ));
    }
    if let Some(outflows) = t.outflows {
        out.push((
            "outflows".to_owned(),
            Json::Array(outflows.iter().map(|l| Json::Object(line(l))).collect()),
        ));
    }
    if let Some(holds) = t.withdrawal_holds {
        out.push((
            "withdrawalHolds".to_owned(),
            Json::Array(
                holds
                    .iter()
                    .map(|h| {
                        Json::obj([
                            ("purpose", Json::str(h.purpose.clone())),
                            (
                                "lines",
                                Json::Array(
                                    h.lines.iter().map(|l| Json::Object(line(l))).collect(),
                                ),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ));
    }
    Json::Object(out)
}

fn venue(v: VenueActivity) -> Json {
    match v {
        VenueActivity::Off => Json::obj([("state", Json::str("off"))]),
        VenueActivity::Unavailable => Json::obj([
            ("state", Json::str("unavailable")),
            ("code", Json::str("trade.venue_activity_unavailable")),
        ]),
        VenueActivity::Read { test, accounts } => Json::obj([
            ("state", Json::str("read")),
            ("test", Json::Bool(test)),
            (
                "accounts",
                Json::Array(
                    accounts
                        .into_iter()
                        .map(|a| {
                            let mut o = vec![
                                ("venueId".to_owned(), Json::str(a.venue_id)),
                                ("owner".to_owned(), Json::str(a.owner)),
                                (
                                    "subAccount".to_owned(),
                                    a.sub_account.map_or(Json::Null, Json::String),
                                ),
                                (
                                    "balances".to_owned(),
                                    Json::Array(
                                        a.balances
                                            .into_iter()
                                            .map(|b| {
                                                Json::obj([
                                                    ("asset", Json::str(b.asset)),
                                                    ("total", Json::str(b.total)),
                                                ])
                                            })
                                            .collect(),
                                    ),
                                ),
                                (
                                    "fills".to_owned(),
                                    Json::Array(
                                        a.fills
                                            .into_iter()
                                            .map(|f| {
                                                Json::obj([
                                                    ("fillId", Json::str(f.fill_id)),
                                                    ("symbol", Json::str(f.symbol)),
                                                    ("base", Json::str(f.base)),
                                                    ("quote", Json::str(f.quote)),
                                                    (
                                                        "side",
                                                        Json::str(if f.buy {
                                                            "buy"
                                                        } else {
                                                            "sell"
                                                        }),
                                                    ),
                                                    ("price", Json::str(f.price)),
                                                    ("amount", Json::str(f.amount)),
                                                    ("fee", Json::str(f.fee)),
                                                    ("feeAsset", Json::str(f.fee_asset)),
                                                    ("filledAt", Json::str(f.filled_at)),
                                                ])
                                            })
                                            .collect(),
                                    ),
                                ),
                            ];
                            if let Some(t) = a.transfers {
                                o.push((
                                    "transfers".to_owned(),
                                    Json::Array(
                                        t.into_iter()
                                            .map(|m| {
                                                Json::obj([
                                                    ("moveId", Json::str(m.move_id)),
                                                    ("subAccount", Json::str(m.sub_account)),
                                                    (
                                                        "direction",
                                                        Json::str(if m.into_sub_account {
                                                            "into_sub_account"
                                                        } else {
                                                            "out_of_sub_account"
                                                        }),
                                                    ),
                                                    ("asset", Json::str(m.asset)),
                                                    ("amount", Json::str(m.amount)),
                                                    ("settledAt", Json::str(m.settled_at)),
                                                ])
                                            })
                                            .collect(),
                                    ),
                                ));
                            }
                            if let Some(arrivals) = a.arrivals {
                                o.push((
                                    "arrivals".to_owned(),
                                    Json::Array(
                                        arrivals
                                            .into_iter()
                                            .map(|r| {
                                                Json::obj([
                                                    ("arrivalId", Json::str(r.arrival_id)),
                                                    ("kind", Json::str(r.kind)),
                                                    ("asset", Json::str(r.asset)),
                                                    ("amount", Json::str(r.amount)),
                                                    ("arrivedAt", Json::str(r.arrived_at)),
                                                ])
                                            })
                                            .collect(),
                                    ),
                                ));
                            }
                            o.push(("asOf".to_owned(), Json::str(a.as_of)));
                            Json::Object(o)
                        })
                        .collect(),
                ),
            ),
        ]),
    }
}

fn instant(iso: &str) -> Instant {
    svc_tax::time::zod_datetime(iso, true).unwrap()
}

fn play(v: &Json, scenario: &Json, fetch: Arc<Scripted>) -> Json {
    let client = s(scenario, "client");
    let call = s(scenario, "call");
    let args = arr(scenario, "args");
    match client.as_str() {
        "ledger" => {
            let mode = match scenario.get("s2s") {
                Some(Json::String(m)) if m == "dual" => Some(Mode::Dual),
                Some(Json::String(m)) if m == "keypair" => Some(Mode::Keypair),
                _ => None,
            };
            let ledger = HttpLedger::new("http://ledger.test/", call_signer(v, mode), fetch);
            match call.as_str() {
                "balances" => outcome(ledger.balances(&text(&args[0]), &text(&args[1])), |bs| {
                    Json::Array(
                        bs.into_iter()
                            .map(|b| {
                                let mut account = vec![
                                    ("ownerType".to_owned(), Json::str(b.account.owner_type)),
                                    ("ownerId".to_owned(), Json::str(b.account.owner_id)),
                                    ("assetId".to_owned(), Json::str(b.account.asset_id)),
                                    ("kind".to_owned(), Json::str(b.account.kind)),
                                ];
                                if let Some(p) = b.purpose {
                                    account.push(("purpose".to_owned(), Json::str(p)));
                                }
                                Json::obj([
                                    ("account", Json::Object(account)),
                                    ("accountId", Json::str(b.account_id)),
                                    ("amount", amount(b.amount)),
                                ])
                            })
                            .collect(),
                    )
                }),
                "history" => {
                    let a = &args[0];
                    let account = Account {
                        owner_type: s(a, "ownerType"),
                        owner_id: s(a, "ownerId"),
                        asset_id: s(a, "assetId"),
                        kind: s(a, "kind"),
                    };
                    let range = Range {
                        from: instant(&s(&args[1], "from")),
                        to: instant(&s(&args[1], "to")),
                    };
                    outcome(ledger.history(&account, range), |es| {
                        Json::Array(
                            es.into_iter()
                                .map(|e| {
                                    Json::obj([
                                        ("txId", Json::str(e.tx_id)),
                                        ("reason", Json::str(e.reason)),
                                        (
                                            "direction",
                                            Json::str(if e.debit { "debit" } else { "credit" }),
                                        ),
                                        ("amount", amount(e.amount)),
                                        ("postedAt", Json::str(e.posted_at.iso())),
                                    ])
                                })
                                .collect(),
                        )
                    })
                }
                "tradeFills" => outcome(
                    ledger.trade_fills().unwrap().trade_fills(&text(&args[0])),
                    fills,
                ),
                "spaceHistory" => {
                    let Json::Array(ids) = &args[0] else {
                        panic!("ids")
                    };
                    let ids: Vec<String> = ids.iter().map(text).collect();
                    outcome(ledger.space_history().unwrap().space_history(&ids), |h| {
                        Json::obj([
                            (
                                "lines",
                                Json::Array(
                                    h.lines
                                        .iter()
                                        .map(|l| {
                                            let mut o = line(&l.line);
                                            o.push((
                                                "spaceId".into(),
                                                Json::str(l.space_id.clone()),
                                            ));
                                            Json::Object(o)
                                        })
                                        .collect(),
                                ),
                            ),
                            ("truncated", Json::Bool(h.truncated)),
                        ])
                    })
                }
                other => panic!("ledger call {other}"),
            }
        }
        "prices" => {
            let prices = TradePrices::new("http://trade.test/", fetch);
            match call.as_str() {
                "priceAt" => outcome(
                    prices.price_at(&text(&args[0]), Instant(num(&args[1]))),
                    |p| {
                        p.map_or(Json::Null, |p| {
                            Json::obj([
                                ("price", amount(p.price)),
                                ("market", Json::str(p.market)),
                                ("timeframe", Json::str(p.timeframe)),
                                ("candleAt", Json::str(p.candle_at.iso())),
                            ])
                        })
                    },
                ),
                "closes" => {
                    let tf = SeriesTimeframe::ALL
                        .into_iter()
                        .find(|t| t.name() == text(&args[1]))
                        .unwrap();
                    outcome(
                        prices.closes(
                            &text(&args[0]),
                            tf,
                            Instant(num(&args[2])),
                            Instant(num(&args[3])),
                        ),
                        |c| {
                            c.map_or(Json::Null, |c| {
                                Json::obj([
                                    ("market", Json::str(c.market)),
                                    (
                                        "candles",
                                        Json::Array(
                                            c.candles
                                                .into_iter()
                                                .map(|(at, close)| {
                                                    Json::Array(vec![Json::int(at), amount(close)])
                                                })
                                                .collect(),
                                        ),
                                    ),
                                ])
                            })
                        },
                    )
                }
                other => panic!("prices call {other}"),
            }
        }
        "bank" | "bank-query-url" | "bank-short-secret" => {
            let url = if client == "bank-query-url" {
                "http://bank.test:4009/?x=1"
            } else {
                "http://BANK.test:4009"
            };
            let secret = if client == "bank-short-secret" {
                "short".to_owned()
            } else {
                s(v, "secret")
            };
            let bank = BankOwnSpaces::new(Some(url), Some(&secret), fetch).with_clock(clock());
            ok(bank.list(&text(&args[0])).map_or_else(
                || {
                    Json::obj([
                        ("state", Json::str("unavailable")),
                        ("code", Json::str("bank.own_spaces_unavailable")),
                    ])
                },
                |spaces| {
                    Json::obj([
                        ("state", Json::str("read")),
                        (
                            "spaces",
                            Json::Array(
                                spaces
                                    .into_iter()
                                    .map(|sp| {
                                        Json::obj([
                                            ("spaceId", Json::str(sp.space_id)),
                                            ("assetId", Json::str(sp.asset_id)),
                                            ("name", Json::str(sp.name)),
                                            ("archived", Json::Bool(sp.archived)),
                                        ])
                                    })
                                    .collect(),
                            ),
                        ),
                    ])
                },
            ))
        }
        "venue" => {
            let client = TradeVenueActivity::new(
                Some("http://trade.test/base/"),
                Some(&s(v, "secret")),
                fetch,
            )
            .with_clock(clock());
            ok(venue(client.read(&text(&args[0]))))
        }
        other => panic!("client {other}"),
    }
}

#[test]
fn every_scenario_sends_what_the_typescript_sent_and_reads_what_it_read() {
    let g = golden();
    let v = g.get("vectors").unwrap();
    let scenarios = arr(&g, "scenarios");
    assert!(
        scenarios.len() >= 40,
        "the golden holds {} scenarios",
        scenarios.len()
    );
    let mut failures = Vec::new();
    for scenario in scenarios {
        let name = s(scenario, "name");
        let script = exchanges(scenario);
        let fetch = Scripted::new(script.clone());
        let got = play(v, scenario, fetch.clone());

        let mut want: Vec<String> = script.iter().map(key).collect();
        let mut sent: Vec<String> = fetch.sent.lock().unwrap().iter().map(key).collect();
        want.sort();
        sent.sort();
        if want != sent {
            let missing: Vec<_> = want.iter().filter(|w| !sent.contains(w)).take(2).collect();
            let extra: Vec<_> = sent.iter().filter(|x| !want.contains(x)).take(2).collect();
            failures.push(format!(
                "{name}: requests differ ({} recorded, {} sent)\n  missing {missing:#?}\n  extra {extra:#?}",
                want.len(),
                sent.len()
            ));
        }

        let recorded = scenario.get("result").unwrap();
        let message_differs = matches!(scenario.get("messageDiffers"), Some(Json::Bool(true)));
        let (want, got) = if message_differs {
            // The reply the record refuses: the code must match; the message is zod's, not reproduced byte for byte.
            let code = |r: &Json| r.get("error").and_then(|e| e.get("code")).cloned();
            (
                Json::obj([("code", code(recorded).unwrap_or(Json::Null))]),
                Json::obj([("code", code(&got).unwrap_or(Json::Null))]),
            )
        } else {
            (sorted(recorded), sorted(&got))
        };
        if want != got {
            failures.push(format!(
                "{name}: result differs\n  ts:   {}\n  rust: {}",
                want.compact(),
                got.compact()
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

fn sorted_headers(h: &[(String, String)]) -> Vec<(String, String)> {
    let mut h = h.to_vec();
    h.sort();
    h
}

fn object_headers(v: &Json) -> Vec<(String, String)> {
    let Json::Object(f) = v else {
        panic!("headers")
    };
    let mut h: Vec<(String, String)> = f.iter().map(|(k, x)| (k.clone(), text(x))).collect();
    h.sort();
    h
}

#[test]
fn the_signatures_are_the_typescripts_byte_for_byte() {
    let g = golden();
    let v = g.get("vectors").unwrap();
    let legacy =
        s2s::legacy_headers("svc-tax", &s(v, "secret"), r#"{"userId":"u"}"#, NOW_S).unwrap();
    assert_eq!(
        sorted_headers(&legacy),
        object_headers(v.get("legacy").unwrap())
    );

    let v3 = signer(v)
        .headers(
            "svc-ledger",
            "post",
            "/trpc/historyPage?x=1",
            r#"{"a":1}"#,
            &SignedContext {
                principal: Some("p".into()),
                principal_signature: Some("sig".into()),
                region: Some("DE".into()),
                content_type: Some("application/json".into()),
            },
        )
        .unwrap();
    assert_eq!(sorted_headers(&v3), object_headers(v.get("v3").unwrap()));

    let dual = call_signer(v, Some(Mode::Dual))
        .sign("{}", "POST", "/trpc/balances", "application/json")
        .unwrap();
    assert_eq!(
        sorted_headers(&dual),
        object_headers(v.get("dual").unwrap())
    );
}

/// edge-trust.test.ts: each forwarded principal the TypeScript edge context accepted or refused at the golden's clock.
#[test]
fn the_edge_principal_is_trusted_as_the_typescript_trusts_it() {
    let g = golden();
    let edge = g.get("edge").unwrap();
    let secret = s(edge, "secret");
    let region = s(edge, "region");
    let cases = arr(edge, "cases");
    assert_eq!(cases.len(), 5);
    let now = Instant(NOW_S * 1000);
    for c in cases {
        let env = c.get("env").unwrap();
        let key = env.get("EDGE_PRINCIPAL_PUBLIC_KEY").map(|k| {
            let n = |name: &str| s(env, name).parse::<i64>().ok();
            svc_tax::edge::EdgeKey::from_env(
                "svc-tax",
                &text(k),
                n("EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS"),
                n("EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS"),
            )
            .unwrap()
        });
        let got = svc_tax::edge::verify_with(
            Some(&s(c, "raw")),
            Some(&s(c, "signature")),
            &secret,
            key.as_ref(),
            now,
            &region,
        )
        .map(|p| p.user_id);
        let want = match c.get("userId") {
            Some(Json::String(u)) => Some(u.clone()),
            _ => None,
        };
        assert_eq!(got, want, "{}", s(c, "name"));
    }
}
