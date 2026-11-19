//! The paper drills' guards, ported from `services/svc-academy/src/paper/market-flag-verify.test.ts` (the flag is not
//! taken on trust, the real svc-trade client over a fake `fetch`), `ledger-isolation.test.ts` (a paper drill posts
//! nothing, proven by reading the source) and `paper-trading-compose-pin.test.ts` (the compose stack passes the kill).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use svc_academy::errors::Refusal;

fn code(r: &Refusal) -> String {
    match r {
        Refusal::Academy(e) => e.code.clone(),
        other => panic!("not an AcademyError: {other:?}"),
    }
}

fn message(r: &Refusal) -> String {
    match r {
        Refusal::Academy(e) => e.message.clone(),
        other => panic!("not an AcademyError: {other:?}"),
    }
}

// ── market-flag-verify.test.ts: the paper flag is not taken on trust ───────────────────────────────────────────────

mod flag_verify {
    use std::sync::{Arc, Mutex};

    use service_kit::http::{Fetch, FetchError, HttpRequest, HttpResponse, TIMED_OUT};
    use service_kit::schema::Value;
    use svc_academy::errors::Refusal;
    use svc_academy::ports::{PaperFlag, PaperFlags};
    use svc_academy::programme::paper::flag::{
        MemoryPaperFlags, TradePaperFlags, assert_caller_cannot_lie_paper_flag,
        assert_paper_markets_list_limit,
    };
    use svc_academy::programme::paper::workbook::PaperMarketRef;

    use super::{code, message};

    type Answer = Result<HttpResponse, FetchError>;
    type Reply = Box<dyn Fn(&HttpRequest) -> Answer + Send + Sync>;

    /// A fake `fetch`: records every request and answers from `reply`.
    struct FakeFetch {
        seen: Mutex<Vec<HttpRequest>>,
        reply: Reply,
    }

    impl Fetch for FakeFetch {
        fn fetch(&self, req: &HttpRequest) -> Answer {
            self.seen.lock().unwrap().push(req.clone());
            (self.reply)(req)
        }
    }

    fn fake(reply: impl Fn(&HttpRequest) -> Answer + Send + Sync + 'static) -> Arc<FakeFetch> {
        Arc::new(FakeFetch {
            seen: Mutex::new(Vec::new()),
            reply: Box::new(reply),
        })
    }

    fn body(status: u16, body: &str) -> Answer {
        Ok(HttpResponse {
            status,
            body: body.to_owned(),
        })
    }

    fn claim(id: &str, paper: bool, symbol: &str) -> PaperMarketRef {
        PaperMarketRef {
            market_id: id.to_owned(),
            paper,
            symbol: symbol.to_owned(),
        }
    }

    fn paper() -> PaperMarketRef {
        claim("mkt-paper-1", true, "PAPER/USD")
    }

    fn live_claim() -> PaperMarketRef {
        claim("mkt-live-1", true, "BTC/USDT")
    }

    fn listing() -> MemoryPaperFlags {
        MemoryPaperFlags(vec![
            PaperFlag {
                market_id: "mkt-paper-1".to_owned(),
                symbol: "PAPER/USD".to_owned(),
                paper: true,
            },
            PaperFlag {
                market_id: "mkt-live-1".to_owned(),
                symbol: "BTC/USDT".to_owned(),
                paper: false,
            },
        ])
    }

    fn refusal(port: Option<&dyn PaperFlags>, claimed: &PaperMarketRef) -> Refusal {
        assert_caller_cannot_lie_paper_flag(port, Some(claimed)).unwrap_err()
    }

    const TWO_ROWS: &str = r#"[{"id":"mkt-paper-1","symbol":"PAPER/USD","paper":true},{"id":"mkt-live-1","symbol":"BTC/USDT","paper":false}]"#;

    #[test]
    fn missing_market_is_left_to_the_loop() {
        assert!(assert_caller_cannot_lie_paper_flag(Some(&listing()), None).is_ok());
    }

    #[test]
    fn false_paper_is_left_to_the_loop_never_a_silent_live_drill() {
        let not_paper = claim("mkt-live-1", false, "BTC/USDT");
        assert!(assert_caller_cannot_lie_paper_flag(Some(&listing()), Some(&not_paper)).is_ok());
    }

    #[test]
    fn trade_url_unset_no_port_is_a_named_refusal_that_does_not_trust_paper_true() {
        assert_eq!(
            code(&refusal(None, &paper())),
            "academy.paper_flag_unverified"
        );
    }

    #[test]
    fn caller_cannot_label_a_live_listing_as_paper() {
        assert_eq!(
            code(&refusal(Some(&listing()), &live_claim())),
            "academy.paper_flag_mismatch"
        );
    }

    #[test]
    fn unlisted_claimed_paper_market_refuses_by_name() {
        let ghost = claim("mkt-ghost", true, "GHOST/USD");
        assert_eq!(
            code(&refusal(Some(&listing()), &ghost)),
            "academy.paper_market_unlisted"
        );
    }

    #[test]
    fn trade_listed_paper_true_is_accepted() {
        assert!(assert_caller_cannot_lie_paper_flag(Some(&listing()), Some(&paper())).is_ok());
    }

    #[test]
    fn id_or_symbol_mismatch_against_the_listing_refuses() {
        let lie = claim("mkt-paper-1", true, "BTC/USDT");
        assert_eq!(
            code(&refusal(Some(&listing()), &lie)),
            "academy.paper_flag_mismatch"
        );
    }

    #[test]
    fn http_listing_paper_false_refuses_mismatch_and_paper_true_accepts() {
        let fetch = fake(|_| body(200, TWO_ROWS));
        let port = TradePaperFlags::new("http://svc-trade:4004", Some(50), fetch.clone());
        assert!(assert_caller_cannot_lie_paper_flag(Some(&port), Some(&paper())).is_ok());
        assert_eq!(
            code(&refusal(Some(&port), &live_claim())),
            "academy.paper_flag_mismatch"
        );
        // The exact request: GET, unsigned, the published page size, the listing's own 3 s timer.
        let seen = fetch.seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].method, "GET");
        assert_eq!(seen[0].url, "http://svc-trade:4004/api/v1/markets?limit=50");
        assert!(seen[0].headers.is_empty());
        assert_eq!(seen[0].body, None);
        assert_eq!(seen[0].timeout_ms, Some(3_000));
    }

    #[test]
    fn unreachable_listing_refuses_unavailable_never_trusts_the_caller() {
        let port = TradePaperFlags::new(
            "http://svc-trade:4004",
            Some(50),
            fake(|_| {
                Err(FetchError {
                    message: "ECONNREFUSED".to_owned(),
                })
            }),
        );
        let e = refusal(Some(&port), &paper());
        assert_eq!(code(&e), "academy.paper_flag_unavailable");
        assert_eq!(
            message(&e),
            "Trade markets listing unreachable (ECONNREFUSED) — refuse paper drill rather than trust the caller."
        );
    }

    #[test]
    fn a_listing_that_times_out_says_aborted_as_the_typescripts_own_timer_does() {
        let port = TradePaperFlags::new(
            "http://svc-trade:4004",
            Some(50),
            fake(|_| {
                Err(FetchError {
                    message: TIMED_OUT.to_owned(),
                })
            }),
        );
        assert_eq!(
            message(&refusal(Some(&port), &paper())),
            "Trade markets listing unreachable (This operation was aborted) — refuse paper drill rather than trust the caller."
        );
    }

    #[test]
    fn unset_markets_list_limit_refuses_by_name_never_invents_50_or_fetches() {
        let fetch = fake(|_| panic!("must not fetch"));
        let port = TradePaperFlags::new("http://svc-trade:4004", None, fetch.clone());
        assert_eq!(
            code(&refusal(Some(&port), &paper())),
            "academy.paper_markets_limit_unset"
        );
        assert!(fetch.seen.lock().unwrap().is_empty());
    }

    #[test]
    fn owner_published_500_reaches_the_query_string() {
        let fetch = fake(|req| {
            assert_eq!(req.url, "http://svc-trade:4004/api/v1/markets?limit=500");
            body(
                200,
                r#"[{"id":"mkt-paper-1","symbol":"PAPER/USD","paper":true}]"#,
            )
        });
        let port = TradePaperFlags::new("http://svc-trade:4004/", Some(500), fetch);
        assert!(assert_caller_cannot_lie_paper_flag(Some(&port), Some(&paper())).is_ok());
    }

    #[test]
    fn trade_http_400_markets_limit_unset_surfaces_unavailable_never_invents_paper_true() {
        let port = TradePaperFlags::new(
            "http://svc-trade:4004",
            Some(50),
            fake(|_| body(400, r#"{"intafacedCode":"trade.markets_limit_unset"}"#)),
        );
        let e = refusal(Some(&port), &paper());
        assert_eq!(code(&e), "academy.paper_flag_unavailable");
        assert_eq!(
            message(&e),
            "Trade markets listing HTTP 400 — refuse paper drill rather than trust the caller."
        );
    }

    #[test]
    fn an_unreadable_listing_refuses_unavailable() {
        for text in ["not json", r#"{"rows":[]}"#] {
            let owned = text.to_owned();
            let port = TradePaperFlags::new(
                "http://svc-trade:4004",
                Some(50),
                fake(move |_| body(200, &owned)),
            );
            assert_eq!(
                code(&refusal(Some(&port), &paper())),
                "academy.paper_flag_unavailable",
                "{text}"
            );
        }
    }

    #[test]
    fn an_exact_id_wins_over_an_earlier_symbol_match_and_blank_rows_are_skipped() {
        let rows = r#"[{"id":"","symbol":"PAPER/USD","paper":true},{"id":"mkt-other","symbol":"PAPER/USD","paper":true},{"id":"mkt-paper-1","symbol":"PAPER/USD","paper":true}]"#;
        let port = TradePaperFlags::new(
            "http://svc-trade:4004",
            Some(50),
            fake(move |_| body(200, rows)),
        );
        let found = port.lookup("mkt-paper-1", "PAPER/USD").unwrap().unwrap();
        assert_eq!(found.market_id, "mkt-paper-1");
        // No exact id: the last symbol match stands, as the TypeScript's loop leaves it.
        let by_symbol = port.lookup("mkt-missing", "PAPER/USD").unwrap().unwrap();
        assert_eq!(by_symbol.market_id, "mkt-paper-1");
    }

    #[test]
    fn a_limit_the_options_could_hold_but_trade_would_refuse_is_refused_before_fetching() {
        let fetch = fake(|_| panic!("must not fetch"));
        let port = TradePaperFlags::new("http://svc-trade:4004", None, fetch)
            .with_limit_value(Value::Number(50.5));
        assert_eq!(
            code(&refusal(Some(&port), &paper())),
            "academy.paper_markets_limit_unset"
        );
    }

    // assertPaperMarketsListLimit matches trade 1..500

    #[test]
    fn omit_null_0_501_garbage_refuse_never_invent_50() {
        for limit in [
            Value::Undefined,
            Value::Null,
            Value::Number(f64::NAN),
            Value::Number(0.0),
            Value::Number(-1.0),
            Value::Number(501.0),
            Value::Number(50.5),
            Value::String("50".to_owned()),
        ] {
            assert!(
                assert_paper_markets_list_limit(&limit).is_err(),
                "{limit:?}"
            );
        }
        let e = assert_paper_markets_list_limit(&Value::Undefined).unwrap_err();
        assert_eq!(code(&e), "academy.paper_markets_limit_unset");
        let m = message(&e).to_lowercase();
        assert!(!m.contains("?? 50") && !m.contains("default 50"));
    }

    #[test]
    fn owner_published_1_50_and_500_are_accepted() {
        for (n, v) in [(1, 1.0), (50, 50.0), (500, 500.0)] {
            assert_eq!(
                assert_paper_markets_list_limit(&Value::Number(v)).unwrap(),
                n
            );
        }
    }

    // public-door reopen pin: paperDrill must verify before looping

    #[test]
    fn paper_drill_and_paper_drill_result_verify_the_flag_before_the_loop() {
        let src = include_str!("../src/programme/paper/mod.rs");
        let at = |needle: &str| src.find(needle).unwrap_or_else(|| panic!("{needle}"));
        let gate = at("fn gate(");
        let verify = at("assert_caller_cannot_lie_paper_flag(flag_port(ctx)");
        let spine = at("spine::kind_of(slug)");
        assert!(gate < verify && verify < spine);
        let drill = at("fn paper_drill(");
        let result = at("fn paper_drill_result(");
        let ops = at("fn paper_ops_status(ctx");
        let drill_region = &src[drill..result];
        let result_region = &src[result..ops];
        assert!(
            drill_region.find("gate(ctx").unwrap()
                < drill_region
                    .find("start_paper_drill_for_catalog_item(")
                    .unwrap()
        );
        assert!(
            result_region.find("gate(ctx").unwrap()
                < result_region.find("replay_paper_drill(").unwrap()
        );
    }

    #[test]
    fn unset_trade_url_and_markets_limit_do_not_default_to_a_silent_trust_port() {
        let env = include_str!("../src/env.rs");
        // Declared with no default: a blank URL and an owner-published limit, never `localhost:4004` or 50.
        assert!(env.contains("o.blank_url(\"TRADE_URL\");"));
        assert!(env.contains("o.owner_int(\"ACADEMY_PAPER_MARKETS_LIMIT\", 1, 500);"));
        assert!(!env.contains("localhost:4004"));
        // The handler takes the port only when TRADE_URL is set.
        let handler = include_str!("../src/programme/paper/mod.rs");
        assert!(handler.contains("get(\"TRADE_URL\")"));
        let verify = include_str!("../src/programme/paper/flag.rs");
        assert!(verify.contains("/api/v1/markets?limit={page}"));
        assert!(!verify.contains("/api/v1/markets\""));
    }
}

// ── ledger-isolation.test.ts: a paper drill posts nothing, proven by reading the source ────────────────────────────

mod ledger_isolation {
    use std::path::Path;

    /// The ledger's write surface, by the names it is reached through in TypeScript and in Rust.
    const FORBIDDEN: [(&str, &str); 16] = [
        (
            "LedgerClient",
            "the ledger client itself — a paper drill has nothing to post",
        ),
        (
            "ReadOnlyLedgerClient",
            "even the read client: a drill reads no real balance",
        ),
        ("ledger_client", "the ledger client crate"),
        (
            "recipes",
            "a ledger recipe assembles a real double-entry posting",
        ),
        (
            "recipe::",
            "a ledger recipe assembles a real double-entry posting",
        ),
        (
            "memory-ledger",
            "a second book, which §0.6 forbids outright",
        ),
        ("MemoryLedger", "a second book, which §0.6 forbids outright"),
        (
            "memory_ledger",
            "a second book, which §0.6 forbids outright",
        ),
        ("orderHold", "a recipe that must never fire for paper"),
        ("order_hold", "a recipe that must never fire for paper"),
        ("tradeFill", "a recipe that must never fire for paper"),
        ("trade_fill", "a recipe that must never fire for paper"),
        ("PostRequest", "the shape of a ledger posting"),
        ("EntryInput", "the shape of a ledger posting"),
        (".post(", "a posting call"),
        ("AccountRef", "ledger account addressing"),
    ];

    /// Every `.rs` file of the paper module, read from disk: a new file is scanned without anyone listing it.
    fn paper_sources() -> Vec<(String, String)> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/programme/paper");
        let mut out: Vec<(String, String)> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|x| x == "rs"))
            .map(|p| {
                (
                    p.file_name().unwrap().to_string_lossy().into_owned(),
                    std::fs::read_to_string(&p).unwrap(),
                )
            })
            .collect();
        out.sort();
        out
    }

    /// Only code: line comments and doc lines argue about the ledger on purpose.
    fn code_of(text: &str) -> String {
        text.lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn finds_the_paper_modules_at_all_a_scan_over_nothing_proves_nothing() {
        let names: Vec<String> = paper_sources().into_iter().map(|(n, _)| n).collect();
        for want in [
            "mod.rs",
            "workbook.rs",
            "simulated.rs",
            "ops.rs",
            "flag.rs",
            "cert_hook.rs",
            "ban.rs",
            "big.rs",
        ] {
            assert!(
                names.iter().any(|n| n == want),
                "{want} missing from {names:?}"
            );
        }
    }

    #[test]
    fn every_paper_file_reaches_no_part_of_the_ledger_write_surface() {
        for (name, text) in paper_sources() {
            let code = code_of(&text);
            let hits: Vec<String> = FORBIDDEN
                .iter()
                .filter(|(p, _)| code.contains(p))
                .map(|(p, why)| format!("{p} — {why}"))
                .collect();
            assert!(
                hits.is_empty(),
                "{name} reaches the ledger write surface:\n  {}",
                hits.join("\n  ")
            );
        }
    }

    #[test]
    fn imports_nothing_from_the_ledger_and_reads_no_port_but_the_paper_flag() {
        for (name, text) in paper_sources() {
            let code = code_of(&text);
            for line in code.lines() {
                let l = line.trim_start();
                if l.starts_with("use ") {
                    assert!(!l.to_lowercase().contains("ledger"), "{name}: {l}");
                }
                if l.contains("ports::") {
                    assert!(l.contains("PaperFlag"), "{name} reaches another port: {l}");
                }
            }
            let mut rest = code.as_str();
            while let Some(i) = rest.find("ports.") {
                rest = &rest[i + "ports.".len()..];
                assert!(
                    rest.starts_with("paper_flags"),
                    "{name} reaches ports.{}",
                    &rest[..rest.len().min(20)]
                );
            }
        }
    }

    #[test]
    fn never_re_implements_decimals_with_a_float_which_is_the_other_way_to_lie_about_money() {
        for (name, text) in paper_sources() {
            let code = code_of(&text);
            if name == "simulated.rs" || name == "big.rs" {
                assert!(
                    !code.contains("f64") && !code.contains("f32"),
                    "{name} holds money in a float"
                );
            }
            for line in code.lines() {
                let l = line.to_lowercase();
                let money = ["price", "size", "mark"].iter().any(|w| l.contains(w));
                let float = [
                    "parse::<f64>",
                    "parse::<f32>",
                    "as f64",
                    "as f32",
                    "f64::from",
                ]
                .iter()
                .any(|w| l.contains(w));
                assert!(
                    !(money && float),
                    "{name} parses money with a float: {line}"
                );
            }
        }
    }

    #[test]
    fn the_paper_handlers_hold_no_store_query() {
        // The Rust handlers stand where the router's paper region did: they never reach the database either.
        let code = code_of(include_str!("../src/programme/paper/mod.rs"));
        for word in ["ctx.store", ".query(", ".execute(", "INSERT", "UPDATE "] {
            assert!(!code.contains(word), "{word}");
        }
    }
}

// ── paper-trading-compose-pin.test.ts: the compose stack passes the paper kill into svc-academy ────────────────────

mod compose_pin {
    const COMPOSE: &str = include_str!("../../../docker-compose.apps.yml");

    /// `composeServiceBlock(compose, service)` of `@intafaced/config/compose`.
    fn service_block(compose: &str, service: &str) -> String {
        let lines: Vec<&str> = compose.split('\n').collect();
        let header = format!("  {service}:");
        let start = lines
            .iter()
            .position(|l| l.trim_end() == header)
            .unwrap_or_else(|| panic!("{service} service block missing from the compose file"));
        let mut end = start + 1;
        while end < lines.len() && (lines[end].trim().is_empty() || lines[end].starts_with("   ")) {
            end += 1;
        }
        while end > start + 1 && lines[end - 1].trim().is_empty() {
            end -= 1;
        }
        lines[start..end].join("\n") + if end < lines.len() { "\n" } else { "" }
    }

    #[test]
    fn env_rs_still_declares_academy_paper_trading_enabled_as_a_switch_default_on() {
        let env = include_str!("../src/env.rs");
        assert!(env.contains("o.switch(\"ACADEMY_PAPER_TRADING_ENABLED\");"));
        // A switch is on unless its value says off (`is_none_or`: an absent key is on).
        let at = env.find("fn switch(").unwrap();
        assert!(env[at..at + 400].contains(".is_none_or("));
    }

    #[test]
    fn compose_svc_academy_block_is_the_unique_home_of_the_key_default_true() {
        let block = service_block(COMPOSE, "svc-academy");
        assert!(block.contains("SERVICE_NAME: svc-academy"));
        assert!(
            block.contains("ACADEMY_PAPER_TRADING_ENABLED: ${ACADEMY_PAPER_TRADING_ENABLED:-true}")
        );
        let hits = COMPOSE
            .lines()
            .filter(|l| {
                l.starts_with(' ') && l.trim_start().starts_with("ACADEMY_PAPER_TRADING_ENABLED:")
            })
            .count();
        assert_eq!(
            hits, 1,
            "ACADEMY_PAPER_TRADING_ENABLED must appear once (svc-academy only)"
        );
        assert!(!block.contains("${ACADEMY_PAPER_TRADING_ENABLED:-false}"));
    }

    #[test]
    fn does_not_invent_prize_pool_or_paper_balance_keys() {
        let block = service_block(COMPOSE, "svc-academy").to_uppercase();
        assert!(!block.contains("PRIZE_POOL") && !block.contains("PAPER_BALANCE"));
    }
}
