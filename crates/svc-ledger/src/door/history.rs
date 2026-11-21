//! The `history` slice's service doors (`s2s-http.ts`): `history`, `historyPage` and `holdingsHistory`. Each runs past
//! `authenticate` and the door's first input check (`history` refuses a paged-history field before it); a failure is
//! `httpError`'s answer: a read's refusal is 400 with its own message, the database's failure 500.

use service_kit::json::Json;
use service_kit::money::format_amount;
use service_kit::schema::Value;
use service_kit::server::Response;
use service_kit::time::v8_date_parse;

use super::LedgerDoor;
use crate::errors::{self, Failure};
use crate::history::{
    self, AccountRef, HOLDINGS_HISTORY_MAX_ROWS, HistoryEntry, HoldingsInput, PageInput, ReadError,
};

impl From<ReadError> for Failure {
    fn from(e: ReadError) -> Failure {
        match e {
            ReadError::Refused { code, message } => Failure::ledger(code, message),
            ReadError::Store(_) => Failure::Fault,
        }
    }
}

/// A string field of the parsed input, or none when the schema let it be absent.
fn text(input: &Value, key: &str) -> Option<String> {
    match input.get(key) {
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

fn required(input: &Value, key: &str) -> String {
    text(input, key).unwrap_or_default()
}

fn number(input: &Value, key: &str) -> Option<f64> {
    match input.get(key) {
        Value::Number(n) => Some(*n),
        _ => None,
    }
}

/// `new Date(<a datetime the schema passed>)`; the schema only passes real dates, so none is never expected.
fn moment(input: &Value, key: &str) -> Result<service_kit::time::Instant, Failure> {
    v8_date_parse(&required(input, key))
        .map(service_kit::time::Instant)
        .ok_or(Failure::Fault)
}

fn field(k: &str, v: Json) -> (String, Json) {
    (k.to_owned(), v)
}

fn nullable(v: Option<String>) -> Json {
    v.map_or(Json::Null, Json::String)
}

/// One line as `handleS2sHistory` and `serializeHistoryPage` start it: decimal-string amount, ISO time.
fn line(e: &HistoryEntry) -> Vec<(String, Json)> {
    vec![
        field("txId", Json::str(e.tx_id.clone())),
        field("module", Json::str(e.module.clone())),
        field("reason", Json::str(e.reason.clone())),
        field("direction", Json::str(e.direction.clone())),
        field("amount", Json::str(format_amount(e.amount))),
        field("postedAt", Json::str(e.posted_at.iso())),
    ]
}

impl LedgerDoor {
    /// One history door, past its guard and its first input check (`input` is what that check returned).
    pub(super) fn history_door(&self, door: &str, input: &Value) -> Response {
        let out = match door {
            "history" => self.history(input),
            "historyPage" => self.history_page(input),
            "holdingsHistory" => self.holdings_history(input),
            _ => Err(Failure::Fault),
        };
        let (status, body) = match out {
            Ok(body) => (200, body),
            Err(failure) => errors::http_error(&failure),
        };
        Response {
            status,
            body: body.compact(),
        }
    }

    /// `handleS2sHistory`: a bare array, oldest first, because that is the shape svc-bank already parses.
    fn history(&self, input: &Value) -> Result<Json, Failure> {
        let account = input.get("account");
        let account = AccountRef {
            owner_type: required(account, "ownerType"),
            owner_id: required(account, "ownerId"),
            asset_id: required(account, "assetId"),
            kind: required(account, "kind"),
            purpose: text(account, "purpose"),
        };
        let range = history::history_range(moment(input, "from")?, moment(input, "to")?)?;
        let entries = history::history(&self.cfg.store, &account, range)?;
        Ok(Json::Array(
            entries.iter().map(|e| Json::Object(line(e))).collect(),
        ))
    }

    /// `handleS2sHistoryPage`: `serializeHistoryPage`, in the record's output order.
    fn history_page(&self, input: &Value) -> Result<Json, Failure> {
        let page_input = PageInput {
            owner_type: required(input, "ownerType"),
            owner_id: required(input, "ownerId"),
            kind: required(input, "kind"),
            purpose: text(input, "purpose"),
            asset_id: text(input, "assetId"),
            // The schema holds it to a whole number from 1 to 200, 50 when absent.
            #[allow(clippy::cast_possible_truncation, reason = "an integer from 1 to 200")]
            limit: number(input, "limit").map_or(50, |n| n as i64),
            cursor: text(input, "cursor"),
        };
        let page = history::history_page(&self.cfg.store, &page_input)?;
        let entries = page
            .entries
            .into_iter()
            .map(|e| {
                let mut o = line(&e.entry);
                o.extend([
                    field("assetId", Json::str(e.asset_id)),
                    field("entryId", Json::str(e.entry_id)),
                    field("rail", nullable(e.rail)),
                    field("product", nullable(e.product)),
                    field("orderId", nullable(e.order_id)),
                    field("fee", nullable(e.fee.map(format_amount))),
                    field("withdrawalId", nullable(e.withdrawal_id)),
                ]);
                Json::Object(o)
            })
            .collect();
        Ok(Json::Object(vec![
            field("entries", Json::Array(entries)),
            field("nextCursor", nullable(page.next_cursor)),
        ]))
    }

    /// `handleS2sHoldingsHistory`: `parseHoldingsHistoryInput`'s window checks, the read, `serializeHoldingsHistory`.
    fn holdings_history(&self, input: &Value) -> Result<Json, Failure> {
        // The schema holds it to one of the five buckets.
        #[allow(
            clippy::cast_possible_truncation,
            reason = "one of 60, 300, 3600, 14400, 86400"
        )]
        let bucket_seconds = number(input, "bucketSeconds").map_or(0, |n| n as i64);
        let from = history::holdings_window(
            v8_date_parse(&required(input, "from")),
            bucket_seconds,
            (self.cfg.now_ms)(),
        )?;
        let asked = HoldingsInput {
            owner_type: required(input, "ownerType"),
            owner_id: required(input, "ownerId"),
            from,
            bucket_seconds,
        };
        let read = history::holdings_history(&self.cfg.store, &asked, HOLDINGS_HISTORY_MAX_ROWS)?;
        Ok(Json::Object(vec![
            field("asOf", Json::str(read.as_of.iso())),
            field("from", Json::str(from.iso())),
            field("bucketSeconds", Json::int(bucket_seconds)),
            field(
                "holdings",
                Json::Array(
                    read.holdings
                        .into_iter()
                        .map(|h| {
                            Json::Object(vec![
                                field("assetId", Json::str(h.asset_id)),
                                field("amount", Json::str(format_amount(h.amount))),
                            ])
                        })
                        .collect(),
                ),
            ),
            field(
                "movements",
                Json::Array(
                    read.movements
                        .into_iter()
                        .map(|m| {
                            Json::Object(vec![
                                field("assetId", Json::str(m.asset_id)),
                                field("module", Json::str(m.module)),
                                field("reason", Json::str(m.reason)),
                                field("bucketStart", Json::str(m.bucket_start.iso())),
                                field("inflow", Json::str(format_amount(m.inflow))),
                                field("outflow", Json::str(format_amount(m.outflow))),
                                field("fee", Json::str(format_amount(m.fee))),
                            ])
                        })
                        .collect(),
                ),
            ),
        ]))
    }
}
