//! ADD MONEY (`ramps/add-money.ts`, BK-xfer-04, BK-xfer-05, J-bank-02): the ways to pay in, and the customer's add-money
//! requests.
//!
//! A request is kept whatever the rail answers: refused with the rail refusal's code, or written `opening` with its quote
//! before the partner is called and then `opened` with the partner's instruction. Opening posts nothing.
//!
//! PAID: the partner says the money arrived. The quote's receive amount is credited once through the deposit recipe from
//! the partner's rail boundary under `deposit:<rail>:add-money:<request id>`. If this crashes after the post and before
//! the row says credited, the partner's next "paid" posts the same key, which svc-ledger answers with the transaction it
//! already booked, and the row catches up. For a person whose money the TEST partner holds, the partner credits it
//! itself under the same key and the ledger posts nothing.
//!
//! RETURNED: only the partner that credited a purchase takes it back, once, under the same key.
//!
//! TO A WALLET: the person signs the request's own message with the wallet, the sanctions list clears it, and the
//! partner's "paid" must carry the on-chain transfer; nothing is credited here.

use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, js_trim, parse_amount};
use service_kit::time::Instant;

use super::payin::PayinSim;
use super::ports::ONRAMP_METHODS;
use super::quotes::{self, CreateAsk, CustomerOnramp, OnrampAsk};
use super::shape::hex0x;
use super::{Deps, Onramp};
use crate::automations::own_moves::wallet;
use crate::earn::ms;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{pg, with};

/// `ADD_MONEY_METHODS`: the order the chooser shows the ways to pay.
pub const METHODS: [&str; 4] = ["bank_transfer", "pay_by_bank", "card", "wallet_pay"];

const _: () = assert!(ONRAMP_METHODS.len() == METHODS.len());

/// `railFor`.
pub fn rail_for(method: &str) -> &'static str {
    if method == "bank_transfer" || method == "pay_by_bank" {
        "rail.bank"
    } else {
        "rail.card"
    }
}

/// A refusal's code, when it is a domain refusal.
pub fn code_of(r: &Refusal) -> Option<&'static str> {
    match r {
        Refusal::Bank(e) => Some(e.row.code),
        _ => None,
    }
}

/// `railRefusal`: the refusals that mean "no partner, rail or rate source is connected for this way to pay".
fn rail_refusal(r: &Refusal) -> Option<&'static str> {
    code_of(r).filter(|c| {
        matches!(
            *c,
            "bank.fiat_ramp_socket"
                | "bank.fiat_ramp_no_pay_adapter"
                | "bank.no_fiat_rail"
                | "bank.onramp_rate_unset"
                | "bank.onramp_fee_not_known"
        )
    })
}

/// `finalRefusal`: a rail refusal, or the quote running out before the partner opened anything.
fn final_refusal(r: &Refusal) -> Option<&'static str> {
    rail_refusal(r).or_else(|| code_of(r).filter(|c| *c == "bank.onramp_quote_expired"))
}

/// `addMoney.methods`: each way to pay with its quote, or the reason there is none.
pub fn methods(
    d: &Deps<'_>,
    o: &Onramp<'_>,
    user_id: &str,
    asset_id: &str,
    amount: &str,
    country: &str,
) -> Result<Json, Refusal> {
    let mut out = Vec::with_capacity(METHODS.len());
    for method in METHODS {
        let asked = quotes::quote_onramp(
            d,
            o,
            &OnrampAsk {
                user_id,
                asset_id,
                amount,
                method,
                country,
            },
        );
        let row = match asked {
            Ok(quote) => {
                let upper = js_trim(country).to_uppercase();
                let stand_in =
                    o.w.stand_in
                        .as_ref()
                        .filter(|s| s.covers(asset_id, method, &upper))
                        .map_or(Json::Null, |s| Json::str(s.label()));
                let pay_stand_in =
                    o.w.partner
                        .as_ref()
                        .filter(|p| p.covers(method))
                        .map_or(Json::Null, |p| Json::str(p.label()));
                Json::obj([
                    ("method", Json::str(method)),
                    ("rail", Json::str(rail_for(method))),
                    ("quote", quote.json()),
                    ("blocker", Json::Null),
                    ("standIn", stand_in),
                    ("payStandIn", pay_stand_in),
                ])
            }
            Err(e) => {
                let Some(code) = rail_refusal(&e) else {
                    return Err(e);
                };
                Json::obj([
                    ("method", Json::str(method)),
                    ("rail", Json::str(rail_for(method))),
                    ("quote", Json::Null),
                    ("blocker", Json::str(code)),
                    ("standIn", Json::Null),
                    ("payStandIn", Json::Null),
                ])
            }
        };
        out.push(row);
    }
    Ok(Json::obj([("methods", Json::Array(out))]))
}

/// One stored request (`RequestRow`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub id: String,
    pub user_id: String,
    pub asset_id: String,
    pub amount: Amount,
    pub method: String,
    pub country: String,
    pub rail: String,
    pub status: String,
    pub refusal_code: Option<String>,
    pub quote_id: Option<String>,
    pub onramp_id: Option<String>,
    pub created_at: Instant,
    pub opened_at: Option<Instant>,
    pub pending_at: Option<Instant>,
    pub credited_at: Option<Instant>,
    pub credited_amount: Option<Amount>,
    pub partner_pay_in_ref: Option<String>,
    pub returned_at: Option<Instant>,
    pub wallet_address: Option<String>,
    pub delivered_at: Option<Instant>,
    pub delivery_tx: Option<String>,
}

fn cols() -> String {
    format!(
        "id::text, user_id, asset_id, amount::text, method, country, rail, status, refusal_code, quote_id::text, \
         onramp_id::text, {}, {}, {}, {}, credited_amount::text, partner_pay_in_ref, {}, wallet_address, {}, delivery_tx",
        ms("created_at"),
        ms("opened_at"),
        ms("pending_at"),
        ms("credited_at"),
        ms("returned_at"),
        ms("delivered_at"),
    )
}

impl Request {
    fn from_row(r: &Row) -> Result<Request, Refusal> {
        let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
        let o = |i: usize| r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e));
        let t = |i: usize| {
            r.try_get::<_, Option<i64>>(i)
                .map_err(|e| pg(&e))
                .map(|v| v.map(Instant))
        };
        let amount = |v: String| parse_amount(&v).map_err(Refusal::Other);
        Ok(Request {
            id: s(0)?,
            user_id: s(1)?,
            asset_id: s(2)?,
            amount: amount(s(3)?)?,
            method: s(4)?,
            country: s(5)?,
            rail: s(6)?,
            status: s(7)?,
            refusal_code: o(8)?,
            quote_id: o(9)?,
            onramp_id: o(10)?,
            created_at: Instant(r.try_get(11).map_err(|e| pg(&e))?),
            opened_at: t(12)?,
            pending_at: t(13)?,
            credited_at: t(14)?,
            credited_amount: o(15)?.map(amount).transpose()?,
            partner_pay_in_ref: o(16)?,
            returned_at: t(17)?,
            wallet_address: o(18)?,
            delivered_at: t(19)?,
            delivery_tx: o(20)?,
        })
    }

    /// `view`, as the customer's router strips it: the request with its instruction when the partner opened one.
    pub fn json(&self, onramp: Option<&CustomerOnramp>) -> Json {
        self.view(onramp, CustomerOnramp::add_money_json)
    }

    /// `view` with the instruction drawn by `draw`.
    fn view(&self, onramp: Option<&CustomerOnramp>, draw: fn(&CustomerOnramp) -> Json) -> Json {
        let iso = |t: Option<Instant>| t.map_or(Json::Null, |t| Json::str(t.iso()));
        let text = |s: &Option<String>| s.clone().map_or(Json::Null, Json::str);
        let onramp = onramp
            .filter(|o| self.onramp_id.as_deref() == Some(o.id.as_str()))
            .map_or(Json::Null, draw);
        let credited_by = if self.status != "credited" && self.status != "returned" {
            Json::Null
        } else if self
            .partner_pay_in_ref
            .as_deref()
            .is_some_and(|r| !r.is_empty())
        {
            Json::str("partner")
        } else {
            Json::str("ledger")
        };
        Json::obj([
            ("requestId", Json::str(self.id.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("amount", Json::str(format_amount(self.amount))),
            ("method", Json::str(self.method.clone())),
            ("country", Json::str(self.country.clone())),
            ("rail", Json::str(self.rail.clone())),
            ("status", Json::str(self.status.clone())),
            ("refusalCode", text(&self.refusal_code)),
            ("onramp", onramp),
            ("createdAt", Json::str(self.created_at.iso())),
            ("openedAt", iso(self.opened_at)),
            ("pendingAt", iso(self.pending_at)),
            ("creditedAt", iso(self.credited_at)),
            (
                "creditedAmount",
                self.credited_amount
                    .map_or(Json::Null, |a| Json::str(format_amount(a))),
            ),
            ("creditedBy", credited_by),
            ("returnedAt", iso(self.returned_at)),
            ("walletAddress", text(&self.wallet_address)),
            ("deliveredAt", iso(self.delivered_at)),
            ("deliveryTx", text(&self.delivery_tx)),
        ])
    }
}

/// The partner's view of a request: the request and the payment it opened (`withOnramp`), the whole view on the job
/// doors.
pub struct Viewed {
    pub request: Request,
    pub onramp: Option<CustomerOnramp>,
}

impl Viewed {
    /// The customer's view.
    pub fn json(&self) -> Json {
        self.request.json(self.onramp.as_ref())
    }

    /// The whole view, unstripped, as the job doors answer it.
    pub fn full_json(&self) -> Json {
        self.request
            .view(self.onramp.as_ref(), CustomerOnramp::json)
    }
}

fn row(c: &mut impl GenericClient, id: &str) -> Result<Option<Request>, Refusal> {
    c.query(
        &format!(
            "SELECT {} FROM bank.add_money_requests WHERE id = $1::text::uuid",
            cols()
        ),
        &[&id],
    )
    .map_err(|e| pg(&e))?
    .first()
    .map(Request::from_row)
    .transpose()
}

/// `one`: the request with its own instruction read.
fn one(d: &Deps<'_>, r: Request) -> Result<Viewed, Refusal> {
    let onramp = match r.onramp_id.clone() {
        Some(id) => with(d.store, |c| quotes::onramps_by_ids(c, &r.user_id, &[id]))?
            .into_iter()
            .next(),
        None => None,
    };
    Ok(Viewed { request: r, onramp })
}

/// What the customer asks (`AddMoneyInput`), as the schema returned it.
pub struct StartAsk<'a> {
    pub request_id: &'a str,
    pub asset_id: &'a str,
    pub amount: &'a str,
    pub method: &'a str,
    pub country: &'a str,
    pub quote_id: Option<&'a str>,
    pub wallet_address: Option<&'a str>,
    pub wallet_signature: Option<&'a str>,
}

/// The ask, canonical (`asked`).
struct Asked {
    request_id: String,
    asset_id: String,
    amount: Amount,
    method: String,
    country: String,
    quote_id: Option<String>,
    wallet_address: Option<String>,
    wallet_signature: Option<String>,
}

/// `walletDeliveryMessage`: the exact text a person signs to have a purchase delivered to their wallet.
pub fn wallet_delivery_message(request_id: &str, wallet_address: &str) -> String {
    [
        "INTAFACED buy to wallet".to_owned(),
        format!("Request: {}", request_id.to_lowercase()),
        format!("Wallet: {}", wallet_address.to_lowercase()),
        "Signing this proves you control this wallet, so a purchase can be delivered to it. It moves no funds and approves nothing else."
            .to_owned(),
    ]
    .join("\n")
}

/// `walletOf`.
fn wallet_of(raw: Option<&str>) -> Result<Option<String>, Refusal> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let address = js_trim(raw).to_lowercase();
    let zero = address
        .strip_prefix("0x")
        .is_some_and(|h| h.bytes().all(|b| b == b'0'));
    if !hex0x(&address, 40) || zero {
        return Err(refuse(
            "bank.ramp_invalid_destination",
            "The wallet to deliver to must be an EVM address",
        ));
    }
    Ok(Some(address))
}

/// `same`.
fn same(r: Request, user_id: &str, a: &Asked) -> Result<Request, Refusal> {
    let matches = r.user_id == user_id
        && r.asset_id == a.asset_id
        && r.amount == a.amount
        && r.method == a.method
        && r.country == a.country
        && (a.quote_id.is_none() || r.quote_id.is_none() || r.quote_id == a.quote_id)
        && r.wallet_address == a.wallet_address;
    if !matches {
        return Err(refuse(
            "bank.ramp_conflict",
            "This request id is already used on other terms",
        ));
    }
    Ok(r)
}

/// `start`: kept whether the rail opens it or refuses it; posts nothing either way.
pub fn start(
    d: &Deps<'_>,
    o: &Onramp<'_>,
    user_id: &str,
    ask: &StartAsk<'_>,
) -> Result<Viewed, Refusal> {
    let parsed = parse_amount(ask.amount).map_err(Refusal::Other)?;
    if parsed <= 0 {
        return Err(refuse(
            "bank.validation_failed",
            "The amount to add must be above zero",
        ));
    }
    let asked = Asked {
        request_id: ask.request_id.to_owned(),
        asset_id: ask.asset_id.to_owned(),
        amount: parsed,
        method: ask.method.to_owned(),
        country: js_trim(ask.country).to_uppercase(),
        quote_id: ask.quote_id.map(str::to_lowercase),
        wallet_address: wallet_of(ask.wallet_address)?,
        wallet_signature: ask.wallet_signature.map(|s| js_trim(s).to_lowercase()),
    };
    if let Some(address) = asked.wallet_address.as_deref() {
        let signer = asked
            .wallet_signature
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|s| {
                wallet::recover_personal_sign_address(
                    &wallet_delivery_message(&asked.request_id, address),
                    s,
                )
            });
        if signer.as_deref() != Some(address) {
            return Err(refuse(
                "bank.wallet_delivery_unproven",
                "The wallet to deliver to must sign this request to prove it is yours. Nothing was asked for or kept",
            ));
        }
        crate::ramps::sanctions::assert_clear(
            d.w.settings.destination_sanctions.as_deref(),
            None,
            address,
        )?;
    } else if asked.wallet_signature.is_some() {
        return Err(refuse(
            "bank.validation_failed",
            "A wallet signature came with no wallet to deliver to",
        ));
    }
    if let Some(prior) = with(d.store, |c| row(c, &asked.request_id))? {
        return settle(d, o, same(prior, user_id, &asked)?);
    }
    let amount = format_amount(asked.amount);
    let quoted = match asked.quote_id.as_deref() {
        Some(q) => accepted(d, user_id, q, &asked),
        None => quotes::quote_onramp(
            d,
            o,
            &OnrampAsk {
                user_id,
                asset_id: &asked.asset_id,
                amount: &amount,
                method: &asked.method,
                country: &asked.country,
            },
        )
        .map(|q| q.id),
    };
    let kept = match quoted {
        Ok(quote_id) => Ok(quote_id),
        Err(e) => match rail_refusal(&e) {
            Some(code) => Err(code),
            None => return Err(e),
        },
    };
    let stored = keep(d, user_id, &asked, &kept)?;
    settle(d, o, stored)
}

/// `accepted`: the quote, if it is the caller's, on the request's own terms and still live.
fn accepted(d: &Deps<'_>, user_id: &str, quote_id: &str, a: &Asked) -> Result<String, Refusal> {
    let q = quotes::onramp_quote_of(d, user_id, quote_id)?;
    let matches = q.asset_id == a.asset_id
        && q.amount == a.amount
        && q.method == a.method
        && q.country == a.country;
    if !matches {
        return Err(refuse(
            "bank.ramp_conflict",
            "The quote was given on other terms than this request",
        ));
    }
    if q.expires_at.0 <= d.now.0 {
        return Err(refuse(
            "bank.onramp_quote_expired",
            "On-ramp quote has expired",
        ));
    }
    Ok(q.id)
}

/// `keep`: the request written once.
fn keep(
    d: &Deps<'_>,
    user_id: &str,
    a: &Asked,
    kept: &Result<String, &str>,
) -> Result<Request, Refusal> {
    let (status, code, quote) = match kept {
        Ok(q) => ("opening", None, Some(q.as_str())),
        Err(c) => ("refused", Some(*c), None),
    };
    let signature = a.wallet_address.as_ref().and(a.wallet_signature.as_deref());
    let stored = with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "INSERT INTO bank.add_money_requests (id, user_id, asset_id, amount, method, country, rail, status, \
                       refusal_code, quote_id, wallet_address, wallet_signature) \
                     VALUES ($1::text::uuid, $2, $3, $4::text::numeric, $5, $6, $7, $8, $9, $10::text::uuid, $11, $12) \
                     ON CONFLICT (id) DO NOTHING RETURNING {}",
                    cols()
                ),
                &[
                    &a.request_id,
                    &user_id,
                    &a.asset_id,
                    &format_amount(a.amount),
                    &a.method,
                    &a.country,
                    &rail_for(&a.method),
                    &status,
                    &code,
                    &quote,
                    &a.wallet_address,
                    &signature,
                ],
            )
            .map_err(|e| pg(&e))?;
        match rows.first() {
            Some(r) => Request::from_row(r).map(Some),
            None => row(c, &a.request_id),
        }
    })?;
    let stored = stored
        .ok_or_else(|| refuse("bank.ramp_conflict", "The add-money request was not stored"))?;
    same(stored, user_id, a)
}

/// `settle`: ask the partner for a request still opening, and record its answer.
fn settle(d: &Deps<'_>, o: &Onramp<'_>, r: Request) -> Result<Viewed, Refusal> {
    let Some(quote_id) = r.quote_id.clone().filter(|_| r.status == "opening") else {
        return one(d, r);
    };
    let opened = quotes::create_onramp(
        d,
        o,
        &CreateAsk {
            user_id: &r.user_id,
            onramp_id: &r.id,
            quote_id: &quote_id,
            method: &r.method,
            wallet_address: r.wallet_address.as_deref(),
        },
    );
    let next: Result<String, &str> = match opened {
        Ok(onramp) => Ok(onramp.id),
        Err(e) => match final_refusal(&e) {
            Some(code) => Err(code),
            None => return Err(e),
        },
    };
    let (status, code, onramp) = match &next {
        Ok(id) => ("opened", None, Some(id.as_str())),
        Err(c) => ("refused", Some(*c), None),
    };
    let now = with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "UPDATE bank.add_money_requests SET status = $1, refusal_code = $2, onramp_id = $3::text::uuid, \
                       opened_at = CASE WHEN $1 = 'opened' THEN now() END \
                     WHERE id = $4::text::uuid AND status = 'opening' RETURNING {}",
                    cols()
                ),
                &[&status, &code, &onramp, &r.id],
            )
            .map_err(|e| pg(&e))?;
        match rows.first() {
            Some(x) => Request::from_row(x).map(Some),
            None => row(c, &r.id),
        }
    })?;
    one(d, now.unwrap_or(r))
}

/// `list`: the customer's own requests, newest first, each with its instruction read in one go.
pub fn list(d: &Deps<'_>, user_id: &str, limit: i64) -> Result<Json, Refusal> {
    with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.add_money_requests WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
                    cols()
                ),
                &[&user_id, &limit],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(Request::from_row)
            .collect::<Result<Vec<_>, _>>()?;
        let ids: Vec<String> = rows.iter().filter_map(|r| r.onramp_id.clone()).collect();
        let onramps = quotes::onramps_by_ids(c, user_id, &ids)?;
        Ok(Json::Array(
            rows.iter()
                .map(|r| {
                    let o = onramps
                        .iter()
                        .find(|o| r.onramp_id.as_deref() == Some(o.id.as_str()));
                    r.json(o)
                })
                .collect(),
        ))
    })
}

/// `request`: one of the customer's own requests.
pub fn request(d: &Deps<'_>, user_id: &str, request_id: &str) -> Result<Viewed, Refusal> {
    match with(d.store, |c| row(c, request_id))? {
        Some(r) if r.user_id == user_id => one(d, r),
        _ => Err(refuse(
            "bank.add_money_request_missing",
            "No add-money request of yours has that id",
        )),
    }
}

/// `wired`: the partner, or the socket refusal.
fn wired<'p>(o: &'p Onramp<'_>) -> Result<&'p PayinSim, Refusal> {
    o.w.partner.as_ref().ok_or_else(|| {
        refuse(
            "bank.fiat_ramp_socket",
            "No pay-in partner is connected (socket.psp-partners), so no payment is approved or credited",
        )
    })
}

/// `partnerRow`: a request this partner opened, past opening and not refused, with the payment it opened.
fn partner_row(
    d: &Deps<'_>,
    partner: &PayinSim,
    request_id: &str,
) -> Result<(Request, CustomerOnramp), Refusal> {
    let Some(r) = with(d.store, |c| row(c, request_id))? else {
        return Err(refuse(
            "bank.add_money_request_missing",
            "No add-money request has that id",
        ));
    };
    let Some(onramp_id) = r
        .onramp_id
        .clone()
        .filter(|_| r.status != "opening" && r.status != "refused")
    else {
        return Err(refuse(
            "bank.ramp_conflict",
            format!("This request is {}; no payment was opened for it", r.status),
        ));
    };
    let onramp = with(d.store, |c| {
        quotes::onramps_by_ids(c, &r.user_id, &[onramp_id])
    })?
    .into_iter()
    .next()
    .filter(|o| o.partner_rail == partner.rail())
    .ok_or_else(|| {
        refuse(
            "bank.ramp_conflict",
            "This payment was not opened by this partner",
        )
    })?;
    Ok((r, onramp))
}

/// What a partner's page answers: the request, where the payer goes back to, and whether this call approved it.
pub struct PageAnswer {
    pub viewed: Viewed,
    pub return_url: String,
    pub approved_now: bool,
}

/// `approved`: the payer approved on the partner's page. Moves no money.
pub fn approved(d: &Deps<'_>, o: &Onramp<'_>, onramp_id: &str) -> Result<PageAnswer, Refusal> {
    let partner = wired(o)?;
    let (r, onramp) = partner_row(d, partner, onramp_id)?;
    let moved = if r.status == "opened" {
        with(d.store, |c| {
            c.query(
                &format!(
                    "UPDATE bank.add_money_requests SET status = 'pending', pending_at = now() \
                     WHERE id = $1::text::uuid AND status = 'opened' RETURNING {}",
                    cols()
                ),
                &[&r.id],
            )
            .map_err(|e| pg(&e))?
            .first()
            .map(Request::from_row)
            .transpose()
        })?
    } else {
        None
    };
    let approved_now = moved.is_some();
    let now = match moved {
        Some(m) => m,
        None if r.status == "opened" => with(d.store, |c| row(c, &r.id))?.unwrap_or(r),
        None => r,
    };
    let return_url = partner.return_url(&now.id);
    Ok(PageAnswer {
        viewed: Viewed {
            request: now,
            onramp: Some(onramp),
        },
        return_url,
        approved_now,
    })
}

/// `opened`: the partner's own read of a payment it opened, for its page.
pub fn opened(d: &Deps<'_>, o: &Onramp<'_>, onramp_id: &str) -> Result<PageAnswer, Refusal> {
    let partner = wired(o)?;
    let (r, onramp) = partner_row(d, partner, onramp_id)?;
    let return_url = partner.return_url(&r.id);
    Ok(PageAnswer {
        viewed: Viewed {
            request: r,
            onramp: Some(onramp),
        },
        return_url,
        approved_now: false,
    })
}

/// `paidByFor`: how a way to pay is paid, as the partner sees it.
fn paid_by_for(method: &str) -> Option<&'static str> {
    match method {
        "card" | "wallet_pay" => Some("card"),
        "pay_by_bank" => Some("bank_pull"),
        _ => None,
    }
}

/// The TEST partner, when it holds this person's money (`purchasesFor`).
fn partner_holds<'p>(d: &'p Deps<'_>, user_id: &str) -> Option<&'p crate::partner::TestPartner> {
    d.partner
        .partner
        .as_ref()
        .filter(|p| p.lock().board.read(user_id, |s| s.custody == "off"))
}

/// The partner's "paid" call.
pub struct PaidAsk<'a> {
    pub request_id: &'a str,
    pub paid_amount: &'a str,
    pub pay_currency: &'a str,
    pub delivery_tx: Option<&'a str>,
}

fn update_one(
    d: &Deps<'_>,
    sql: &str,
    params: &[&(dyn postgres::types::ToSql + Sync)],
    id: &str,
) -> Result<Option<Request>, Refusal> {
    with(d.store, |c| {
        let rows = c.query(sql, params).map_err(|e| pg(&e))?;
        match rows.first() {
            Some(r) => Request::from_row(r).map(Some),
            None => row(c, id),
        }
    })
}

/// `paid`: credit the quote's receive amount once, through the deposit recipe (or at the partner that holds the money).
pub fn paid(d: &Deps<'_>, o: &Onramp<'_>, ask: &PaidAsk<'_>) -> Result<Viewed, Refusal> {
    let partner = wired(o)?;
    let (r, onramp) = partner_row(d, partner, ask.request_id)?;
    let Ok(paid) = parse_amount(ask.paid_amount) else {
        return Err(refuse(
            "bank.onramp_paid_mismatch",
            "The partner named a paid amount that is not an exact decimal",
        ));
    };
    if paid != onramp.pay_amount || js_trim(ask.pay_currency).to_uppercase() != onramp.pay_currency
    {
        return Err(refuse(
            "bank.onramp_paid_mismatch",
            format!(
                "The partner says {} {} was paid; the payment it opened is {} {}. Nothing was credited",
                ask.paid_amount,
                ask.pay_currency,
                format_amount(onramp.pay_amount),
                onramp.pay_currency
            ),
        ));
    }
    if r.wallet_address.is_some() {
        return delivered(d, r, onramp, ask.delivery_tx);
    }
    if ask.delivery_tx.is_some() {
        return Err(refuse(
            "bank.ramp_conflict",
            "This request adds to a balance here, not to a wallet; the partner delivers nothing on chain for it",
        ));
    }
    if r.status == "credited" {
        return Ok(Viewed {
            request: r,
            onramp: Some(onramp),
        });
    }
    let receive = onramp.amount;
    if receive != r.amount || onramp.asset_id != r.asset_id {
        return Err(refuse(
            "bank.ramp_conflict",
            "The opened payment is not on the request\u{2019}s own terms",
        ));
    }
    let key = format!("deposit:{}:add-money:{}", partner.rail(), r.id);
    let credited = format_amount(receive);
    let next = if let Some(at_partner) = partner_holds(d, &r.user_id) {
        let Some(paid_by) = paid_by_for(&r.method) else {
            return Err(refuse(
                "bank.ramp_conflict",
                "A bank transfer is not a purchase through the partner, so the partner credits nothing for it",
            ));
        };
        let credit = at_partner.lock().purchase_credit(
            &r.user_id,
            &crate::partner::desks::Purchase {
                key,
                asset_id: r.asset_id.clone(),
                amount: receive,
                paid_by: paid_by.to_owned(),
            },
            d.now,
        )?;
        update_one(
            d,
            &format!(
                "UPDATE bank.add_money_requests SET status = 'credited', credited_at = now(), \
                   credited_amount = $1::text::numeric, partner_pay_in_ref = $2 \
                 WHERE id = $3::text::uuid AND status IN ('opened', 'pending') RETURNING {}",
                cols()
            ),
            &[&credited, &credit.id, &r.id],
            &r.id,
        )?
    } else {
        let tx = super::service::post_deposit(
            d,
            &r.user_id,
            &r.asset_id,
            receive,
            partner.rail(),
            &format!("add-money:{}", r.id),
        )?;
        update_one(
            d,
            &format!(
                "UPDATE bank.add_money_requests SET status = 'credited', credited_at = now(), \
                   credited_amount = $1::text::numeric, ledger_tx_id = $2 \
                 WHERE id = $3::text::uuid AND status IN ('opened', 'pending') RETURNING {}",
                cols()
            ),
            &[&credited, &tx, &r.id],
            &r.id,
        )?
    };
    Ok(Viewed {
        request: next.unwrap_or(r),
        onramp: Some(onramp),
    })
}

/// `returned`: take a credited payment back once, where it was credited.
pub fn returned(d: &Deps<'_>, o: &Onramp<'_>, request_id: &str) -> Result<Viewed, Refusal> {
    let partner = wired(o)?;
    let (r, onramp) = partner_row(d, partner, request_id)?;
    if r.status == "returned" {
        return Ok(Viewed {
            request: r,
            onramp: Some(onramp),
        });
    }
    let Some(amount) = r.credited_amount.filter(|_| r.status == "credited") else {
        return Err(refuse(
            "bank.ramp_conflict",
            format!(
                "This request is {}; only a credited payment can be sent back",
                r.status
            ),
        ));
    };
    let at_partner = r
        .partner_pay_in_ref
        .as_deref()
        .filter(|s| !s.is_empty())
        .and_then(|_| partner_holds(d, &r.user_id));
    let (Some(at_partner), Some(paid_by)) = (at_partner, paid_by_for(&r.method)) else {
        return Err(refuse(
            "bank.ramp_conflict",
            "Only the partner that holds this person\u{2019}s money takes a returned payment back, and it did not credit this one. Nothing was taken",
        ));
    };
    let back = at_partner.lock().purchase_returned(
        &r.user_id,
        &crate::partner::desks::Purchase {
            key: format!("deposit:{}:add-money:{}", partner.rail(), r.id),
            asset_id: r.asset_id.clone(),
            amount,
            paid_by: paid_by.to_owned(),
        },
        d.now,
    )?;
    let next = update_one(
        d,
        &format!(
            "UPDATE bank.add_money_requests SET status = 'returned', returned_at = now(), return_ref = $1 \
             WHERE id = $2::text::uuid AND status = 'credited' RETURNING {}",
            cols()
        ),
        &[&back.id, &r.id],
        &r.id,
    )?;
    Ok(Viewed {
        request: next.unwrap_or(r),
        onramp: Some(onramp),
    })
}

/// `delivered`: a wallet request the partner paid out on chain. Nothing is credited or posted here.
fn delivered(
    d: &Deps<'_>,
    r: Request,
    onramp: CustomerOnramp,
    delivery_tx: Option<&str>,
) -> Result<Viewed, Refusal> {
    let Some(tx) = delivery_tx else {
        return Err(refuse(
            "bank.onramp_delivery_missing",
            "The partner delivers this purchase to the person\u{2019}s wallet, so its paid must name the on-chain transfer. Nothing changed",
        ));
    };
    let tx = tx.to_lowercase();
    if !hex0x(&tx, 64) {
        return Err(refuse(
            "bank.onramp_delivery_missing",
            "The partner named a delivery that is not a transaction hash. Nothing changed",
        ));
    }
    let other = || {
        refuse(
            "bank.ramp_conflict",
            "This purchase was already delivered with another transfer",
        )
    };
    if r.status == "delivered" {
        if r.delivery_tx.as_deref() != Some(tx.as_str()) {
            return Err(other());
        }
        return Ok(Viewed {
            request: r,
            onramp: Some(onramp),
        });
    }
    let next = update_one(
        d,
        &format!(
            "UPDATE bank.add_money_requests SET status = 'delivered', delivered_at = now(), delivery_tx = $1 \
             WHERE id = $2::text::uuid AND status IN ('opened', 'pending') RETURNING {}",
            cols()
        ),
        &[&tx, &r.id],
        &r.id,
    )?
    .unwrap_or(r);
    if next.status == "delivered" && next.delivery_tx.as_deref() != Some(tx.as_str()) {
        return Err(other());
    }
    Ok(Viewed {
        request: next,
        onramp: Some(onramp),
    })
}
