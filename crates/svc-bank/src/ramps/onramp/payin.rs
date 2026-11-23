//! THE ADD-MONEY PAY-IN STAND-IN, A TEST FIXTURE (`ramps/payin-sim.ts`, `ramp-partner-book.ts`,
//! `test-ramp-partner-record.ts`; J-bank-02 #3, #5, J-bank-28 #3).
//!
//! `BANK_ONRAMP_PARTNER=payin-sim` opens a TEST payment page served by this service for the hosted ways to pay its
//! catalogue lists (`BANK_PAYIN_SIM_JSON`), and answers a bank transfer with its own TEST reference and account when the
//! catalogue names one. It takes no money: "paid" is the partner's signed job call, and the credit moves value only
//! through the ledger's deposit recipe from its own TEST rail boundary (`payin-sim`). It keeps its own book of the
//! orders it opened, which it reports to the finance desk and on loopback. Outside an explicit dev or test process, over
//! a blank or unreadable catalogue, or without loopback page and return addresses, the service refuses to start.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, MutexGuard, PoisonError};

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::money::js_trim;
use service_kit::schema::Value;
use service_kit::time::Instant;

use super::ports::{BankInstruction, Instruction, OpenAsk, PaymentPort};
use super::shape::{field, hex0x, js_len, strict, string, test_label};
use crate::errors::Refusal;

/// `ONRAMP_PARTNER_SETTINGS`.
pub const SETTINGS: [&str; 2] = ["none", "payin-sim"];

/// `PAYIN_SIM_RAIL`: the ledger rail boundary the stand-in's pay-ins arrive from.
pub const PAYIN_SIM_RAIL: &str = "payin-sim";

const HOSTED_METHODS: [&str; 3] = ["pay_by_bank", "card", "wallet_pay"];

/// The typed catalogue (`PayinSimCatalogue`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Catalogue {
    pub label: String,
    pub methods: Vec<String>,
    /// The TEST account a bank transfer is paid to: its name and reference.
    pub bank_transfer: Option<(String, String)>,
}

/// `parsePayinSim`: the typed catalogue, or `None` when it is blank, not JSON, not labelled TEST, out of shape or lists
/// a way to pay twice.
pub fn parse(raw: Option<&str>) -> Option<Catalogue> {
    let raw = raw.filter(|r| !js_trim(r).is_empty())?;
    let j = json::parse(raw).ok()?;
    let f = strict(&j, &["label", "methods", "bankTransfer"])?;
    let label = string(f, "label").filter(|s| test_label(s))?;
    let Some(Json::Array(items)) = field(f, "methods") else {
        return None;
    };
    if items.is_empty() {
        return None;
    }
    let methods = items
        .iter()
        .map(|m| match m {
            Json::String(s) if HOSTED_METHODS.contains(&s.as_str()) => Some(s.clone()),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    let mut unique = methods.clone();
    unique.sort();
    unique.dedup();
    if unique.len() != methods.len() {
        return None;
    }
    let bank_transfer = match field(f, "bankTransfer") {
        None => None,
        Some(b) => {
            let b = strict(b, &["accountName", "accountRef"])?;
            let name = string(b, "accountName").filter(|s| test_label(s) && js_len(s) <= 140)?;
            let reference = string(b, "accountRef").filter(|s| (1..=64).contains(&js_len(s)))?;
            Some((name.to_owned(), reference.to_owned()))
        }
    };
    Some(Catalogue {
        label: label.to_owned(),
        methods,
        bank_transfer,
    })
}

/// `payinSimReference`: the stand-in's own reference for one bank transfer, from the payment's id.
pub fn reference(onramp_id: &str) -> String {
    let compact: String = onramp_id.chars().filter(|c| *c != '-').take(12).collect();
    format!("TEST-{}", compact.to_uppercase())
}

/// `isLoopbackHost`: the one list of loopback names the stand-in and the hosted-page check share.
pub fn is_loopback_host(url: &url::Url) -> bool {
    matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
}

/// `loopbackBase`: a loopback http(s) base address with no query, fragment or credentials.
fn loopback_base(raw: Option<&str>) -> Option<url::Url> {
    let raw = js_trim(raw?);
    if raw.is_empty() {
        return None;
    }
    let url = url::Url::parse(raw).ok()?;
    let ok = is_loopback_host(&url)
        && matches!(url.scheme(), "http" | "https")
        && url.query().is_none_or(str::is_empty)
        && url.fragment().is_none_or(str::is_empty)
        && url.username().is_empty()
        && url.password().is_none_or(str::is_empty);
    ok.then_some(url)
}

// ---------------------------------------------------------------------------------------------------------------
// The partner's own book (`ramp-partner-book.ts`)

/// `RAMP_PARTNER_ORDER_STATES`.
pub const ORDER_STATES: [&str; 5] = ["opened", "approved", "paid", "returned", "expired"];

/// The most orders the book keeps (`MAX_ORDERS`); past it the oldest is dropped.
const MAX_ORDERS: usize = 100_000;
/// How many of the newest quote expiries the report lists (`LATEST_EXPIRIES`).
const LATEST_EXPIRIES: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Order {
    opened_at: Instant,
    quote_expires_at: Option<Instant>,
    approved_at: Option<Instant>,
    paid_at: Option<Instant>,
    returned_at: Option<Instant>,
}

fn state_of(o: &Order, now: Instant) -> &'static str {
    if o.returned_at.is_some() {
        "returned"
    } else if o.paid_at.is_some() {
        "paid"
    } else if o.approved_at.is_some() {
        "approved"
    } else if o.quote_expires_at.is_some_and(|e| e.0 <= now.0) {
        "expired"
    } else {
        "opened"
    }
}

/// What the partner reports of its orders (`RampPartnerReport`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub label: String,
    pub as_of: Instant,
    pub last_opened_at: Option<Instant>,
    pub last_paid_at: Option<Instant>,
    /// Every state in `ORDER_STATES`' order, with its count.
    pub orders: Vec<(&'static str, i64)>,
    pub expiries: i64,
    /// The newest expiries first: order id and when its quote ran out.
    pub latest: Vec<(String, Instant)>,
}

/// The stand-in's book (`rampPartnerBook`), kept in its process, in the order each order was opened.
#[derive(Debug, Default)]
pub struct Book {
    next: u64,
    by_seq: BTreeMap<u64, (String, Order)>,
    seq_of: HashMap<String, u64>,
}

impl Book {
    fn at(&mut self, id: &str) -> Option<&mut Order> {
        let seq = *self.seq_of.get(id)?;
        self.by_seq.get_mut(&seq).map(|(_, o)| o)
    }

    pub fn opened(&mut self, id: &str, quote_expires_at: Option<Instant>, now: Instant) {
        if self.seq_of.contains_key(id) {
            return;
        }
        if self.seq_of.len() >= MAX_ORDERS
            && let Some((_, (oldest, _))) = self.by_seq.pop_first()
        {
            self.seq_of.remove(&oldest);
        }
        let seq = self.next;
        self.next = self.next.saturating_add(1);
        self.seq_of.insert(id.to_owned(), seq);
        self.by_seq.insert(
            seq,
            (
                id.to_owned(),
                Order {
                    opened_at: now,
                    quote_expires_at,
                    approved_at: None,
                    paid_at: None,
                    returned_at: None,
                },
            ),
        );
    }

    pub fn approved(&mut self, id: &str, now: Instant) {
        if let Some(o) = self.at(id)
            && o.approved_at.is_none()
        {
            o.approved_at = Some(now);
        }
    }

    pub fn paid(&mut self, id: &str, now: Instant) {
        if let Some(o) = self.at(id)
            && o.paid_at.is_none()
        {
            o.paid_at = Some(now);
        }
    }

    pub fn returned(&mut self, id: &str, now: Instant) {
        if let Some(o) = self.at(id)
            && o.paid_at.is_some()
            && o.returned_at.is_none()
        {
            o.returned_at = Some(now);
        }
    }

    /// LOCAL TEST age door: the partner's clock passes `ms` for one order. False for one it never opened.
    pub fn age(&mut self, id: &str, ms: i64) -> bool {
        let Some(o) = self.at(id) else {
            return false;
        };
        if ms <= 0 {
            return false;
        }
        o.opened_at = Instant(o.opened_at.0.saturating_sub(ms));
        if let Some(e) = o.quote_expires_at {
            o.quote_expires_at = Some(Instant(e.0.saturating_sub(ms)));
        }
        true
    }

    pub fn report(&self, label: &str, now: Instant) -> Report {
        let mut counts = [0i64; 5];
        let mut expiries: Vec<(String, Instant)> = Vec::new();
        let mut last_opened_at: Option<Instant> = None;
        let mut last_paid_at: Option<Instant> = None;
        for (id, o) in self.by_seq.values() {
            let state = state_of(o, now);
            if let Some(i) = ORDER_STATES.iter().position(|s| *s == state)
                && let Some(c) = counts.get_mut(i)
            {
                *c += 1;
            }
            if state == "expired"
                && let Some(e) = o.quote_expires_at
            {
                expiries.push((id.clone(), e));
            }
            if last_opened_at.is_none_or(|l| o.opened_at.0 > l.0) {
                last_opened_at = Some(o.opened_at);
            }
            if let Some(p) = o.paid_at
                && last_paid_at.is_none_or(|l| p.0 > l.0)
            {
                last_paid_at = Some(p);
            }
        }
        expiries.sort_by_key(|e| std::cmp::Reverse(e.1.0));
        let count = i64::try_from(expiries.len()).unwrap_or(i64::MAX);
        expiries.truncate(LATEST_EXPIRIES);
        Report {
            label: label.to_owned(),
            as_of: now,
            last_opened_at,
            last_paid_at,
            orders: ORDER_STATES.iter().copied().zip(counts).collect(),
            expiries: count,
            latest: expiries,
        }
    }
}

/// `rampMetricsView(report).partner`: the desk's view of the partner's report, `null` with no partner.
pub fn metrics_view(report: Option<&Report>) -> Json {
    let Some(r) = report else {
        return Json::Null;
    };
    let iso = |t: Option<Instant>| t.map_or(Json::Null, |t| Json::str(t.iso()));
    Json::obj([
        ("label", Json::str(r.label.clone())),
        ("asOf", Json::str(r.as_of.iso())),
        ("health", Json::str("operational")),
        ("lastOpenedAt", iso(r.last_opened_at)),
        ("lastPaidAt", iso(r.last_paid_at)),
        (
            "orders",
            Json::Array(
                r.orders
                    .iter()
                    .map(|(s, c)| Json::obj([("state", Json::str(*s)), ("count", Json::int(*c))]))
                    .collect(),
            ),
        ),
        (
            "quoteExpiries",
            Json::obj([
                ("count", Json::int(r.expiries)),
                (
                    "latest",
                    Json::Array(
                        r.latest
                            .iter()
                            .map(|(id, at)| {
                                Json::obj([
                                    ("orderId", Json::str(id.clone())),
                                    ("expiredAt", Json::str(at.iso())),
                                ])
                            })
                            .collect(),
                    ),
                ),
            ]),
        ),
    ])
}

// ---------------------------------------------------------------------------------------------------------------
// The partner

/// The TEST partner's delivery of a purchase to the buyer's own wallet: the transfer's hash, or why not.
pub trait Deliver: Send + Sync {
    fn deliver(&self, to: &str, asset_id: &str, amount: &str) -> Result<String, String>;
}

/// `payinSimDelivery`: one POST to the TEST partner on the stack, its hash back, or a failure.
pub struct HttpDeliver {
    pub url: url::Url,
    pub fetch: Box<dyn Fetch>,
}

impl Deliver for HttpDeliver {
    fn deliver(&self, to: &str, asset_id: &str, amount: &str) -> Result<String, String> {
        let body = Json::obj([
            ("to", Json::str(to)),
            ("asset", Json::str(asset_id)),
            ("amount", Json::str(amount)),
        ]);
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: self.url.to_string(),
                headers: vec![("content-type".to_owned(), "application/json".to_owned())],
                body: Some(body.compact()),
                timeout_ms: Some(90_000),
                refuse_redirect: true,
            })
            .map_err(|e| format!("the TEST partner did not deliver: {e:?}"))?;
        let answer = json::parse(&res.body).ok();
        let hash = match answer.as_ref().and_then(|a| a.get("hash")) {
            Some(Json::String(h)) if hex0x(h, 64) => Some(h.clone()),
            _ => None,
        };
        match hash {
            Some(h) if res.status == 200 => Ok(h),
            _ => {
                let error = match answer.as_ref().and_then(|a| a.get("error")) {
                    Some(Json::String(e)) => e.chars().take(200).collect(),
                    _ => String::new(),
                };
                Err(format!(
                    "the TEST partner did not deliver: {} {error}",
                    res.status
                ))
            }
        }
    }
}

/// The stand-in (`payinSim`): the partner that opens hosted pay-ins, says each was paid, and keeps its own book.
pub struct PayinSim {
    pub catalogue: Catalogue,
    page_base: url::Url,
    return_to: url::Url,
    pub deliver: Option<Box<dyn Deliver>>,
    book: Mutex<Book>,
}

impl PayinSim {
    pub fn new(
        catalogue: Catalogue,
        page_base: url::Url,
        return_to: url::Url,
        deliver: Option<Box<dyn Deliver>>,
    ) -> PayinSim {
        PayinSim {
            catalogue,
            page_base,
            return_to,
            deliver,
            book: Mutex::new(Book::default()),
        }
    }

    pub fn label(&self) -> &str {
        &self.catalogue.label
    }

    pub fn rail(&self) -> &'static str {
        PAYIN_SIM_RAIL
    }

    /// Whether it opens payments for this way to pay.
    pub fn covers(&self, method: &str) -> bool {
        self.catalogue.methods.iter().any(|m| m == method)
            || (method == "bank_transfer" && self.catalogue.bank_transfer.is_some())
    }

    /// The partner's own book.
    pub fn book(&self) -> MutexGuard<'_, Book> {
        self.book.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The page the payer goes to.
    pub fn page(&self, onramp_id: &str) -> String {
        let id: String = url::form_urlencoded::byte_serialize(onramp_id.as_bytes())
            .collect::<String>()
            .replace('+', "%20");
        self.page_base
            .join(&format!("/test/payin-sim/pay/{id}"))
            .map_or_else(|_| String::new(), |u| u.to_string())
    }

    /// Where the payer is sent back to, with the request id.
    pub fn return_url(&self, request_id: &str) -> String {
        let mut back = self.return_to.clone();
        back.query_pairs_mut().append_pair("request", request_id);
        back.to_string()
    }

    /// The app's origin, a target of the approve form.
    pub fn return_origin(&self) -> String {
        self.return_to.origin().ascii_serialization()
    }
}

impl PaymentPort for PayinSim {
    fn loopback_pages(&self) -> bool {
        true
    }

    fn open(&self, ask: &OpenAsk, now: Instant) -> Result<Option<Instruction>, Refusal> {
        if !self.covers(&ask.method) {
            return Ok(None);
        }
        self.book()
            .opened(&ask.onramp_id, ask.quote_expires_at, now);
        if ask.method == "bank_transfer"
            && let Some((name, account)) = &self.catalogue.bank_transfer
        {
            return Ok(Some(Instruction {
                partner_rail: Some(PAYIN_SIM_RAIL.to_owned()),
                hosted_url: None,
                bank: Some(BankInstruction {
                    reference: Some(reference(&ask.onramp_id)),
                    account_name: Some(name.clone()),
                    account_ref: Some(account.clone()),
                }),
            }));
        }
        Ok(Some(Instruction {
            partner_rail: Some(PAYIN_SIM_RAIL.to_owned()),
            hosted_url: Some(self.page(&ask.onramp_id)),
            bank: None,
        }))
    }
}

/// What the binary reads for the stand-in.
pub struct Config<'a> {
    pub catalogue: Option<&'a str>,
    pub page_url: Option<&'a str>,
    pub return_url: Option<&'a str>,
    pub deliver_url: Option<&'a str>,
}

/// `onrampPartnerFor`: `none` is no partner; `payin-sim` is the stand-in only in an explicit dev or test process with a
/// readable TEST catalogue and loopback addresses. The refusal is its code and words (`PayinSimRefusedError`).
pub fn partner_for(
    setting: Option<&str>,
    config: &Config<'_>,
    app_env: Option<&str>,
    node_env: Option<&str>,
    fetch: impl FnOnce() -> Box<dyn Fetch>,
) -> Result<Option<PayinSim>, (&'static str, &'static str)> {
    if setting != Some("payin-sim") {
        return Ok(None);
    }
    if !crate::cards::terms::dev_or_test(app_env, node_env) {
        return Err((
            "bank.payin_sim_outside_dev_test",
            "BANK_ONRAMP_PARTNER=payin-sim is a local-test stand-in that takes no money; it runs only with APP_ENV exactly dev or test.",
        ));
    }
    let catalogue = parse(config.catalogue).ok_or((
        "bank.payin_sim_catalogue_unreadable",
        "BANK_ONRAMP_PARTNER=payin-sim needs BANK_PAYIN_SIM_JSON: a catalogue labelled TEST, in shape (see ramps/payin-sim.ts).",
    ))?;
    let (Some(page), Some(back)) = (
        loopback_base(config.page_url),
        loopback_base(config.return_url),
    ) else {
        return Err((
            "bank.payin_sim_address_unset",
            "BANK_ONRAMP_PARTNER=payin-sim needs BANK_PAYIN_SIM_PAGE_URL and BANK_PAYIN_SIM_RETURN_URL, both loopback http(s) addresses.",
        ));
    };
    let deliver_set = config.deliver_url.is_some_and(|u| !js_trim(u).is_empty());
    let deliver = if deliver_set {
        let url = loopback_base(config.deliver_url).ok_or((
            "bank.payin_sim_address_unset",
            "BANK_PAYIN_SIM_DELIVER_URL, when set, must be a loopback http(s) address (the TEST partner on the stack).",
        ))?;
        Some(Box::new(HttpDeliver {
            url,
            fetch: fetch(),
        }) as Box<dyn Deliver>)
    } else {
        None
    };
    Ok(Some(PayinSim::new(catalogue, page, back, deliver)))
}

// ---------------------------------------------------------------------------------------------------------------
// The loopback record doors (`test-ramp-partner-record.ts`)

/// `TEST_RAMP_PARTNER_RECORD_BASE`, `TEST_RAMP_PARTNER_RECORD_ID`.
pub const RECORD_BASE: &str = "/test-ramp-partner";
pub const RECORD_ID: &str = "test-ramp-partner";
/// The routes Fastify mounts, with their methods.
pub const RECORD_ROUTES: [(&str, &str); 3] =
    [("GET", "/venue"), ("POST", "/report"), ("POST", "/age")];

fn error(status: u16, message: &str) -> (u16, Json) {
    (status, Json::obj([("error", Json::str(message))]))
}

/// JavaScript's `Math.round(n * 1000)`, as a whole number of milliseconds when it is one.
#[allow(
    clippy::float_arithmetic,
    clippy::cast_possible_truncation,
    reason = "the TEST clock door's seconds, not money"
)]
fn js_round_ms(seconds: f64) -> Option<i64> {
    let ms = (seconds * 1000.0 + 0.5).floor();
    (ms.is_finite() && ms.abs() < 9.0e15).then_some(ms as i64)
}

/// `answerTestRampPartnerRecord`: one request below the base.
pub fn record_answer(
    p: &PayinSim,
    method: &str,
    path: &str,
    body: &Value,
    now: Instant,
) -> (u16, Json) {
    let report = p.book().report(p.label(), now);
    match path {
        "/venue" => {
            if method != "GET" {
                return error(405, "GET only");
            }
            (
                200,
                Json::obj([
                    ("label", Json::str("TEST")),
                    (
                        "venue",
                        Json::obj([
                            ("id", Json::str(RECORD_ID)),
                            ("displayName", Json::str(report.label.clone())),
                        ]),
                    ),
                ]),
            )
        }
        "/age" => {
            if method != "POST" {
                return error(405, "POST only");
            }
            let (Some(order), Some(seconds)) = (
                body.get("orderId").as_str(),
                match body.get("seconds") {
                    Value::Number(n) => Some(*n),
                    _ => None,
                },
            ) else {
                return error(400, "orderId and seconds are required");
            };
            let aged = js_round_ms(seconds).is_some_and(|ms| p.book().age(order, ms));
            if aged {
                (
                    200,
                    Json::obj([("label", Json::str("TEST")), ("aged", Json::Bool(true))]),
                )
            } else {
                error(404, "no such order")
            }
        }
        "/report" => {
            if method != "POST" {
                return error(405, "POST only");
            }
            let account = match body.get("account") {
                a @ Value::Object(_) => Some(a),
                _ => None,
            };
            if account.and_then(|a| a.get("venueId").as_str()) != Some(RECORD_ID) {
                return error(400, &format!("account.venueId must be {RECORD_ID}"));
            }
            let Some(account) = account else {
                return error(400, &format!("account.venueId must be {RECORD_ID}"));
            };
            if account.get("owner").as_str().is_none_or(str::is_empty) {
                return error(400, "account.owner (a user id) is required");
            }
            if !matches!(account.get("subAccount"), Value::Undefined | Value::Null) {
                return error(400, "the ramp partner keeps no sub-accounts");
            }
            (
                200,
                Json::obj([
                    ("label", Json::str("TEST")),
                    ("value", metrics_view(Some(&report))),
                ]),
            )
        }
        _ => error(404, "no such path"),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn the_reference_is_the_id_compacted_and_upper_case() {
        assert_eq!(
            reference("abcdef01-2345-4678-9abc-def012345678"),
            "TEST-ABCDEF012345"
        );
    }

    #[test]
    fn a_label_is_test_then_a_boundary() {
        assert!(super::test_label("TEST pay-in"));
        assert!(super::test_label("TEST"));
        assert!(!super::test_label("TESTS"));
        assert!(!super::test_label("test x"));
    }
}
