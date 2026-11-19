//! svc-tax's reads of svc-ledger (`services/svc-tax/src/ledger-reads.ts`, `createTaxLedgerReads`): balances, history, the
//! paged history walk behind the customer's trade fills, and each named space's history. Every call is signed for
//! svc-ledger (`CallSigner`); the history page goes through its record (`LEDGER_HISTORY_PAGE`): its route, its input
//! checked before sending, its reply parsed by its schema.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use crate::http::{Fetch, HttpRequest};
use crate::json::{self, Json};
use crate::money::parse_amount;
use crate::ports::{
    AccountLine, Fill, FillLeg, InflowLine, Ledger, SpaceHistory, SpaceHistoryReader, SpaceLine,
    TaxBalance, TradeFillReader, TradeFills, WithdrawalHold,
};
use crate::s2s::CallSigner;
use crate::tax::{Account, Failure, HistoryEntry, Range, TaxError};
use crate::time::{self, Instant};
use crate::zod;

pub const TAX_LEDGER_HISTORY_UNAVAILABLE: &str = "tax.ledger_history_unavailable";

/// Entries per ledger page (the door's maximum).
pub const PAGE_LIMIT: i64 = 200;
/// A technical read bound: 200 pages of 200 entries per scope. Past it the book says it is incomplete.
pub const TRADE_FILL_PAGE_CEILING: usize = 200;
/// Hold reads (an order's, a withdrawal's, a space's) run this many at a time.
pub const HOLD_WALK_PARALLEL: usize = 8;
/// Reasons for a customer's side of a spot, convert or OTC fill.
pub const FILL_REASONS: [&str; 3] = ["trade.fill", "trade.fill.mm_maker", "trade.fill.buyback"];
/// Reasons that put the customer's own coins back on available: not new coins.
pub const OWN_COIN_RETURNS: [&str; 7] = [
    "order.hold.released",
    "order.hold.mm.released",
    "withdraw.reversed",
    "futures.margin.release",
    "token.unstake",
    "bank.earn.withdrawn",
    "trade.fill.fee.correction",
];
/// `WITHDRAWAL_HOLD_PREFIX`.
pub const WITHDRAWAL_HOLD_PREFIX: &str = "withdraw:";

/// The history page route (`LEDGER_HISTORY_PAGE.path`).
const HISTORY_PAGE_PATH: &str = "/trpc/historyPage";
const HISTORY_RAILS: [&str; 4] = [
    "crypto-native",
    "card-sandbox",
    "bank-crypto-ledger",
    "local-test",
];

/// An error as a thrown JavaScript value: a `TaxError` keeps its code; anything else is its message.
fn internal(message: impl Into<String>) -> Failure {
    Failure::Internal(message.into())
}

/// `catch (err) { if (err instanceof TaxError) throw err; throw new TaxError(TAX_LEDGER_HISTORY_UNAVAILABLE, err.message) }`.
fn history_unavailable(f: Failure) -> Failure {
    match f {
        Failure::Refused(e) => Failure::Refused(e),
        Failure::Internal(message) => Failure::Refused(TaxError {
            code: TAX_LEDGER_HISTORY_UNAVAILABLE,
            message,
        }),
    }
}

/// `rehydrateLedgerHttpError(path, status, detail)`: the message of the error it rebuilds. svc-tax only reads the message
/// (and whether it is a `TaxError`, which it never is).
pub fn rehydrate_message(path: &str, status: u16, detail: &str) -> String {
    let parsed = json::parse(detail).ok();
    let field = |k: &str| match parsed.as_ref().and_then(|p| p.get(k)) {
        Some(Json::String(s)) => Some(s.clone()),
        _ => None,
    };
    let code = field("code");
    let message = field("message").unwrap_or_else(|| detail.to_owned());
    let blob = format!("{} {message} {detail}", code.as_deref().unwrap_or(""));
    let unnamed_funds = code.is_none() && funds_text(&blob);
    if status == 400 && (code.as_deref() == Some("ledger.insufficient_funds") || unnamed_funds) {
        let from_msg = insufficient_match(&message);
        let wire = |v: Option<String>| v.filter(|s| !crate::money::js_trim(s).is_empty());
        let requested =
            wire(from_msg.as_ref().map(|m| m.1.clone())).or_else(|| wire(field("requested")));
        let available = wire(from_msg.as_ref().map(|m| m.2.clone()))
            .or_else(|| wire(field("availableBalance")));
        if let (Some(requested), Some(available)) = (requested, available) {
            let asset = from_msg
                .map(|m| m.0)
                .or_else(|| field("assetId"))
                .unwrap_or_else(|| "UNKNOWN".to_owned());
            return format!("Insufficient {asset}: requested {requested}, available {available}");
        }
    }
    if code.as_deref().is_some_and(|c| !c.is_empty()) {
        return message;
    }
    format!("svc-ledger {path} failed ({status}): {detail}")
}

/// `/insufficient_funds|Insufficient \w+:/`.
fn funds_text(blob: &str) -> bool {
    if blob.contains("insufficient_funds") {
        return true;
    }
    blob.match_indices("Insufficient ").any(|(i, m)| {
        let rest = blob.get(i + m.len()..).unwrap_or("");
        let word: usize = rest
            .bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
            .count();
        word > 0 && rest.as_bytes().get(word) == Some(&b':')
    })
}

/// `message.match(/Insufficient (\S+): requested (\S+), available (\S+)/)`: asset, requested, available.
fn insufficient_match(message: &str) -> Option<(String, String, String)> {
    let is_space = |c: char| c.is_whitespace() || crate::money::is_js_whitespace(c);
    for (i, _) in message.match_indices("Insufficient ") {
        let rest = message.get(i + "Insufficient ".len()..)?;
        let token = |s: &str| -> usize { s.find(is_space).unwrap_or(s.len()) };
        // (\S+): is greedy and backtracks to the last ':' that is followed by " requested ".
        let first_end = token(rest);
        let first = rest.get(..first_end)?;
        let Some(colon) = first.rfind(": requested").or_else(|| {
            rest.get(first_end..)
                .filter(|after| after.starts_with(" requested "))
                .and(first.strip_suffix(':').map(str::len))
        }) else {
            continue;
        };
        let asset = rest.get(..colon)?;
        if asset.is_empty() {
            continue;
        }
        let after = rest.get(colon + 1..)?;
        let Some(after) = after.strip_prefix(" requested ") else {
            continue;
        };
        let req_end = token(after);
        let requested = after.get(..req_end)?;
        let Some(comma) = requested.rfind(',') else {
            continue;
        };
        let (requested, tail) = (requested.get(..comma)?, after.get(comma + 1..)?);
        let Some(tail) = tail.strip_prefix(" available ") else {
            continue;
        };
        let available = tail.get(..token(tail))?;
        if requested.is_empty() || available.is_empty() {
            continue;
        }
        return Some((asset.to_owned(), requested.to_owned(), available.to_owned()));
    }
    None
}

/// One scope the history page walks (`PageScope`).
#[derive(Debug, Clone)]
struct Scope {
    owner_type: &'static str,
    owner_id: String,
    kind: &'static str,
    purpose: Option<String>,
}

/// One line of the ledger's history page, as its record parses it.
#[derive(Debug, Clone)]
struct PageEntry {
    tx_id: String,
    reason: String,
    debit: bool,
    amount: String,
    posted_at: String,
    asset_id: String,
    order_id: Option<String>,
    fee: Option<String>,
}

/// `new Date(e.postedAt)` for the ledger's ISO timestamps. A text that is not one would be an Invalid Date in the
/// TypeScript, carried on silently; here it is refused (`RangeError`'s text, which `toISOString` would throw later).
fn date(text: &str) -> Result<Instant, Failure> {
    time::zod_datetime(text, true).ok_or_else(|| internal("Invalid time value"))
}

fn line_of(e: &PageEntry) -> Result<AccountLine, Failure> {
    Ok(AccountLine {
        tx_id: e.tx_id.clone(),
        posted_at: date(&e.posted_at)?,
        asset_id: e.asset_id.clone(),
        amount: parse_amount(&e.amount).map_err(internal)?,
        reason: e.reason.clone(),
        debit: e.debit,
    })
}

/// `UUID_OWNER_ID_PATTERN`: a lowercase canonical UUID.
fn is_lower_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(c)
            }
        })
}

/// The ledger's reads, over HTTP.
pub struct HttpLedger {
    base: String,
    signer: CallSigner,
    fetch: Arc<dyn Fetch>,
}

impl HttpLedger {
    /// `createTaxLedgerReads(baseUrl, internalSecret, s2s)`: `signer` is `serviceCallSigner({ service: 'svc-tax',
    /// audience: 'svc-ledger', ... })`.
    pub fn new(base_url: &str, signer: CallSigner, fetch: Arc<dyn Fetch>) -> HttpLedger {
        HttpLedger {
            base: base_url.strip_suffix('/').unwrap_or(base_url).to_owned(),
            signer,
            fetch,
        }
    }

    /// POST a JSON body, signed; the reply's status and text. Transport failures are `fetch`'s own error.
    fn post(&self, path: &str, payload: String) -> Result<(u16, String), Failure> {
        let target = format!("{}{path}", self.base);
        let url =
            url::Url::parse(&target).map_err(|_| internal(format!("Invalid URL: {target}")))?;
        let signed_target = match url.query() {
            Some(q) => format!("{}?{q}", url.path()),
            None => url.path().to_owned(),
        };
        let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
        headers.extend(
            self.signer
                .sign(&payload, "POST", &signed_target, "application/json")
                .map_err(internal)?,
        );
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: target,
                headers,
                body: Some(payload),
                timeout_ms: None,
                refuse_redirect: false,
            })
            .map_err(|e| internal(e.message))?;
        Ok((res.status, res.body))
    }

    /// `call<T>(base, path, body, auth)`: a non-2xx reply is the ledger's rehydrated error; the body is JSON.
    fn call(&self, path: &str, body: &Json) -> Result<Json, Failure> {
        let (status, text) = self.post(path, body.compact())?;
        if !(200..=299).contains(&status) {
            return Err(internal(rehydrate_message(path, status, &text)));
        }
        json::parse(&text).map_err(|e| internal(e.message))
    }

    /// `/trpc/balances` for one owner: every account, with its kind, purpose and amount as the wire sent them.
    fn accounts(&self, owner_type: &str, owner_id: &str) -> Result<Vec<RawAccount>, Failure> {
        let reply = self.call(
            "/trpc/balances",
            &Json::obj([
                ("ownerType", Json::str(owner_type)),
                ("ownerId", Json::str(owner_id)),
            ]),
        )?;
        let Json::Array(rows) = reply else {
            return Err(internal("result.map is not a function"));
        };
        Ok(rows
            .iter()
            .map(|r| {
                let s = |k: &str| match r.get(k) {
                    Some(Json::String(v)) => Some(v.clone()),
                    _ => None,
                };
                RawAccount {
                    account_id: s("accountId"),
                    asset_id: s("assetId"),
                    kind: s("kind"),
                    purpose: s("purpose"),
                    amount: r.get("amount").cloned(),
                }
            })
            .collect())
    }

    /// `callHttpRecord(LEDGER_HISTORY_PAGE, ...)`: one page.
    fn page(
        &self,
        scope: &Scope,
        cursor: Option<&str>,
    ) -> Result<(Vec<PageEntry>, Option<String>), Failure> {
        let body = page_input(scope, cursor)?;
        let (status, text) = self.post(HISTORY_PAGE_PATH, body.compact())?;
        if !(200..=299).contains(&status) {
            return Err(internal(rehydrate_message(
                HISTORY_PAGE_PATH,
                status,
                &text,
            )));
        }
        let reply = json::parse(&text).map_err(|e| internal(e.message))?;
        parse_page(&reply)
    }

    /// `walkScope`: every page of one scope, newest first, up to the ceiling. A ceiling hit is reported.
    fn walk(&self, scope: &Scope) -> Result<(Vec<PageEntry>, bool), Failure> {
        let mut entries = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..TRADE_FILL_PAGE_CEILING {
            let (got, next) = self.page(scope, cursor.as_deref())?;
            entries.extend(got);
            match next {
                None => return Ok((entries, false)),
                Some(c) => cursor = Some(c),
            }
        }
        Ok((entries, true))
    }

    /// Walks several scopes `HOLD_WALK_PARALLEL` at a time, keeping their order (`Promise.all` over each batch).
    fn walk_all(&self, scopes: &[Scope]) -> Result<Vec<(Vec<PageEntry>, bool)>, Failure> {
        let mut out = Vec::with_capacity(scopes.len());
        for batch in scopes.chunks(HOLD_WALK_PARALLEL) {
            let results: Vec<Result<(Vec<PageEntry>, bool), Failure>> = std::thread::scope(|s| {
                let handles: Vec<_> = batch
                    .iter()
                    .map(|scope| s.spawn(move || self.walk(scope)))
                    .collect();
                handles
                    .into_iter()
                    .map(|h| {
                        h.join()
                            .unwrap_or_else(|_| Err(internal("ledger history read failed")))
                    })
                    .collect()
            });
            // Promise.all rejects with the first rejection in time; with every read done, the first in order.
            for r in results {
                out.push(r?);
            }
        }
        Ok(out)
    }

    fn trade_fills_inner(&self, user_id: &str) -> Result<TradeFills, Failure> {
        let user = |kind: &'static str, purpose: Option<String>| Scope {
            owner_type: "user",
            owner_id: user_id.to_owned(),
            kind,
            purpose,
        };
        let mut truncated = false;
        let (available, cut) = self.walk(&user("available", None))?;
        truncated |= cut;
        let is_fill = |r: &str| FILL_REASONS.contains(&r);
        let received: Vec<&PageEntry> = available
            .iter()
            .filter(|e| is_fill(&e.reason) && e.debit)
            .collect();
        let arrivals: Vec<&PageEntry> = available
            .iter()
            .filter(|e| {
                e.debit && !is_fill(&e.reason) && !OWN_COIN_RETURNS.contains(&e.reason.as_str())
            })
            .collect();
        let outside: BTreeSet<String> = arrivals.iter().map(|e| e.asset_id.clone()).collect();
        let inflows = arrivals
            .iter()
            .map(|e| {
                let l = line_of(e)?;
                Ok(InflowLine {
                    tx_id: l.tx_id,
                    posted_at: l.posted_at,
                    asset_id: l.asset_id,
                    amount: l.amount,
                    reason: l.reason,
                })
            })
            .collect::<Result<Vec<_>, Failure>>()?;
        let outflows = available
            .iter()
            .filter(|e| !e.debit && !is_fill(&e.reason))
            .map(line_of)
            .collect::<Result<Vec<_>, Failure>>()?;

        let mut hold_purposes: Vec<String> = Vec::new();
        for a in self.accounts("user", user_id)? {
            if a.kind.as_deref() == Some("hold")
                && let Some(p) = a.purpose
                && p.starts_with(WITHDRAWAL_HOLD_PREFIX)
                && !hold_purposes.contains(&p)
            {
                hold_purposes.push(p);
            }
        }
        let hold_scopes: Vec<Scope> = hold_purposes
            .iter()
            .map(|p| user("hold", Some(p.clone())))
            .collect();
        let mut withdrawal_holds = Vec::new();
        for (purpose, (entries, cut)) in hold_purposes.iter().zip(self.walk_all(&hold_scopes)?) {
            truncated |= cut;
            withdrawal_holds.push(WithdrawalHold {
                purpose: purpose.clone(),
                lines: entries.iter().map(line_of).collect::<Result<_, _>>()?,
            });
        }

        let mut order_ids: Vec<String> = Vec::new();
        for e in &received {
            if let Some(id) = e.order_id.as_ref().filter(|id| !id.is_empty())
                && !order_ids.contains(id)
            {
                order_ids.push(id.clone());
            }
        }
        let order_scopes: Vec<Scope> = order_ids
            .iter()
            .map(|id| user("hold", Some(format!("order:{id}"))))
            .collect();
        // Keyed by order AND transaction: a self-trade moves two of the same user's orders in one transaction.
        let mut paid_by_leg: BTreeMap<String, FillLeg> = BTreeMap::new();
        for (order_id, (holds, cut)) in order_ids.iter().zip(self.walk_all(&order_scopes)?) {
            truncated |= cut;
            for e in holds {
                if is_fill(&e.reason) && !e.debit {
                    paid_by_leg.insert(
                        format!("{order_id}|{}", e.tx_id),
                        FillLeg {
                            asset_id: e.asset_id.clone(),
                            amount: parse_amount(&e.amount).map_err(internal)?,
                        },
                    );
                }
            }
        }
        let fills = received
            .iter()
            .map(|e| {
                Ok(Fill {
                    tx_id: e.tx_id.clone(),
                    posted_at: date(&e.posted_at)?,
                    received: FillLeg {
                        asset_id: e.asset_id.clone(),
                        amount: parse_amount(&e.amount).map_err(internal)?,
                    },
                    paid: e
                        .order_id
                        .as_ref()
                        .and_then(|o| paid_by_leg.get(&format!("{o}|{}", e.tx_id)).cloned()),
                    fee: e
                        .fee
                        .as_deref()
                        .map(parse_amount)
                        .transpose()
                        .map_err(internal)?,
                    fee_asset_id: None,
                })
            })
            .collect::<Result<Vec<_>, Failure>>()?;
        Ok(TradeFills {
            fills,
            truncated,
            outside_inflows: outside.into_iter().collect(),
            inflows: Some(inflows),
            outflows: Some(outflows),
            withdrawal_holds: Some(withdrawal_holds),
        })
    }
}

struct RawAccount {
    account_id: Option<String>,
    asset_id: Option<String>,
    kind: Option<String>,
    purpose: Option<String>,
    amount: Option<Json>,
}

/// `typeof value` for a JSON value (`undefined` when absent).
fn js_typeof(v: Option<&Json>) -> &'static str {
    match v {
        None => "undefined",
        Some(Json::Null | Json::Array(_) | Json::Object(_)) => "object",
        Some(Json::Bool(_)) => "boolean",
        Some(Json::Number(_)) => "number",
        Some(Json::String(_)) => "string",
    }
}

/// `JSON.stringify(LEDGER_HISTORY_PAGE.input.parse(input))`: checked as the record checks it, in its key order.
fn page_input(scope: &Scope, cursor: Option<&str>) -> Result<Json, Failure> {
    let mut ctx = zod::Ctx::new();
    if let Some(p) = &scope.purpose {
        ctx.length(p, None, Some(128), &["purpose".to_owned()]);
    }
    if let Some(c) = cursor {
        ctx.length(c, Some(1), Some(256), &["cursor".to_owned()]);
    }
    if ctx.issues.is_empty() {
        let uuid_space = matches!(scope.owner_type, "user" | "subaccount");
        let ok = if uuid_space {
            is_lower_uuid(&scope.owner_id)
        } else {
            platform_slug(&scope.owner_id) && !is_lower_uuid(&scope.owner_id)
        };
        let space = if uuid_space {
            "a lowercase canonical UUID (identity.users.id / identity.sub_accounts.id)"
        } else {
            "a namespaced platform slug starting with a lowercase letter, e.g. \"fees:trade\" or \"rail:card-sandbox\""
        };
        ctx.custom(
            ok,
            &["ownerId".to_owned()],
            format!(
                "owner_type \"{}\" requires {space} — got \"{}\"",
                scope.owner_type, scope.owner_id
            ),
        );
    }
    if !ctx.issues.is_empty() {
        return Err(internal(zod::message(&ctx.issues)));
    }
    let mut fields = vec![
        ("ownerType".to_owned(), Json::str(scope.owner_type)),
        ("ownerId".to_owned(), Json::str(scope.owner_id.clone())),
        ("kind".to_owned(), Json::str(scope.kind)),
    ];
    if let Some(p) = &scope.purpose {
        fields.push(("purpose".to_owned(), Json::str(p.clone())));
    }
    fields.push(("limit".to_owned(), Json::int(PAGE_LIMIT)));
    if let Some(c) = cursor {
        fields.push(("cursor".to_owned(), Json::str(c)));
    }
    Ok(Json::Object(fields))
}

/// `PLATFORM_OWNER_ID_PATTERN`: `^[a-z][a-z0-9_-]*(:[A-Za-z0-9._-]+)*$`.
pub fn platform_slug(s: &str) -> bool {
    let mut parts = s.split(':');
    let head = parts.next().unwrap_or("");
    let mut hb = head.bytes();
    hb.next().is_some_and(|b| b.is_ascii_lowercase())
        && hb.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
        && parts.all(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
        })
}

/// The reply checked against `LEDGER_HISTORY_PAGE.output`: a reply that breaks it is an error, never data.
fn parse_page(reply: &Json) -> Result<(Vec<PageEntry>, Option<String>), Failure> {
    let broken = |what: &str| {
        internal(format!(
            "ledger.historyPage: the reply does not match its record ({what})"
        ))
    };
    let Json::Object(_) = reply else {
        return Err(broken("not an object"));
    };
    let Some(Json::Array(rows)) = reply.get("entries") else {
        return Err(broken("entries"));
    };
    let next = match reply.get("nextCursor") {
        Some(Json::String(s)) => Some(s.clone()),
        Some(Json::Null) => None,
        _ => return Err(broken("nextCursor")),
    };
    let mut entries = Vec::with_capacity(rows.len());
    for (i, row) in rows.iter().enumerate() {
        let at = |k: &str| format!("entries.{i}.{k}");
        let Json::Object(_) = row else {
            return Err(broken(&format!("entries.{i}")));
        };
        let string = |k: &str| match row.get(k) {
            Some(Json::String(s)) => Ok(s.clone()),
            _ => Err(broken(&at(k))),
        };
        let nullable = |k: &str| match row.get(k) {
            Some(Json::String(s)) => Ok(Some(s.clone())),
            Some(Json::Null) => Ok(None),
            _ => Err(broken(&at(k))),
        };
        let tx_id = string("txId")?;
        string("module")?;
        let reason = string("reason")?;
        let debit = match string("direction")?.as_str() {
            "debit" => true,
            "credit" => false,
            _ => return Err(broken(&at("direction"))),
        };
        let amount = string("amount")?;
        let posted_at = string("postedAt")?;
        let asset_id = string("assetId")?;
        string("entryId")?;
        if nullable("rail")?.is_some_and(|r| !HISTORY_RAILS.contains(&r.as_str())) {
            return Err(broken(&at("rail")));
        }
        if nullable("product")?.is_some_and(|p| p != "convert") {
            return Err(broken(&at("product")));
        }
        let order_id = nullable("orderId")?;
        if order_id
            .as_ref()
            .is_some_and(|o| !(1..=128).contains(&crate::s2s::js_length(o)))
        {
            return Err(broken(&at("orderId")));
        }
        let fee = nullable("fee")?;
        nullable("withdrawalId")?;
        entries.push(PageEntry {
            tx_id,
            reason,
            debit,
            amount,
            posted_at,
            asset_id,
            order_id,
            fee,
        });
    }
    Ok((entries, next))
}

impl Ledger for HttpLedger {
    fn balances(&self, owner_type: &str, owner_id: &str) -> Result<Vec<TaxBalance>, Failure> {
        self.accounts(owner_type, owner_id)?
            .into_iter()
            .map(|b| {
                let amount = match &b.amount {
                    Some(Json::String(a)) => parse_amount(a).map_err(internal)?,
                    other => {
                        return Err(internal(format!(
                            "Amount must be a decimal string, got {}",
                            js_typeof(other.as_ref())
                        )));
                    }
                };
                let purpose = b.purpose.filter(|p| !p.is_empty());
                Ok(TaxBalance {
                    account: Account {
                        owner_type: owner_type.to_owned(),
                        owner_id: owner_id.to_owned(),
                        asset_id: b.asset_id.unwrap_or_default(),
                        kind: b.kind.unwrap_or_default(),
                    },
                    purpose,
                    account_id: b.account_id.unwrap_or_default(),
                    amount,
                })
            })
            .collect()
    }

    fn history(&self, account: &Account, range: Range) -> Result<Vec<HistoryEntry>, Failure> {
        let run = || -> Result<Vec<HistoryEntry>, Failure> {
            let body = Json::obj([
                (
                    "account",
                    Json::obj([
                        ("ownerType", Json::str(account.owner_type.clone())),
                        ("ownerId", Json::str(account.owner_id.clone())),
                        ("assetId", Json::str(account.asset_id.clone())),
                        ("kind", Json::str(account.kind.clone())),
                    ]),
                ),
                ("from", Json::str(range.from.iso())),
                ("to", Json::str(range.to.iso())),
            ]);
            let Json::Array(rows) = self.call("/trpc/history", &body)? else {
                return Err(internal("result.map is not a function"));
            };
            rows.iter()
                .map(|e| {
                    let s = |k: &str| match e.get(k) {
                        Some(Json::String(v)) => v.clone(),
                        _ => String::new(),
                    };
                    Ok(HistoryEntry {
                        tx_id: s("txId"),
                        reason: s("reason"),
                        debit: s("direction") == "debit",
                        amount: parse_amount(&s("amount")).map_err(internal)?,
                        posted_at: date(&s("postedAt"))?,
                    })
                })
                .collect()
        };
        run().map_err(history_unavailable)
    }

    fn trade_fills(&self) -> Option<&dyn TradeFillReader> {
        Some(self)
    }

    fn space_history(&self) -> Option<&dyn SpaceHistoryReader> {
        Some(self)
    }
}

impl TradeFillReader for HttpLedger {
    fn trade_fills(&self, user_id: &str) -> Result<TradeFills, Failure> {
        self.trade_fills_inner(user_id).map_err(history_unavailable)
    }
}

impl SpaceHistoryReader for HttpLedger {
    fn space_history(&self, space_ids: &[String]) -> Result<SpaceHistory, Failure> {
        let run = || -> Result<SpaceHistory, Failure> {
            let scopes: Vec<Scope> = space_ids
                .iter()
                .map(|id| Scope {
                    owner_type: "subaccount",
                    owner_id: id.clone(),
                    kind: "available",
                    purpose: None,
                })
                .collect();
            let mut truncated = false;
            let mut lines = Vec::new();
            for (space_id, (entries, cut)) in space_ids.iter().zip(self.walk_all(&scopes)?) {
                truncated |= cut;
                for e in &entries {
                    lines.push(SpaceLine {
                        space_id: space_id.clone(),
                        line: line_of(e)?,
                    });
                }
            }
            Ok(SpaceHistory { lines, truncated })
        };
        run().map_err(history_unavailable)
    }
}
