//! The on-ramp and add money (`PORT.md`, slice `ramps`): the programme, quotes, on-ramps and add money, the operator's
//! credit and the desk's ramp reads, the pay-in partner's job doors, its TEST page and its loopback record doors.
//!
//! - `rails`, `ports`: the programme and what a quote, a payment and a fee are asked of (`rails.ts`,
//!   `pay-fiat-adapter.ts`, `customer-ports.ts`).
//! - `quotes`: the customer's quotes and on-ramp instructions (the quote half of `customer-ramps.ts`).
//! - `service`: the programme probes, the lists and the operator's credit (`ramp-service.ts`).
//! - `add_money`: the ways to pay in and the customer's requests (`add-money.ts`).
//! - `ops`: the desk's ramp calls (`ops/ramp-health.ts`, `ramp-metrics.ts`, `onramp-quotes.ts`).
//! - `sim`, `payin`, `wallet`: the TEST rate stand-in, the TEST pay-in partner and its book, and the wallet signature
//!   check (`onramp-sim.ts`, `payin-sim*.ts`, `ramp-partner-book.ts`, `test-ramp-partner-record.ts`,
//!   `wallet-ownership.ts`'s signer).

pub mod add_money;
pub mod ops;
pub mod payin;
pub mod ports;
pub mod quotes;
pub mod rails;
pub mod service;
pub mod shape;
pub mod sim;

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::server::{Answer, Request, Response};
use service_kit::trpc::TrpcError;

use crate::door::{BankDoor, Ctx};
use crate::errors::Refusal;

pub use super::Deps;

/// What the door holds for the on-ramp, built once at start-up. Every port unset is the production default: a quote, a
/// fee and a hosted payment come from a port or they are refused.
pub struct Wiring {
    /// `BANK_RAMP_MODE`'s programme.
    pub programme: rails::Programme,
    /// svc-pay's fiat rails (`PayFiatRampPort`); empty at boot.
    pub pay_fiat: Box<dyn rails::PayFiat>,
    /// The rate source for quotes (`onrampQuotes`).
    pub quotes: Option<Box<dyn ports::QuoteSource>>,
    /// The TEST rate stand-in (`BANK_ONRAMP_RATES=ramp-sim`), for the asks it lists.
    pub stand_in: Option<sim::OnrampSim>,
    /// A payment port other than the pay-in partner (`onrampPayments`); the partner's own when unset.
    pub payments: Option<Box<dyn ports::PaymentPort>>,
    /// The off-ramp fee source (`offrampFees`).
    pub fees: Option<Box<dyn ports::FeeSource>>,
    /// The TEST pay-in partner (`BANK_ONRAMP_PARTNER=payin-sim`).
    pub partner: Option<payin::PayinSim>,
}

impl Wiring {
    pub fn none() -> Wiring {
        Wiring {
            programme: rails::NONE,
            pay_fiat: Box::new(rails::EmptyPayFiat),
            quotes: None,
            stand_in: None,
            payments: None,
            fees: None,
            partner: None,
        }
    }
}

/// The on-ramp's own wiring, as each part reads it.
pub struct Onramp<'a> {
    pub w: &'a Wiring,
}

impl Onramp<'_> {
    pub fn programme(&self) -> rails::Programme {
        self.w.programme
    }

    /// `onrampPayments ?? onrampPartner.payments`.
    pub fn payments(&self) -> Option<&dyn ports::PaymentPort> {
        self.w.payments.as_deref().or_else(|| {
            self.w
                .partner
                .as_ref()
                .map(|p| p as &dyn ports::PaymentPort)
        })
    }
}

fn text<'v>(v: &'v Value, key: &str) -> &'v str {
    v.get(key).as_str().unwrap_or_default()
}

fn opt<'v>(v: &'v Value, key: &str) -> Option<&'v str> {
    v.get(key).as_str()
}

/// The customer's on-ramp calls.
fn customer(
    d: &Deps<'_>,
    o: &Onramp<'_>,
    user: &str,
    path: &str,
    input: &Value,
) -> Option<Result<Json, Refusal>> {
    Some(match path {
        "ramps.programme" => Ok(o.programme().json()),
        "ramps.live" => Err(rails::live_ramp_unset()),
        "ramps.fiatSettle" => service::fiat_settle(o),
        "ramps.onramps" => service::onramps_of(d, user, input.get("limit").as_number())
            .map(|rows| Json::Array(rows.iter().map(service::Credit::list_json).collect())),
        "ramps.offramps" => {
            service::offramps_of(d, user, input.get("limit").as_number()).map(Json::Array)
        }
        "ramps.onrampQuote" => quotes::quote_onramp(
            d,
            o,
            &quotes::OnrampAsk {
                user_id: user,
                asset_id: text(input, "assetId"),
                amount: text(input, "amount"),
                method: text(input, "method"),
                country: text(input, "country"),
            },
        )
        .map(|q| q.json()),
        "ramps.onrampCreate" => quotes::create_onramp(
            d,
            o,
            &quotes::CreateAsk {
                user_id: user,
                onramp_id: text(input, "onrampId"),
                quote_id: text(input, "quoteId"),
                method: text(input, "method"),
                wallet_address: None,
            },
        )
        .map(|r| r.create_json()),
        "ramps.offrampQuote" => quotes::quote_offramp(
            d,
            o,
            text(input, "assetId"),
            text(input, "amount"),
            text(input, "kind"),
            text(input, "destinationRef"),
        ),
        "addMoney.methods" => add_money::methods(
            d,
            o,
            user,
            text(input, "assetId"),
            text(input, "amount"),
            text(input, "country"),
        ),
        "addMoney.start" => add_money::start(
            d,
            o,
            user,
            &add_money::StartAsk {
                request_id: text(input, "requestId"),
                asset_id: text(input, "assetId"),
                amount: text(input, "amount"),
                method: text(input, "method"),
                country: text(input, "country"),
                quote_id: opt(input, "quoteId"),
                wallet_address: opt(input, "walletAddress"),
                wallet_signature: opt(input, "walletSignature"),
            },
        )
        .map(|v| v.json()),
        "addMoney.requests" => {
            #[allow(
                clippy::cast_possible_truncation,
                reason = "the schema held it to a whole number from 1 to 50"
            )]
            let limit = input.get("limit").as_number().unwrap_or(1.0) as i64;
            add_money::list(d, user, limit)
        }
        "addMoney.request" => {
            add_money::request(d, user, text(input, "requestId")).map(|v| v.json())
        }
        _ => return None,
    })
}

/// The on-ramp's calls; `None` for any other path.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    let o = Onramp { w: &d.w.onramp };
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let path = ctx.call.path;
    let res = customer(d, &o, user, path, &ctx.input)
        .or_else(|| ops::answer(d, &o, user, path, &ctx.input))?;
    Some(res.map(Some).map_err(|e| {
        crate::errors::to_trpc(e, || {
            service_kit::approvals::random_uuid().unwrap_or_default()
        })
    }))
}

fn reply(status: u16, error: &str, code: &str) -> Response {
    Response {
        status,
        body: Json::obj([("error", Json::str(error)), ("code", Json::str(code))]).compact(),
    }
}

/// A thrown error that is no `BankError`, as Fastify answers it.
fn thrown(message: &str) -> Response {
    Response {
        status: 500,
        body: Json::obj([
            ("statusCode", Json::int(500)),
            ("error", Json::str("Internal Server Error")),
            ("message", Json::str(message)),
        ])
        .compact(),
    }
}

/// `sendBankJobRefuse`: a `BankError` is 400 with its own message and code; anything else Fastify's 500.
fn job_failed(r: Refusal) -> Response {
    match r {
        Refusal::Bank(e) => reply(400, &e.message, e.row.code),
        Refusal::Trpc(e) => thrown(&e.message),
        Refusal::Other(m) => thrown(&m),
    }
}

fn not_in_shape() -> Response {
    reply(400, "body not in shape", "bank.validation_failed")
}

/// A strict object's fields: `None` when `v` is no object or names a key outside `allowed`.
fn strict<'v>(v: &'v Value, allowed: &[&str]) -> Option<&'v [(String, Value)]> {
    match v {
        Value::Object(fields) if fields.iter().all(|(k, _)| allowed.contains(&k.as_str())) => {
            Some(fields)
        }
        _ => None,
    }
}

/// A string field, `None` when absent, `Err` when present and not a string.
fn string_field<'v>(fields: &'v [(String, Value)], key: &str) -> Result<Option<&'v str>, ()> {
    match fields.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v) {
        None | Some(Value::Undefined) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(()),
    }
}

/// `payinPaidBody`.
fn paid_body(body: &Value) -> Option<(String, String, String, Option<String>)> {
    let f = strict(
        body,
        &["requestId", "paidAmount", "payCurrency", "deliveryTx"],
    )?;
    let id = string_field(f, "requestId").ok()??;
    let paid = string_field(f, "paidAmount").ok()??;
    let currency = string_field(f, "payCurrency").ok()??;
    let tx = string_field(f, "deliveryTx").ok()?;
    let ok = shape::uuid(id)
        && shape::decimal(paid)
        && shape::upper(currency, 3, 16, false)
        && tx.is_none_or(|t| shape::hex0x(t, 64));
    ok.then(|| {
        (
            id.to_owned(),
            paid.to_owned(),
            currency.to_owned(),
            tx.map(str::to_owned),
        )
    })
}

/// `payinReturnedBody`.
fn returned_body(body: &Value) -> Option<String> {
    let f = strict(body, &["requestId"])?;
    let id = string_field(f, "requestId").ok()??;
    shape::uuid(id).then(|| id.to_owned())
}

/// `POST /internal/jobs/payin-sim/{paid,returned}`, past the job door's signature: the pay-in partner's word. Its book
/// notes each, and the answer is the whole view.
pub fn job(door: &BankDoor, path: &str, body: &Value) -> Response {
    let body = match body {
        Value::Undefined | Value::Null => &Value::Object(Vec::new()),
        b => b,
    };
    let now = door.now();
    let paid = path.ends_with("/paid");
    let res = if paid {
        let Some((request_id, paid_amount, pay_currency, delivery_tx)) = paid_body(body) else {
            return not_in_shape();
        };
        door.ramps_deps(now, |d| {
            let o = Onramp { w: &d.w.onramp };
            add_money::paid(
                d,
                &o,
                &add_money::PaidAsk {
                    request_id: &request_id,
                    paid_amount: &paid_amount,
                    pay_currency: &pay_currency,
                    delivery_tx: delivery_tx.as_deref(),
                },
            )
        })
    } else {
        let Some(request_id) = returned_body(body) else {
            return not_in_shape();
        };
        door.ramps_deps(now, |d| {
            let o = Onramp { w: &d.w.onramp };
            add_money::returned(d, &o, &request_id)
        })
    };
    match res {
        Ok(v) => {
            if let (Some(p), Some(onramp)) =
                (door.ramps().onramp.partner.as_ref(), v.onramp.as_ref())
            {
                if paid {
                    p.book().paid(&onramp.id, now);
                } else {
                    p.book().returned(&onramp.id, now);
                }
            }
            Response {
                status: 200,
                body: v.full_json().compact(),
            }
        }
        Err(e) => job_failed(e),
    }
}

/// `escape`: the page's five characters.
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// The stand-in's page (`payin-sim-page.ts`'s `page`).
fn page(label: &str, v: &add_money::Viewed, return_url: &str) -> String {
    let r = &v.request;
    let pay = v.onramp.as_ref().map_or_else(String::new, |o| {
        format!(
            "{} {}",
            service_kit::money::format_amount(o.pay_amount),
            o.pay_currency
        )
    });
    let amount = service_kit::money::format_amount(r.amount);
    let action = if r.status == "opened" {
        format!(
            "<form method=\"post\" action=\"/test/payin-sim/pay/{}/approve\"><button type=\"submit\">Approve payment</button></form>",
            escape(&r.id)
        )
    } else {
        "<p data-testid=\"payin-sim-state\">This payment is already approved.</p>".to_owned()
    };
    let verb = if r.wallet_address.is_some() {
        "buy"
    } else {
        "add"
    };
    let deliver = r.wallet_address.as_deref().map_or_else(String::new, |w| {
        format!(
            "<p data-testid=\"payin-sim-deliver-to\">Delivered to the wallet {}</p>\n",
            escape(w)
        )
    });
    format!(
        "<!doctype html>\n<html lang=\"en\">\n<head><meta charset=\"utf-8\"><title>TEST payment page</title></head>\n<body>\n\
         <main data-testid=\"payin-sim-page\">\n<h1>TEST payment page</h1>\n\
         <p data-testid=\"payin-sim-label\">{}</p>\n\
         <p data-testid=\"payin-sim-amount\">Pay {} to {verb} {} {}</p>\n\
         {deliver}{action}\n\
         <p><a href=\"{}\">Back without paying</a></p>\n</main>\n</body>\n</html>",
        escape(label),
        escape(&pay),
        escape(&amount),
        escape(&r.asset_id),
        escape(return_url),
    )
}

/// The page's refusal: a `BankError` is 404 for a missing request, else 409; anything else Fastify's 500.
fn page_refuse(r: Refusal) -> Response {
    match r {
        Refusal::Bank(e) => {
            let status = if e.row.code == "bank.add_money_request_missing" {
                404
            } else {
                409
            };
            reply(status, &e.message, e.row.code)
        }
        Refusal::Trpc(e) => thrown(&e.message),
        Refusal::Other(m) => thrown(&m),
    }
}

/// A path parameter as Fastify decodes it.
fn decoded(raw: &str) -> String {
    url::form_urlencoded::parse(format!("x={}", raw.replace('+', "%2B")).as_bytes())
        .next()
        .map_or_else(String::new, |(_, v)| v.into_owned())
}

const PAGE_BASE: &str = "/test/payin-sim/pay/";

/// Fastify's JSON content type, which the page's refusals keep.
const JSON_TYPE: &str = "application/json; charset=utf-8";

/// A JSON refusal as a page answer.
fn json_answer(res: Response) -> Answer {
    Answer {
        status: res.status,
        content_type: JSON_TYPE,
        headers: Vec::new(),
        body: res.body,
    }
}

/// The TEST page and its approve button (`payin-sim-page.ts`): the page in `text/html` with `cache-control: no-store`
/// and its content security policy, the approve a 303 to the app's return address. Mounted only with the pay-in partner.
fn page_door(
    door: &BankDoor,
    partner: &payin::PayinSim,
    req: &Request<'_>,
    path: &str,
) -> Option<Answer> {
    let rest = path.strip_prefix(PAGE_BASE)?;
    let (raw, approve) = match rest.strip_suffix("/approve") {
        Some(id) => (id, true),
        None => (rest, false),
    };
    if raw.is_empty() || raw.contains('/') {
        return None;
    }
    match (req.method, approve) {
        ("GET", false) | ("POST", true) => {}
        _ => return None,
    }
    if approve {
        let form = service_kit::trpc::header(req, "content-type").is_some_and(|c| {
            c.to_ascii_lowercase()
                .starts_with("application/x-www-form-urlencoded")
        });
        if !form && let Err(res) = crate::door::rest::read_body(req) {
            return Some(json_answer(res));
        }
    }
    let id = decoded(raw);
    if !shape::uuid(&id) {
        return Some(json_answer(reply(
            400,
            "not a payment id",
            "bank.validation_failed",
        )));
    }
    let now = door.now();
    let res = door.ramps_deps(now, |d| {
        let o = Onramp { w: &d.w.onramp };
        if approve {
            add_money::approved(d, &o, &id)
        } else {
            add_money::opened(d, &o, &id)
        }
    });
    let answer = match res {
        Ok(a) => a,
        Err(e) => return Some(json_answer(page_refuse(e))),
    };
    if !approve {
        // The approve form posts here and is redirected to the app, so the app's origin is a form target too.
        let policy = format!(
            "default-src 'none'; form-action 'self' {}; frame-ancestors 'none'",
            partner.return_origin()
        );
        return Some(Answer {
            status: 200,
            content_type: "text/html; charset=utf-8",
            headers: vec![
                ("cache-control", "no-store".to_owned()),
                ("content-security-policy", policy),
            ],
            body: page(partner.label(), &answer.viewed, &answer.return_url),
        });
    }
    partner.book().approved(&id, now);
    if answer.approved_now && answer.viewed.request.wallet_address.is_some() {
        // The TS delivers after the reply; here it delivers before it. A failure leaves the request pending.
        deliver(door, partner, &answer.viewed);
    }
    Some(Answer {
        status: 303,
        content_type: JSON_TYPE,
        headers: vec![("location", answer.return_url.clone())],
        body: String::new(),
    })
}

/// The TEST partner delivers an approved wallet purchase, then says it was paid with that transfer.
fn deliver(door: &BankDoor, partner: &payin::PayinSim, v: &add_money::Viewed) {
    let (Some(sender), Some(to), Some(onramp)) = (
        partner.deliver.as_ref(),
        v.request.wallet_address.as_deref(),
        v.onramp.as_ref(),
    ) else {
        return;
    };
    let amount = service_kit::money::format_amount(v.request.amount);
    let Ok(tx) = sender.deliver(to, &v.request.asset_id, &amount) else {
        return;
    };
    let now = door.now();
    partner.book().paid(&onramp.id, now);
    let pay = service_kit::money::format_amount(onramp.pay_amount);
    let _ = door.ramps_deps(now, |d| {
        let o = Onramp { w: &d.w.onramp };
        add_money::paid(
            d,
            &o,
            &add_money::PaidAsk {
                request_id: &v.request.id,
                paid_amount: &pay,
                pay_currency: &onramp.pay_currency,
                delivery_tx: Some(&tx),
            },
        )
    });
}

/// The loopback record doors (`/test-ramp-partner/{venue,report,age}`), as `partner/record.rs` serves its own.
fn record_door(
    partner: &payin::PayinSim,
    req: &Request<'_>,
    path: &str,
    peer: &str,
    now: service_kit::time::Instant,
) -> Option<Response> {
    let below = path.strip_prefix(payin::RECORD_BASE)?;
    if !payin::RECORD_ROUTES
        .iter()
        .any(|(m, p)| *m == req.method && *p == below)
    {
        return None;
    }
    let body = match crate::door::rest::read_body(req) {
        Ok(Value::Undefined) => Value::Null,
        Ok(b) => b,
        Err(res) => return Some(res),
    };
    if !crate::partner::record::on_loopback(peer) {
        return Some(Response {
            status: 403,
            body: Json::obj([("error", Json::str("loopback only"))]).compact(),
        });
    }
    let (status, out) = payin::record_answer(partner, req.method, below, &body, now);
    Some(Response {
        status,
        body: out.compact(),
    })
}

/// The loopback TEST ramp partner's record doors (`/test-ramp-partner/{venue,report,age}`); `None` for any other
/// request, and for all of them with no pay-in partner.
pub fn doors(door: &BankDoor, req: &Request<'_>, peer: &str) -> Option<Response> {
    let partner = door.ramps().onramp.partner.as_ref()?;
    let path = req.url.split_once('?').map_or(req.url, |(p, _)| p);
    record_door(partner, req, path, peer, door.now())
}

/// The pay-in stand-in's TEST page (`/test/payin-sim/pay/:onrampId`) and its approve (`.../approve`), each with the
/// headers a browser needs (the kit's `Door::page`); `None` for any other request, and for both with no pay-in partner.
pub fn page_doors(door: &BankDoor, req: &Request<'_>) -> Option<Answer> {
    let partner = door.ramps().onramp.partner.as_ref()?;
    let path = req.url.split_once('?').map_or(req.url, |(p, _)| p);
    page_door(door, partner, req, path)
}
