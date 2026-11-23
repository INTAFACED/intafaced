//! svc-ledger's `historyPage` (`ledger-client.ts` `createLedgerHistoryPages`): one owner's `available` entries,
//! newest first, a page at a time. The same signing as every other ledger call, with the history budget (8 s an
//! attempt, one retry, 12 s in all). The body is exactly `{ownerType, ownerId, kind, assetId?, limit, cursor?}`: the
//! ledger's schema is strict. A failure is an `Err`, never an empty page: "no activity" and "we could not ask" must not
//! look alike.
//!
//! The TEST fault (`BANK_ACTIVITY_TEST_FAULT=on`, J-home-ia-01 #5) makes every read of the feed fail; boot refuses it
//! outside an explicit dev or test process ([`test_fault`]).

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::{Instant, js_date};

use crate::spaces::ports::{Budget, LedgerHttp};

/// `HISTORY_BUDGET`.
pub const HISTORY: Budget = Budget {
    attempt_ms: 8_000,
    retries: 1,
    deadline_ms: 12_000,
};

/// One row of `historyPage` (`LedgerPageEntry`). A field an older ledger does not send is `None` ("absent"); a field
/// it sends as null is `Some(None)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageEntry {
    pub tx_id: String,
    pub module: String,
    pub reason: String,
    /// `debit` or `credit`.
    pub direction: String,
    pub amount: Amount,
    pub posted_at: Instant,
    pub asset_id: String,
    /// The entry's position in the book, a decimal string (newer is larger); only when it is 1 to 19 digits.
    pub entry_id: Option<String>,
    pub rail: Option<Option<String>>,
    pub product: Option<Option<String>>,
    /// The page owner's own order; only a non-empty one.
    pub order_id: Option<String>,
    /// A withdrawal line's `<withdrawal id>:<attempt>`; only a non-empty one.
    pub withdrawal_id: Option<String>,
    /// On the receiving line of a fill, the fee the ledger took from it.
    pub fee: Option<Option<Amount>>,
}

/// `LedgerPageRequest`: the kind is always `available`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageRequest {
    /// `user` or `subaccount`.
    pub owner_type: &'static str,
    pub owner_id: String,
    pub asset_id: Option<String>,
    pub limit: usize,
    pub cursor: Option<String>,
}

/// One page and the ledger's cursor past it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    pub entries: Vec<PageEntry>,
    pub next_cursor: Option<String>,
}

/// The port over `historyPage`. An `Err` is a read that failed; its words are for the log only.
pub trait HistoryPages: Send + Sync {
    fn page(&self, request: &PageRequest) -> Result<Page, String>;
}

/// Nothing wired: every read fails.
pub struct NoPages;

impl HistoryPages for NoPages {
    fn page(&self, _: &PageRequest) -> Result<Page, String> {
        Err("svc-bank in Rust: no ledger history is wired".to_owned())
    }
}

/// `failingHistoryPages`: the TEST fault, every read fails as an unreachable ledger would.
pub struct FailingPages;

impl HistoryPages for FailingPages {
    fn page(&self, _: &PageRequest) -> Result<Page, String> {
        Err("BANK_ACTIVITY_TEST_FAULT: the ledger history read fails (TEST)".to_owned())
    }
}

/// `parseActivityTestFault`: blank is off, `on` is on in an explicit dev or test process only, anything else refuses.
pub fn test_fault(
    raw: Option<&str>,
    app_env: Option<&str>,
    node_env: Option<&str>,
) -> Result<bool, String> {
    let raw = match raw {
        None | Some("") => return Ok(false),
        Some(r) => r,
    };
    if raw != "on" {
        return Err(format!(
            "BANK_ACTIVITY_TEST_FAULT is \"{raw}\"; leave it unset, or set it to on"
        ));
    }
    if !matches!(app_env, Some("dev" | "test")) || node_env == Some("production") {
        return Err(
            "BANK_ACTIVITY_TEST_FAULT is a TEST fault and runs only with APP_ENV exactly dev or test"
                .to_owned(),
        );
    }
    Ok(true)
}

/// `historyPage` over svc-ledger's HTTP door.
pub struct LedgerPages(pub LedgerHttp);

fn text(j: &Json, key: &str) -> Result<String, String> {
    match j.get(key) {
        Some(Json::String(s)) => Ok(s.clone()),
        _ => Err(format!("svc-ledger historyPage: {key} is not a string")),
    }
}

/// A field the ledger may send as a string, as null, or not at all.
fn nullable(j: &Json, key: &str) -> Option<Option<String>> {
    match j.get(key) {
        Some(Json::String(s)) => Some(Some(s.clone())),
        Some(Json::Null) => Some(None),
        _ => None,
    }
}

fn non_empty(j: &Json, key: &str) -> Option<String> {
    match j.get(key) {
        Some(Json::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// One wire entry, as `createLedgerHistoryPages` maps it: the amount and fee round-tripped through the scaled integer
/// so a malformed one is refused here, never shown.
pub fn entry_of(e: &Json) -> Result<PageEntry, String> {
    let direction = text(e, "direction")?;
    if direction != "debit" && direction != "credit" {
        return Err("svc-ledger historyPage: direction".to_owned());
    }
    let posted = text(e, "postedAt")?;
    let posted_at = js_date(&posted).ok_or("svc-ledger historyPage: postedAt is not a date")?;
    let entry_id = match e.get("entryId") {
        Some(Json::String(s))
            if (1..=19).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit()) =>
        {
            Some(s.clone())
        }
        _ => None,
    };
    let fee = match e.get("fee") {
        Some(Json::String(s)) => Some(Some(parse_amount(s)?)),
        Some(Json::Null) => Some(None),
        _ => None,
    };
    Ok(PageEntry {
        tx_id: text(e, "txId")?,
        module: text(e, "module")?,
        reason: text(e, "reason")?,
        direction,
        amount: parse_amount(&text(e, "amount")?)?,
        posted_at,
        asset_id: text(e, "assetId")?,
        entry_id,
        rail: nullable(e, "rail"),
        product: nullable(e, "product"),
        order_id: non_empty(e, "orderId"),
        withdrawal_id: non_empty(e, "withdrawalId"),
        fee,
    })
}

impl HistoryPages for LedgerPages {
    fn page(&self, r: &PageRequest) -> Result<Page, String> {
        let mut body = vec![
            ("ownerType".to_owned(), Json::str(r.owner_type)),
            ("ownerId".to_owned(), Json::str(r.owner_id.clone())),
            ("kind".to_owned(), Json::str("available")),
        ];
        if let Some(a) = &r.asset_id {
            body.push(("assetId".to_owned(), Json::str(a.clone())));
        }
        #[allow(clippy::cast_possible_wrap, reason = "a page of at most 200")]
        body.push(("limit".to_owned(), Json::int(r.limit as i64)));
        if let Some(c) = &r.cursor {
            body.push(("cursor".to_owned(), Json::str(c.clone())));
        }
        let answer = self
            .0
            .call_with("/trpc/historyPage", &Json::Object(body), HISTORY)
            .map_err(|f| f.message)?;
        let Some(Json::Array(rows)) = answer.get("entries") else {
            return Err("svc-ledger historyPage: entries is not a list".to_owned());
        };
        let entries = rows.iter().map(entry_of).collect::<Result<Vec<_>, _>>()?;
        let next_cursor = match answer.get("nextCursor") {
            Some(Json::String(c)) => Some(c.clone()),
            Some(Json::Null) => None,
            _ => return Err("svc-ledger historyPage: nextCursor".to_owned()),
        };
        Ok(Page {
            entries,
            next_cursor,
        })
    }
}

/// The amount as the wire carries it.
pub fn amount_text(a: Amount) -> String {
    format_amount(a)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn the_test_fault_runs_only_on_an_explicit_dev_or_test_process() {
        assert_eq!(test_fault(None, None, None), Ok(false));
        assert_eq!(test_fault(Some(""), Some("prod"), None), Ok(false));
        assert_eq!(test_fault(Some("on"), Some("dev"), None), Ok(true));
        assert!(test_fault(Some("on"), Some("staging"), None).is_err());
        assert!(test_fault(Some("on"), Some("test"), Some("production")).is_err());
        assert!(test_fault(Some("yes"), Some("dev"), None).is_err());
    }

    #[test]
    fn an_entry_keeps_what_the_ledger_sent_and_refuses_a_malformed_amount() {
        let e = service_kit::json::parse(
            r#"{"txId":"t","module":"bank","reason":"bank.transfer.manual","direction":"debit","amount":"1.50","postedAt":"2026-01-01T00:00:00.000Z","assetId":"USDC","entryId":"12","rail":null,"orderId":"","fee":"0.1"}"#,
        )
        .unwrap();
        let got = entry_of(&e).unwrap();
        assert_eq!(amount_text(got.amount), "1.5");
        assert_eq!(got.entry_id.as_deref(), Some("12"));
        assert_eq!(got.rail, Some(None));
        assert_eq!(got.product, None);
        assert_eq!(got.order_id, None);
        assert_eq!(got.fee, Some(Some(parse_amount("0.1").unwrap())));
        let bad = service_kit::json::parse(
            r#"{"txId":"t","module":"m","reason":"r","direction":"debit","amount":"x","postedAt":"2026-01-01T00:00:00.000Z","assetId":"A"}"#,
        )
        .unwrap();
        assert!(entry_of(&bad).is_err());
    }
}
