//! The outside side of a control (`ledger/reconciliation-sources.ts`): the whole outside book, one rail's own statement,
//! and the open items svc-pay lists for a rail. No URL is `unset`, never zero; a read that fails in any way is
//! `unavailable`, never a balance.

use std::sync::Arc;
use std::time::Instant as Clock;

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};
use service_kit::schema::{Outcome as Parsed, Value};
use service_kit::time::v8_date_parse;

use crate::door;

/// `OUTSIDE_SNAPSHOT_TIMEOUT_MS`: how long one outside read may take.
pub const OUTSIDE_SNAPSHOT_TIMEOUT_MS: u64 = 10_000;
/// `PAY_CUSTODY_DEPOSIT_RECORDS_MAX_LIMIT`: svc-pay's page cap, so the fewest calls read the list.
const OPEN_ITEMS_PAGE: i64 = 200;
/// `RECONCILIATION_ITEMS_MAX`: a rail holding more open items answers ERROR, never a partial list.
const RECONCILIATION_ITEMS_MAX: i64 = 2000;

/// `SnapshotRead`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotRead {
    Unset,
    Unavailable,
    /// The balances as given (signed decimal strings), and the source's own as-of if it named one.
    Snapshot {
        as_of: Option<String>,
        balances: Vec<(String, String)>,
    },
}

/// One open item as svc-pay names it (`reconciliationReconcilingItemSchema`'s output), with when svc-pay first saw it.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenItem {
    pub item: Json,
    pub id: String,
    pub kind: String,
    pub asset_id: String,
    /// Rail minus ledger, signed.
    pub amount: Amount,
    /// `Date.parse(detectedAt)`; none where that is `NaN`, which no comparison holds for.
    pub seen_at: Option<i64>,
}

/// `OpenItemsRead`.
#[derive(Debug, Clone, PartialEq)]
pub enum OpenItemsRead {
    Unset,
    Unavailable,
    Items(Vec<OpenItem>),
}

/// `ReconciliationSources`.
pub trait Sources: Send + Sync {
    /// The whole outside book.
    fn outside_balance(&self, read_at_ms: i64) -> SnapshotRead;
    /// One rail's own outside statement: a separate method, so no source can answer a rail control with the whole book.
    fn rail_statement(&self, read_at_ms: i64, rail: &str) -> SnapshotRead;
    fn parity(&self, read_at_ms: i64) -> SnapshotRead;
    /// Whether a rail has an open-items source at all (`hasOpenItems`; a source without `openItems` has none).
    fn has_open_items(&self, _rail: &str) -> bool {
        false
    }
    /// One rail's open items as they are now.
    fn open_items(&self, _rail: &str) -> OpenItemsRead {
        OpenItemsRead::Unset
    }
}

/// `unsetReconciliationSources()`.
pub struct Unset;

impl Sources for Unset {
    fn outside_balance(&self, _: i64) -> SnapshotRead {
        SnapshotRead::Unset
    }
    fn rail_statement(&self, _: i64, _: &str) -> SnapshotRead {
        SnapshotRead::Unset
    }
    fn parity(&self, _: i64) -> SnapshotRead {
        SnapshotRead::Unset
    }
}

/// `OpenItemsSigner`: the headers that sign one call to svc-pay as svc-ledger, for this payload and URL.
pub type Signer = Arc<dyn Fn(&str, &str) -> Result<Vec<(String, String)>, String> + Send + Sync>;

/// `OpenItemsSource`: per rail, the svc-pay door that lists its open items, and how each call is signed.
pub struct OpenItemsSource {
    pub urls: Vec<(String, String)>,
    pub sign: Signer,
}

/// `reconciliationSourcesFrom(outsideSnapshotUrl, railStatementUrls, fetch, timeoutMs, openItems)`.
pub struct Http {
    pub outside_snapshot_url: Option<String>,
    pub rail_statement_urls: Vec<(String, String)>,
    pub fetch: Arc<dyn Fetch>,
    pub timeout_ms: u64,
    pub open_items: Option<OpenItemsSource>,
}

fn url_of<'a>(urls: &'a [(String, String)], rail: &str) -> Option<&'a str> {
    urls.iter()
        .find(|(r, _)| r == rail)
        .map(|(_, u)| u.as_str())
        .filter(|u| !u.is_empty())
}

/// A recorded schema on a body: its output, or none where zod refuses it.
fn parsed(name: &str, body: &Json) -> Option<Json> {
    match door::parse(name, Value::from_json(body)) {
        Ok(Parsed::Ok(out)) => out.to_json(),
        _ => None,
    }
}

fn text(j: &Json, k: &str) -> String {
    match j.get(k) {
        Some(Json::String(s)) => s.clone(),
        _ => String::new(),
    }
}

fn list<'a>(j: &'a Json, k: &str) -> &'a [Json] {
    match j.get(k) {
        Some(Json::Array(a)) => a,
        _ => &[],
    }
}

#[expect(
    clippy::cast_possible_truncation,
    reason = "each count is a whole number its schema has checked"
)]
fn whole(j: &Json, k: &str) -> i64 {
    match j.get(k) {
        Some(Json::Number(n)) => *n as i64,
        _ => 0,
    }
}

/// `new URL(base)` with each query key set (`searchParams.set`), serialized as `URLSearchParams` does.
fn with_query(base: &str, query: &[(&str, &str)]) -> Option<String> {
    let mut url = url::Url::parse(base).ok()?;
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| !query.iter().any(|(q, _)| q == k))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    {
        let mut pairs = url.query_pairs_mut();
        pairs.clear();
        for (k, v) in &kept {
            pairs.append_pair(k, v);
        }
        for (k, v) in query {
            pairs.append_pair(k, v);
        }
    }
    Some(url.into())
}

impl Http {
    /// `readOutside`: `GET <url>` with the query. A refused connection, a timeout, a redirect, a non-200 answer, a body
    /// the schema refuses or a body dated after the instant asked for is `unavailable`.
    fn read_outside(
        &self,
        base: &str,
        query: &[(&str, &str)],
        read_at_ms: i64,
        schema: &str,
        rail: Option<&str>,
    ) -> SnapshotRead {
        let Some(url) = with_query(base, query) else {
            return SnapshotRead::Unavailable;
        };
        let Ok(res) = self.fetch.fetch(&HttpRequest {
            method: "GET".to_owned(),
            url,
            headers: Vec::new(),
            body: None,
            timeout_ms: Some(self.timeout_ms),
            refuse_redirect: true,
        }) else {
            return SnapshotRead::Unavailable;
        };
        if res.status != 200 {
            return SnapshotRead::Unavailable;
        }
        let Some(read) = json::parse(&res.body).ok().and_then(|b| parsed(schema, &b)) else {
            return SnapshotRead::Unavailable;
        };
        if rail.is_some_and(|r| text(&read, "rail") != r) {
            return SnapshotRead::Unavailable;
        }
        let as_of = text(&read, "asOf");
        if v8_date_parse(&as_of).is_some_and(|at| at > read_at_ms) {
            return SnapshotRead::Unavailable;
        }
        SnapshotRead::Snapshot {
            as_of: Some(as_of),
            balances: list(&read, "balances")
                .iter()
                .map(|b| (text(b, "assetId"), text(b, "amount")))
                .collect(),
        }
    }

    /// `readOpenItems`: every open item svc-pay lists for one rail, page by page within one deadline. Every page must
    /// carry the same total and sums, and the items must add up to those sums per asset and kind by kind, in amount and
    /// in count; anything else is `unavailable`, never a partial list.
    fn read_open_items(&self, url: &str, rail: &str, sign: &Signer) -> OpenItemsRead {
        match self.open_item_pages(url, rail, sign) {
            Some(items) => OpenItemsRead::Items(items),
            None => OpenItemsRead::Unavailable,
        }
    }

    fn open_item_pages(&self, url: &str, rail: &str, sign: &Signer) -> Option<Vec<OpenItem>> {
        let started = Clock::now();
        let mut items: Vec<OpenItem> = Vec::new();
        let mut first: Option<String> = None;
        let mut total: i64 = 0;
        let mut net: Vec<(String, Amount)> = Vec::new();
        let mut by_kind: Vec<(String, Amount)> = Vec::new();
        let mut offset: i64 = 0;
        while offset == 0 || offset < total {
            let body = Json::obj([
                ("rail", Json::str(rail)),
                ("offset", Json::int(offset)),
                ("limit", Json::int(OPEN_ITEMS_PAGE)),
            ]);
            // The door's own schema: a body it would refuse is never sent.
            parsed("openItemsInput", &body)?;
            let payload = body.compact();
            let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
            headers.extend(sign(&payload, url).ok()?);
            let spent = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
            let left = self.timeout_ms.checked_sub(spent).filter(|ms| *ms > 0)?;
            let res = self
                .fetch
                .fetch(&HttpRequest {
                    method: "POST".to_owned(),
                    url: url.to_owned(),
                    headers,
                    body: Some(payload),
                    timeout_ms: Some(left),
                    refuse_redirect: true,
                })
                .ok()?;
            if res.status != 200 {
                return None;
            }
            let page = parsed("openItemsPage", &json::parse(&res.body).ok()?)?;
            let shape = Json::obj([
                ("total", page.get("total").cloned().unwrap_or(Json::Null)),
                ("sums", page.get("sums").cloned().unwrap_or(Json::Null)),
            ])
            .compact();
            match &first {
                None => {
                    first = Some(shape);
                    total = whole(&page, "total");
                    for sum in list(&page, "sums") {
                        let asset = text(sum, "assetId");
                        add(&mut net, &asset, parse_amount(&text(sum, "net")).ok()?)?;
                        tally(
                            &mut by_kind,
                            &format!("held:{asset}"),
                            parse_amount(&text(sum, "held")).ok()?,
                            i128::from(whole(sum, "heldCount")),
                        )?;
                        tally(
                            &mut by_kind,
                            &format!("reversal_unfunded:{asset}"),
                            parse_amount(&text(sum, "reversalUnfunded")).ok()?,
                            i128::from(whole(sum, "reversalUnfundedCount")),
                        )?;
                    }
                }
                Some(f) if *f != shape => return None,
                Some(_) => {}
            }
            if total > RECONCILIATION_ITEMS_MAX {
                return None;
            }
            let page_items = list(&page, "items");
            for item in page_items {
                // Each item carries its kind's sign: held is rail over ledger, an uncovered reversal ledger over rail.
                let kind = text(item, "kind");
                let amount = text(item, "amount");
                let signed = if kind == "held" {
                    amount.clone()
                } else {
                    format!("-{amount}")
                };
                if text(item, "signedAmount") != signed
                    || parse_amount(&amount).ok()? <= Amount::ZERO
                {
                    return None;
                }
                let named = parsed(
                    "reconcilingItem",
                    &Json::obj([
                        ("source", Json::str("svc-pay")),
                        ("id", Json::str(text(item, "depositId"))),
                        ("kind", Json::str(kind)),
                        ("assetId", Json::str(text(item, "assetId"))),
                        ("amount", Json::str(signed)),
                    ]),
                )?;
                items.push(OpenItem {
                    id: text(&named, "id"),
                    kind: text(&named, "kind"),
                    asset_id: text(&named, "assetId"),
                    amount: parse_amount(&text(&named, "amount")).ok()?,
                    seen_at: v8_date_parse(&text(item, "detectedAt")),
                    item: named,
                });
            }
            if page_items.is_empty() {
                break;
            }
            offset += OPEN_ITEMS_PAGE;
        }
        let count = i64::try_from(items.len()).ok()?;
        let mut ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        if count != total || i64::try_from(ids.len()).ok()? != total {
            return None;
        }
        let mut added: Vec<(String, Amount)> = Vec::new();
        let mut listed: Vec<(String, Amount)> = Vec::new();
        for i in &items {
            add(&mut added, &i.asset_id, i.amount)?;
            // Kind by kind, in amount and in count, so two kinds can never swap behind a net that still adds up.
            tally(
                &mut listed,
                &format!("{}:{}", i.kind, i.asset_id),
                i.amount.checked_abs()?,
                1,
            )?;
        }
        if !same(&added, &net) || !same(&listed, &by_kind) {
            return None;
        }
        Some(items)
    }
}

/// `add`: `amount` onto `key`'s figure; `None` when the sum leaves `i128`, so two figures past its top never clamp
/// to one value and read as equal.
fn add(into: &mut Vec<(String, Amount)>, key: &str, amount: Amount) -> Option<()> {
    match into.iter_mut().find(|(k, _)| k == key) {
        Some((_, v)) => *v = v.checked_add(amount)?,
        None => into.push((key.to_owned(), amount)),
    }
    Some(())
}

/// `tally`: one kind's amount under `key` and its count under `#key`, skipping a sum that is zero in both.
fn tally(into: &mut Vec<(String, Amount)>, key: &str, amount: Amount, count: i128) -> Option<()> {
    if amount == Amount::ZERO && count == 0 {
        return Some(());
    }
    add(into, key, amount)?;
    // The count rides in the same figures as the amounts, as the TypeScript's one bigint map holds both; it is a
    // count, not money, so it goes in as its raw integer on both sides of `same`.
    add(into, &format!("#{key}"), Amount::from_scaled(count))
}

/// Every key of either side holds the same figure on both, a missing one read as zero.
fn same(a: &[(String, Amount)], b: &[(String, Amount)]) -> bool {
    let of = |side: &[(String, Amount)], k: &str| {
        side.iter()
            .find(|(key, _)| key == k)
            .map_or(Amount::ZERO, |(_, v)| *v)
    };
    a.iter().chain(b).all(|(k, _)| of(a, k) == of(b, k))
}

impl Sources for Http {
    fn outside_balance(&self, read_at_ms: i64) -> SnapshotRead {
        let Some(url) = self
            .outside_snapshot_url
            .as_deref()
            .filter(|u| !u.is_empty())
        else {
            return SnapshotRead::Unset;
        };
        let at = service_kit::time::Instant(read_at_ms).iso();
        self.read_outside(url, &[("asOf", &at)], read_at_ms, "railSnapshot", None)
    }

    fn rail_statement(&self, read_at_ms: i64, rail: &str) -> SnapshotRead {
        let Some(url) = url_of(&self.rail_statement_urls, rail) else {
            return SnapshotRead::Unset;
        };
        let at = service_kit::time::Instant(read_at_ms).iso();
        self.read_outside(
            url,
            &[("rail", rail), ("asOf", &at)],
            read_at_ms,
            "railStatement",
            Some(rail),
        )
    }

    fn parity(&self, _: i64) -> SnapshotRead {
        SnapshotRead::Unset
    }

    fn has_open_items(&self, rail: &str) -> bool {
        self.open_items
            .as_ref()
            .is_some_and(|o| o.urls.iter().any(|(r, _)| r == rail))
    }

    fn open_items(&self, rail: &str) -> OpenItemsRead {
        let Some(source) = &self.open_items else {
            return OpenItemsRead::Unset;
        };
        let Some(url) = url_of(&source.urls, rail) else {
            return OpenItemsRead::Unset;
        };
        self.read_open_items(url, rail, &source.sign)
    }
}
