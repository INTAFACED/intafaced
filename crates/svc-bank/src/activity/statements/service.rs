//! `statements/statement-service.ts`: a signed file of the person's own posted lines. CSV for any range up to 366 days,
//! PDF for one UTC calendar month; with a space, only that one of the person's own named spaces (BK-pots-02). Neither
//! file states a balance. `report` (PF-statements-01): `statement` and `ledger` every posted line, `trades` only trade
//! lines, conversions and order fees; `balances` refuses `bank.statement_balances_unavailable`.

use base64::Engine as _;
use service_kit::json::Json;
use service_kit::time::{Instant, civil_from_days, js_date};

use super::file::{self, LineTotal};
use super::{CollectError, Deps, Line, Query, bank};
use crate::errors::Refusal;

/// The activity kinds a `trades` file reads (`TRADE_KINDS`).
const TRADE_KINDS: [&str; 3] = ["trade", "convert", "fee"];
/// `MAX_ROWS`.
pub const MAX_ROWS: usize = 5_000;
/// `MAX_SPAN_MS`: 366 days.
const MAX_SPAN_MS: i64 = 366 * 24 * 60 * 60 * 1000;

/// `isTradeLine`: a trade or conversion line, or a fee the ledger links to one of the person's orders.
fn is_trade_line(l: &Line) -> bool {
    l.kind == "trade" || l.kind == "convert" || (l.kind == "fee" && l.order_id.is_some())
}

/// `StatementRequest`: what a person asks a file for.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Request {
    pub from: String,
    pub to: String,
    pub asset_id: Option<String>,
    pub space_id: Option<String>,
    /// `csv` or `pdf`.
    pub format: String,
    /// `statement`, `ledger`, `trades` or `balances`; `None` is the account statement.
    pub report: Option<String>,
}

/// `StatementPlan`: a request that passed every check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub from: String,
    pub to: String,
    pub format: String,
    /// `statement`, `ledger` or `trades`.
    pub report: String,
    pub asset_id: Option<String>,
    /// The person's own named space: `(id, name, asset)`.
    pub space: Option<PlanSpace>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanSpace {
    pub id: String,
    pub name: String,
    pub asset_id: String,
}

/// `StatementFile`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatementFile {
    pub format: String,
    pub filename: String,
    pub content_type: String,
    pub body: Vec<u8>,
    pub sha256: String,
    pub signature: String,
    pub row_count: usize,
    /// Per asset, the net of the file's lines; a background job's stored file is handed back without it.
    pub totals: Option<Vec<LineTotal>>,
    pub generated_at: String,
    pub holder_user_id: String,
    pub from: String,
    pub to: String,
    pub asset_id: Option<String>,
    pub space_id: Option<String>,
    pub report: String,
}

fn opt(v: Option<&String>) -> Json {
    v.map_or(Json::Null, |s| Json::str(s.clone()))
}

fn count(n: usize) -> Json {
    Json::int(i64::try_from(n).unwrap_or(i64::MAX))
}

/// `lineTotalOutput`.
pub fn totals_json(totals: &[LineTotal]) -> Json {
    Json::Array(
        totals
            .iter()
            .map(|t| {
                Json::obj([
                    ("asset", Json::str(t.asset.clone())),
                    ("net", Json::str(t.net.clone())),
                    ("lines", count(t.lines)),
                ])
            })
            .collect(),
    )
}

impl StatementFile {
    /// `statementOutput`, in its keys' order.
    pub fn to_json(&self) -> Json {
        let mut fields = vec![
            ("format".to_owned(), Json::str(self.format.clone())),
            ("filename".to_owned(), Json::str(self.filename.clone())),
            (
                "contentType".to_owned(),
                Json::str(self.content_type.clone()),
            ),
            (
                "bodyBase64".to_owned(),
                Json::str(base64::engine::general_purpose::STANDARD.encode(&self.body)),
            ),
            ("sha256".to_owned(), Json::str(self.sha256.clone())),
            ("signature".to_owned(), Json::str(self.signature.clone())),
            ("rowCount".to_owned(), count(self.row_count)),
        ];
        if let Some(t) = &self.totals {
            fields.push(("totals".to_owned(), totals_json(t)));
        }
        fields.push((
            "generatedAt".to_owned(),
            Json::str(self.generated_at.clone()),
        ));
        fields.push((
            "proof".to_owned(),
            Json::obj([
                ("holderUserId", Json::str(self.holder_user_id.clone())),
                ("from", Json::str(self.from.clone())),
                ("to", Json::str(self.to.clone())),
                ("assetId", opt(self.asset_id.as_ref())),
                ("spaceId", opt(self.space_id.as_ref())),
                ("report", Json::str(self.report.clone())),
                ("rowCount", count(self.row_count)),
                ("generatedAt", Json::str(self.generated_at.clone())),
                ("sha256", Json::str(self.sha256.clone())),
            ]),
        ));
        Json::Object(fields)
    }
}

fn unavailable(message: &str) -> Refusal {
    bank("bank.statement_unavailable", message)
}

/// `Date.parse` of both ends: `None` when either is no date or the end is before the start.
fn range_ms(from: &str, to: &str) -> Option<(i64, i64)> {
    let (f, t) = (js_date(from)?.0, js_date(to)?.0);
    (f <= t).then_some((f, t))
}

/// The UTC year and month of a moment.
fn utc_month(ms: i64) -> (i64, i64) {
    let (y, m, _) = civil_from_days(ms.div_euclid(86_400_000));
    (y, m)
}

/// `StatementService.plan`: every refusal a file could meet before a line is read.
pub fn plan(d: &Deps<'_>, user_id: &str, input: &Request) -> Result<Plan, Refusal> {
    let report = input.report.as_deref().unwrap_or("statement");
    if report == "balances" {
        return Err(bank(
            "bank.statement_balances_unavailable",
            "A balance snapshot needs a past-balance read from the ledger, which is not built yet",
        ));
    }
    if d.w.cursor_secret.as_deref().unwrap_or_default().is_empty() {
        return Err(unavailable(
            "Statements are not available until the service secret is set",
        ));
    }
    let Some((from_ms, to_ms)) = range_ms(&input.from, &input.to) else {
        return Err(bank(
            "bank.statement_range",
            "The statement end is before the start",
        ));
    };
    if to_ms - from_ms > MAX_SPAN_MS {
        return Err(bank(
            "bank.statement_range",
            "A statement covers at most 366 days",
        ));
    }
    if input.format == "pdf" && utc_month(from_ms) != utc_month(to_ms) {
        return Err(bank(
            "bank.statement_pdf_one_month",
            "A PDF statement covers one UTC calendar month",
        ));
    }
    let mut space = None;
    if let Some(space_id) = &input.space_id {
        let found =
            crate::spaces::space::with(d.store(), |c| crate::spaces::space::find(c, space_id))?;
        let Some(found) = found.filter(|s| s.user_id == user_id && s.kind == "named") else {
            return Err(bank(
                "bank.space_not_found",
                &format!("Space {space_id} not found"),
            ));
        };
        if let Some(asset) = input.asset_id.as_ref().filter(|a| **a != found.asset_id) {
            return Err(bank(
                "bank.asset_mismatch",
                &format!(
                    "Space \"{}\" holds {}, not {asset}",
                    found.name, found.asset_id
                ),
            ));
        }
        space = Some(PlanSpace {
            id: found.id,
            name: found.name,
            asset_id: found.asset_id,
        });
    }
    Ok(Plan {
        from: input.from.clone(),
        to: input.to.clone(),
        format: input.format.clone(),
        report: report.to_owned(),
        asset_id: space
            .as_ref()
            .map(|s| s.asset_id.clone())
            .or_else(|| input.asset_id.clone()),
        space,
    })
}

/// `StatementService.export`: the plan, then the file as of `now`.
pub fn export(
    d: &Deps<'_>,
    user_id: &str,
    input: &Request,
    now: Instant,
) -> Result<StatementFile, Refusal> {
    let p = plan(d, user_id, input)?;
    render(d, user_id, &p, now)
}

/// `StatementService.totals` (J-bank-16 #1): per asset, the net of every posted line between two times, read and
/// folded as a statement is. Past the line cap it refuses `bank.statement_too_large` rather than total part of it.
pub fn totals(
    d: &Deps<'_>,
    user_id: &str,
    from: &str,
    to: &str,
    asset_id: Option<&str>,
) -> Result<(Vec<LineTotal>, usize), Refusal> {
    let Some((from_ms, to_ms)) = range_ms(from, to) else {
        return Err(bank("bank.statement_range", "The end is before the start"));
    };
    if to_ms - from_ms > MAX_SPAN_MS {
        return Err(bank(
            "bank.statement_range",
            "A total covers at most 366 days",
        ));
    }
    let q = Query {
        from,
        to,
        asset_id,
        account_id: None,
        kind: None,
        limit: MAX_ROWS + 1,
    };
    let items = match d.w.statements.collect.collect(d, user_id, &q) {
        Ok(items) => items,
        Err(CollectError::Unavailable(_)) => {
            return Err(unavailable(
                "Activity is not available, so no total can be worked out",
            ));
        }
        Err(e) => return Err(e.into_refusal()),
    };
    if items.len() > MAX_ROWS {
        return Err(bank(
            "bank.statement_too_large",
            &format!("A total covers at most {MAX_ROWS} lines. Narrow the dates."),
        ));
    }
    Ok((file::line_totals(&items)?, items.len()))
}

/// `StatementService.render`: the file for a planned request as of `now`. The same plan and `now` over the same lines
/// give the same bytes.
pub fn render(
    d: &Deps<'_>,
    user_id: &str,
    plan: &Plan,
    now: Instant,
) -> Result<StatementFile, Refusal> {
    let Some(secret) = d.w.cursor_secret.as_deref().filter(|s| !s.is_empty()) else {
        return Err(unavailable(
            "Statements are not available until the service secret is set",
        ));
    };
    let trades = plan.report == "trades";
    let space_id = plan.space.as_ref().map(|s| s.id.as_str());
    let q = Query {
        from: &plan.from,
        to: &plan.to,
        asset_id: plan.asset_id.as_deref(),
        account_id: space_id,
        kind: trades.then_some(&TRADE_KINDS[..]),
        limit: MAX_ROWS + 1,
    };
    let mut items = match d.w.statements.collect.collect(d, user_id, &q) {
        Ok(items) => items,
        Err(CollectError::Unavailable(_)) => {
            return Err(unavailable(
                "Activity is not available, so a statement cannot be built",
            ));
        }
        Err(CollectError::AccountUnknown) => {
            return Err(bank(
                "bank.space_not_found",
                &format!("Space {} not found", space_id.unwrap_or("undefined")),
            ));
        }
        Err(CollectError::Failed(r)) => return Err(r),
    };
    // The cap is checked on what was read, before the trades filter: a filtered count under the cap could still be
    // missing older lines.
    if items.len() > MAX_ROWS {
        return Err(bank(
            "bank.statement_too_large",
            &format!("A statement holds at most {MAX_ROWS} lines. Narrow the dates."),
        ));
    }
    if trades {
        items.retain(is_trade_line);
    }
    let generated_at = now.iso();
    let bytes = if plan.format == "csv" {
        file::statement_csv(&items).into_bytes()
    } else {
        file::statement_pdf(&file::statement_lines(&file::LinesInput {
            holder_user_id: user_id,
            from: &plan.from,
            to: &plan.to,
            generated_at: &generated_at,
            rows: &items,
            trades,
            space: plan
                .space
                .as_ref()
                .map(|s| (s.id.as_str(), s.name.as_str())),
        })?)
    };
    let (sha256, signature) = file::sign_statement(secret, &bytes);
    let day = generated_at.get(..10).unwrap_or_default();
    let scope = format!(
        "{}{}",
        plan.space
            .as_ref()
            .map(|s| format!("space-{}-", s.id.get(..8).unwrap_or(&s.id)))
            .unwrap_or_default(),
        if trades { "trades-" } else { "" }
    );
    let filename = if plan.format == "csv" {
        format!(
            "intafaced-{}{day}.csv",
            if scope.is_empty() {
                "activity-"
            } else {
                &scope
            }
        )
    } else {
        format!(
            "intafaced-{scope}{}-{}.pdf",
            if trades { "history" } else { "statement" },
            plan.from.get(..7).unwrap_or(&plan.from)
        )
    };
    Ok(StatementFile {
        format: plan.format.clone(),
        filename,
        content_type: if plan.format == "csv" {
            "text/csv; charset=utf-8"
        } else {
            "application/pdf"
        }
        .to_owned(),
        body: bytes,
        sha256,
        signature,
        row_count: items.len(),
        totals: Some(file::line_totals(&items)?),
        generated_at,
        holder_user_id: user_id.to_owned(),
        from: plan.from.clone(),
        to: plan.to.clone(),
        asset_id: plan.asset_id.clone(),
        space_id: space_id.map(str::to_owned),
        report: plan.report.clone(),
    })
}

#[cfg(test)]
mod tests {
    //! `statement.test.ts` and `statement-totals.test.ts`. The TypeScript reads its lines through a real
    //! `ActivityService` over stand-in ledger pages; here the feed is a stand-in [`Collect`] that answers the lines that
    //! feed makes of those pages (a manual transfer's debit is money in, its credit money out), within the range, asset,
    //! kinds and limit asked, as `collect` does.
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing,
        reason = "a test: a failure is the point"
    )]
    use std::collections::BTreeMap;

    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    use super::super::{Collect, CollectError, Line, Query, Wiring as StatementsWiring, jobs};
    use super::*;
    use crate::activity::Wiring;
    use crate::db::Store;
    use crate::door::{BankDoor, DoorConfig, ServiceAuth};

    const SECRET: &str = "a-bank-statement-test-secret-long-enough";
    const ALICE: &str = "11111111-1111-4111-8111-111111111111";
    const MONTH: (&str, &str) = ("2026-10-01T00:00:00.000Z", "2026-10-31T23:59:59.999Z");

    struct Book(Vec<Line>);

    impl Collect for Book {
        fn collect(&self, _: &Deps<'_>, _: &str, q: &Query<'_>) -> Result<Vec<Line>, CollectError> {
            let (from, to) = (js_date(q.from).unwrap().0, js_date(q.to).unwrap().0);
            Ok(self
                .0
                .iter()
                .filter(|l| {
                    let at = js_date(&l.posted_at).unwrap().0;
                    at >= from
                        && at <= to
                        && q.asset_id.is_none_or(|a| a == l.asset)
                        && q.kind.is_none_or(|k| k.contains(&l.kind.as_str()))
                })
                .take(q.limit)
                .cloned()
                .collect())
        }
    }

    fn line(tx: &str, kind: &str, direction: &str, amount: &str, asset: &str, at: &str) -> Line {
        Line {
            id: format!("{tx}:0"),
            kind: kind.to_owned(),
            direction: direction.to_owned(),
            asset: asset.to_owned(),
            amount: amount.to_owned(),
            posted_at: at.to_owned(),
            tx_id: tx.to_owned(),
            ..Line::default()
        }
    }

    fn one_line() -> Vec<Line> {
        vec![line(
            "tx-1",
            "transfer",
            "out",
            "12.50",
            "USDT",
            "2026-10-04T00:00:00.000Z",
        )]
    }

    fn door(secret: Option<&str>, lines: Vec<Line>) -> BankDoor {
        BankDoor::new(DoorConfig {
            edge_secret: "a-statement-unit-test-edge-secret-long".to_owned(),
            services: ServiceAuth::unwired(),
            env: BTreeMap::new(),
            now: crate::door::system_now,
            store: Store::Down("no database".to_owned()),
        })
        .unwrap()
        .with_activity(Wiring {
            cursor_secret: secret.map(str::to_owned),
            statements: StatementsWiring {
                collect: Box::new(Book(lines)),
                jobs: jobs::Config::default(),
            },
            ..Wiring::none()
        })
    }

    fn req(from: &str, to: &str, format: &str, report: Option<&str>) -> Request {
        Request {
            from: from.to_owned(),
            to: to.to_owned(),
            format: format.to_owned(),
            report: report.map(str::to_owned),
            ..Request::default()
        }
    }

    fn at(s: &str) -> Instant {
        js_date(s).unwrap()
    }

    fn code(r: Result<impl std::fmt::Debug, Refusal>) -> &'static str {
        match r {
            Err(Refusal::Bank(e)) => e.row.code,
            other => panic!("not a BankError: {other:?}"),
        }
    }

    fn text(f: &StatementFile) -> String {
        String::from_utf8(f.body.clone()).unwrap()
    }

    #[test]
    fn signs_a_csv_of_the_exact_decimal_and_does_not_state_a_balance() {
        let door = door(Some(SECRET), one_line());
        let file = door.activity_deps(at("2026-10-17T00:00:00.000Z"), |d| {
            export(
                d,
                ALICE,
                &req(
                    "2026-10-01T00:00:00.000Z",
                    "2026-10-31T23:59:59.000Z",
                    "csv",
                    None,
                ),
                d.now,
            )
            .unwrap()
        });
        let t = text(&file);
        assert!(t.contains("12.50"));
        assert!(t.contains("-12.50"));
        assert!(!t.contains("Balance"));
        assert_eq!(file.row_count, 1);
        assert_eq!(
            (
                file.holder_user_id.as_str(),
                file.to_json().get("proof").unwrap().get("sha256")
            ),
            (ALICE, Some(&Json::str(file.sha256.clone())))
        );
        assert_eq!(
            file::sign_statement(SECRET, &file.body),
            (file.sha256.clone(), file.signature.clone())
        );
        // `hkdfSync('sha256', SECRET, empty, 'bank.statement.file.v1', 32)`, then HMAC-SHA256 over the bytes.
        let prk = {
            let mut m = Hmac::<Sha256>::new_from_slice(&[0_u8; 32]).unwrap();
            m.update(SECRET.as_bytes());
            m.finalize().into_bytes()
        };
        let key = {
            let mut m = Hmac::<Sha256>::new_from_slice(&prk).unwrap();
            m.update(b"bank.statement.file.v1\x01");
            m.finalize().into_bytes()
        };
        let mut m = Hmac::<Sha256>::new_from_slice(&key).unwrap();
        m.update(&file.body);
        let hex: String = m
            .finalize()
            .into_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(file.signature, hex);
    }

    #[test]
    fn builds_a_one_month_pdf_and_refuses_a_range_that_crosses_months() {
        let door = door(Some(SECRET), one_line());
        door.activity_deps(at("2026-10-21T00:00:00.000Z"), |d| {
            let pdf = export(
                d,
                ALICE,
                &req(
                    "2026-10-01T00:00:00.000Z",
                    "2026-10-20T00:00:00.000Z",
                    "pdf",
                    None,
                ),
                d.now,
            )
            .unwrap();
            assert_eq!(&pdf.body[..8], b"%PDF-1.4");
            assert_eq!(pdf.content_type, "application/pdf");
            assert_eq!(
                code(export(
                    d,
                    ALICE,
                    &req(
                        "2026-10-01T00:00:00.000Z",
                        "2026-11-01T00:00:00.000Z",
                        "pdf",
                        None
                    ),
                    d.now
                )),
                "bank.statement_pdf_one_month"
            );
        });
    }

    #[test]
    fn draws_every_row_of_a_120_line_month_on_more_than_one_page() {
        let rows: Vec<Line> = (1..=120)
            .map(|i| {
                line(
                    &format!("T{i:03}Z"),
                    "transfer",
                    "in",
                    "1.00",
                    "USDT",
                    "2026-10-04T00:00:00.000Z",
                )
            })
            .collect();
        let door = door(Some(SECRET), rows.clone());
        let file = door.activity_deps(at("2026-10-17T00:00:00.000Z"), |d| {
            export(
                d,
                ALICE,
                &req(
                    "2026-10-01T00:00:00.000Z",
                    "2026-10-31T23:59:59.000Z",
                    "pdf",
                    None,
                ),
                d.now,
            )
            .unwrap()
        });
        let t = text(&file);
        for r in &rows {
            assert!(t.contains(&r.tx_id), "{} drawn", r.tx_id);
        }
        let count: usize = t
            .split("/Count ")
            .nth(1)
            .unwrap()
            .split(' ')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        assert!((2..=9).contains(&count));
        assert_eq!(file.row_count, 120);
        assert_eq!(
            file::sign_statement(SECRET, &file.body),
            (file.sha256.clone(), file.signature.clone())
        );
    }

    #[test]
    fn refuses_when_the_signing_secret_is_unset() {
        let door = door(None, one_line());
        door.activity_deps(at("2026-10-17T00:00:00.000Z"), |d| {
            assert_eq!(
                code(export(
                    d,
                    ALICE,
                    &req(
                        "2026-10-01T00:00:00.000Z",
                        "2026-10-02T00:00:00.000Z",
                        "csv",
                        None
                    ),
                    d.now
                )),
                "bank.statement_unavailable"
            );
        });
    }

    #[test]
    fn a_trades_file_holds_only_trade_lines_conversions_and_order_fees_names_its_report_in_its_proof_and_says_it_is_not_a_tax_form()
     {
        let when = "2026-10-04T00:00:00.000Z";
        let mut fee = line("tx-fee", "fee", "out", "0.10", "USDT", when);
        fee.order_id = Some("order-1".to_owned());
        let lines = vec![
            line("tx-convert", "convert", "in", "0.001", "BTC", when),
            line("tx-fill", "trade", "in", "0.003", "BTC", when),
            fee,
            line("tx-withdraw-fee", "fee", "out", "1.00", "USDT", when),
            line("tx-send", "transfer", "out", "12.50", "USDT", when),
        ];
        let door = door(Some(SECRET), lines);
        door.activity_deps(at("2026-11-02T00:00:00.000Z"), |d| {
            let trades = export(
                d,
                ALICE,
                &req(MONTH.0, MONTH.1, "csv", Some("trades")),
                d.now,
            )
            .unwrap();
            let csv = text(&trades);
            assert_eq!(trades.row_count, 3);
            for tx in ["tx-convert", "tx-fill", "tx-fee"] {
                assert!(csv.contains(tx));
            }
            assert!(!csv.contains("tx-send"));
            assert!(!csv.contains("tx-withdraw-fee"));
            assert_eq!(trades.report, "trades");
            assert_eq!(trades.filename, "intafaced-trades-2026-11-02.csv");
            let pdf = export(
                d,
                ALICE,
                &req(MONTH.0, MONTH.1, "pdf", Some("trades")),
                d.now,
            )
            .unwrap();
            let drawn = text(&pdf);
            assert!(drawn.contains("INTAFACED account trade history"));
            assert!(drawn.contains("Trade lines and their order fees only"));
            assert_eq!(pdf.filename, "intafaced-trades-history-2026-10.pdf");
            assert!(drawn.contains("This is not a tax form."));
            for report in ["ledger", "statement"] {
                let f =
                    export(d, ALICE, &req(MONTH.0, MONTH.1, "csv", Some(report)), d.now).unwrap();
                assert_eq!(f.row_count, 5);
                assert_eq!(f.report, report);
            }
            let again = export(
                d,
                ALICE,
                &req(MONTH.0, MONTH.1, "csv", Some("trades")),
                d.now,
            )
            .unwrap();
            assert_eq!(again.sha256, trades.sha256);
        });
    }

    #[test]
    fn refuses_a_trades_file_whose_read_reached_the_cap_even_when_dropping_fees_with_no_order_would_bring_it_under()
     {
        let when = "2026-10-04T00:00:00.000Z";
        let mut lines = vec![line("tx-withdraw-fee", "fee", "out", "1.00", "USDT", when)];
        lines.extend(
            (0..5_000).map(|i| line(&format!("tx-fill-{i}"), "trade", "in", "0.001", "BTC", when)),
        );
        let door = door(Some(SECRET), lines);
        door.activity_deps(at("2026-11-02T00:00:00.000Z"), |d| {
            assert_eq!(
                code(export(
                    d,
                    ALICE,
                    &req(MONTH.0, MONTH.1, "csv", Some("trades")),
                    d.now
                )),
                "bank.statement_too_large"
            );
        });
    }

    #[test]
    fn refuses_a_balance_snapshot_which_needs_a_past_balance_read_the_ledger_does_not_offer() {
        let door = door(Some(SECRET), one_line());
        door.activity_deps(at("2026-10-17T00:00:00.000Z"), |d| {
            assert_eq!(
                code(export(
                    d,
                    ALICE,
                    &req(
                        "2026-10-01T00:00:00.000Z",
                        "2026-10-01T23:59:59.999Z",
                        "csv",
                        Some("balances")
                    ),
                    d.now
                )),
                "bank.statement_balances_unavailable"
            );
        });
    }

    /// `statement-totals.test.ts`'s `LINES`: debit is money in, credit money out.
    fn totals_lines() -> Vec<Line> {
        let day = |n: u32| format!("2026-10-{:02}T00:00:00.000Z", 2 + n);
        vec![
            line("tx-1", "deposit", "in", "100", "USDT", &day(1)),
            line("tx-2", "deposit", "in", "50.25", "USDT", &day(2)),
            line(
                "tx-3",
                "transfer",
                "out",
                "80.000000000000000001",
                "USDT",
                &day(3),
            ),
            line("tx-4", "deposit", "in", "0.5", "BTC", &day(4)),
        ]
    }

    #[test]
    fn prints_the_same_per_asset_total_in_the_pdf_and_in_totals_as_the_activity_total_over_the_same_month()
     {
        let door = door(Some(SECRET), totals_lines());
        door.activity_deps(at("2026-11-02T00:00:00.000Z"), |d| {
            let f = export(d, ALICE, &req(MONTH.0, MONTH.1, "pdf", None), d.now).unwrap();
            let expected = vec![
                LineTotal {
                    asset: "BTC".into(),
                    net: "0.5".into(),
                    lines: 1,
                },
                LineTotal {
                    asset: "USDT".into(),
                    net: "70.249999999999999999".into(),
                    lines: 3,
                },
            ];
            assert_eq!(f.row_count, 4);
            assert_eq!(f.totals.as_ref(), Some(&expected));
            let pdf = text(&f);
            assert!(pdf.contains("Total USDT: 70.249999999999999999 \\(3 lines\\)"));
            assert!(pdf.contains("Total BTC: 0.5 \\(1 lines\\)"));
            assert!(pdf.contains("not a balance"));
            assert_eq!(
                totals(d, ALICE, MONTH.0, MONTH.1, None).unwrap(),
                (expected, 4)
            );
        });
    }

    #[test]
    fn says_a_month_with_no_lines_has_none_and_totals_it_as_an_empty_list() {
        let door = door(Some(SECRET), Vec::new());
        door.activity_deps(at("2026-11-02T00:00:00.000Z"), |d| {
            let f = export(d, ALICE, &req(MONTH.0, MONTH.1, "pdf", None), d.now).unwrap();
            assert_eq!(f.totals, Some(Vec::new()));
            assert!(text(&f).contains("No lines in this period."));
            assert_eq!(
                totals(d, ALICE, MONTH.0, MONTH.1, None).unwrap(),
                (Vec::new(), 0)
            );
        });
    }

    #[test]
    fn refuses_a_backwards_or_over_long_range_and_a_range_past_the_line_cap_never_totalling_part_of_it()
     {
        let small = door(Some(SECRET), totals_lines());
        small.activity_deps(at("2026-11-02T00:00:00.000Z"), |d| {
            assert_eq!(
                code(totals(d, ALICE, MONTH.1, MONTH.0, None)),
                "bank.statement_range"
            );
            assert_eq!(
                code(totals(
                    d,
                    ALICE,
                    "2025-01-01T00:00:00.000Z",
                    "2026-10-31T00:00:00.000Z",
                    None
                )),
                "bank.statement_range"
            );
        });
        let many: Vec<Line> = (0..5_001)
            .map(|i| {
                line(
                    &format!("tx-{i}"),
                    "deposit",
                    "in",
                    "1",
                    "USDT",
                    "2026-10-03T00:00:00.000Z",
                )
            })
            .collect();
        let big = door(Some(SECRET), many);
        big.activity_deps(at("2026-11-02T00:00:00.000Z"), |d| {
            assert_eq!(
                code(totals(d, ALICE, MONTH.0, MONTH.1, None)),
                "bank.statement_too_large"
            );
        });
    }

    #[test]
    fn the_router_answers_a_bank_error_with_its_status_and_its_code_after_the_words() {
        let e = super::super::procedure_error(super::super::bank(
            "bank.statement_jobs_unset",
            "Background exports are not switched on in this build",
        ));
        assert_eq!(
            (e.code, e.message.as_str(), e.cause.as_deref()),
            (
                "SERVICE_UNAVAILABLE",
                "Background exports are not switched on in this build (bank.statement_jobs_unset)",
                Some("bank.statement_jobs_unset")
            )
        );
        let e = super::super::procedure_error(super::super::bank(
            "bank.space_not_found",
            "Space x not found",
        ));
        assert_eq!(e.code, "BAD_REQUEST");
        let e = super::super::procedure_error(Refusal::Other("replay stub: sql".to_owned()));
        assert_eq!(
            (e.code, e.message.as_str()),
            ("INTERNAL_SERVER_ERROR", "replay stub: sql")
        );
    }
}
