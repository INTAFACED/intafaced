//! The customer's quotes and on-ramp instructions (the quote half of `ramps/customer-ramps.ts`): `quoteOnramp`,
//! `createOnramp`, `onrampQuoteOf`, `customerOnrampsByIds`, `quoteOfframp` and `normaliseInstruction`.
//!
//! Numbers are the port's decimals, canonicalised, or the call refuses. Nothing here posts a ledger transaction.

use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, is_js_whitespace, js_trim, parse_amount};
use service_kit::time::Instant;

use super::ports::{FeeAsk, Instruction, OpenAsk, QuoteAsk};
use super::rails::{self, refuse_fiat};
use super::shape::js_len;
use super::{Deps, Onramp};
use crate::earn::ms;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::ramps::refs::{is_bank_destination_ref, is_evm_address_ref};
use crate::spaces::space::{at, in_tx, pg, with};

/// The quote columns every read selects, in [`Quote::from_row`]'s order.
fn quote_cols() -> String {
    format!(
        "id::text, user_id, asset_id, amount::text, method, country, pay_amount::text, fee::text, rate::text, \
         pay_currency, {}, delivery_estimate",
        ms("expires_at")
    )
}

/// One stored quote (`QuoteRow`), amounts canonical.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quote {
    pub id: String,
    pub user_id: String,
    pub asset_id: String,
    pub amount: Amount,
    pub method: String,
    pub country: String,
    pub pay_amount: Amount,
    pub fee: Amount,
    pub rate: Amount,
    pub pay_currency: String,
    pub expires_at: Instant,
    pub delivery_estimate: Option<String>,
}

fn amount_col(r: &Row, i: usize) -> Result<Amount, Refusal> {
    parse_amount(&r.try_get::<_, String>(i).map_err(|e| pg(&e))?).map_err(Refusal::Other)
}

impl Quote {
    fn from_row(r: &Row) -> Result<Quote, Refusal> {
        let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
        Ok(Quote {
            id: s(0)?,
            user_id: s(1)?,
            asset_id: s(2)?,
            amount: amount_col(r, 3)?,
            method: s(4)?,
            country: s(5)?,
            pay_amount: amount_col(r, 6)?,
            fee: amount_col(r, 7)?,
            rate: amount_col(r, 8)?,
            pay_currency: s(9)?,
            expires_at: Instant(r.try_get(10).map_err(|e| pg(&e))?),
            delivery_estimate: r.try_get(11).map_err(|e| pg(&e))?,
        })
    }

    /// `toQuote`: the customer's view, in `ramps.onrampQuote`'s output order.
    pub fn json(&self) -> Json {
        Json::obj([
            ("quoteId", Json::str(self.id.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("amount", Json::str(format_amount(self.amount))),
            ("method", Json::str(self.method.clone())),
            ("country", Json::str(self.country.clone())),
            ("payAmount", Json::str(format_amount(self.pay_amount))),
            ("fee", Json::str(format_amount(self.fee))),
            ("rate", Json::str(format_amount(self.rate))),
            ("payCurrency", Json::str(self.pay_currency.clone())),
            ("expiresAt", Json::str(self.expires_at.iso())),
            (
                "deliveryEstimate",
                self.delivery_estimate.clone().map_or(Json::Null, Json::str),
            ),
            ("simulated", Json::Bool(true)),
        ])
    }
}

const ONRAMP_COLS_BASE: &str = "id::text, user_id, quote_id::text, method, asset_id, amount::text, pay_amount::text, \
     fee::text, rate::text, pay_currency, partner_rail, hosted_url, bank_reference, bank_account_name, bank_account_ref";

fn onramp_cols() -> String {
    format!("{ONRAMP_COLS_BASE}, {}", ms("created_at"))
}

/// One customer on-ramp (`CustomerOnrampView`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomerOnramp {
    pub id: String,
    pub user_id: String,
    pub quote_id: String,
    pub method: String,
    pub asset_id: String,
    pub amount: Amount,
    pub pay_amount: Amount,
    pub fee: Amount,
    pub rate: Amount,
    pub pay_currency: String,
    pub partner_rail: String,
    pub hosted_url: Option<String>,
    /// The bank instruction when all three of its fields are stored.
    pub bank: Option<(String, String, String)>,
    pub created_at: Instant,
}

impl CustomerOnramp {
    fn from_row(r: &Row) -> Result<CustomerOnramp, Refusal> {
        let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
        let o = |i: usize| r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e));
        let bank = match (o(12)?, o(13)?, o(14)?) {
            (Some(a), Some(b), Some(c)) if !a.is_empty() && !b.is_empty() && !c.is_empty() => {
                Some((a, b, c))
            }
            _ => None,
        };
        Ok(CustomerOnramp {
            id: s(0)?,
            user_id: s(1)?,
            quote_id: s(2)?,
            method: s(3)?,
            asset_id: s(4)?,
            amount: amount_col(r, 5)?,
            pay_amount: amount_col(r, 6)?,
            fee: amount_col(r, 7)?,
            rate: amount_col(r, 8)?,
            pay_currency: s(9)?,
            partner_rail: s(10)?,
            hosted_url: o(11)?,
            bank,
            created_at: Instant(r.try_get(15).map_err(|e| pg(&e))?),
        })
    }

    fn bank_json(&self) -> Json {
        self.bank
            .as_ref()
            .map_or(Json::Null, |(reference, name, account)| {
                Json::obj([
                    ("reference", Json::str(reference.clone())),
                    ("accountName", Json::str(name.clone())),
                    ("accountRef", Json::str(account.clone())),
                ])
            })
    }

    fn hosted(&self) -> Json {
        self.hosted_url.clone().map_or(Json::Null, Json::str)
    }

    /// The whole view (`toCustomerOnramp`), as the bank's own services hand it on (the pay-in partner's job door).
    pub fn json(&self) -> Json {
        Json::obj([
            ("onrampId", Json::str(self.id.clone())),
            ("quoteId", Json::str(self.quote_id.clone())),
            ("userId", Json::str(self.user_id.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("amount", Json::str(format_amount(self.amount))),
            ("method", Json::str(self.method.clone())),
            ("payAmount", Json::str(format_amount(self.pay_amount))),
            ("fee", Json::str(format_amount(self.fee))),
            ("rate", Json::str(format_amount(self.rate))),
            ("payCurrency", Json::str(self.pay_currency.clone())),
            ("status", Json::str("pending_payment")),
            ("simulated", Json::Bool(true)),
            ("partnerRail", Json::str(self.partner_rail.clone())),
            ("hostedUrl", self.hosted()),
            ("bankInstructions", self.bank_json()),
            ("createdAt", Json::str(self.created_at.iso())),
        ])
    }

    /// `ramps.onrampCreate`'s output.
    pub fn create_json(&self) -> Json {
        Json::obj([
            ("onrampId", Json::str(self.id.clone())),
            ("quoteId", Json::str(self.quote_id.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("amount", Json::str(format_amount(self.amount))),
            ("method", Json::str(self.method.clone())),
            ("payAmount", Json::str(format_amount(self.pay_amount))),
            ("fee", Json::str(format_amount(self.fee))),
            ("rate", Json::str(format_amount(self.rate))),
            ("payCurrency", Json::str(self.pay_currency.clone())),
            ("status", Json::str("pending_payment")),
            ("simulated", Json::Bool(true)),
            ("partnerRail", Json::str(self.partner_rail.clone())),
            ("hostedUrl", self.hosted()),
            ("bankInstructions", self.bank_json()),
            ("createdAt", Json::str(self.created_at.iso())),
        ])
    }

    /// The add-money router's `onramp` (the customer's fields only).
    pub fn add_money_json(&self) -> Json {
        Json::obj([
            ("onrampId", Json::str(self.id.clone())),
            ("quoteId", Json::str(self.quote_id.clone())),
            ("method", Json::str(self.method.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("amount", Json::str(format_amount(self.amount))),
            ("payAmount", Json::str(format_amount(self.pay_amount))),
            ("fee", Json::str(format_amount(self.fee))),
            ("payCurrency", Json::str(self.pay_currency.clone())),
            ("status", Json::str("pending_payment")),
            ("partnerRail", Json::str(self.partner_rail.clone())),
            ("hostedUrl", self.hosted()),
            ("bankInstructions", self.bank_json()),
        ])
    }
}

/// `UUID_RE`: versions 1 to 8, the RFC variant, any case.
fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            14 => (b'1'..=b'8').contains(c),
            19 => matches!(c.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'),
            _ => c.is_ascii_hexdigit(),
        })
}

/// `assertUuid`.
pub fn assert_uuid(value: &str, label: &str) -> Result<(), Refusal> {
    if is_uuid(value) {
        Ok(())
    } else {
        Err(refuse(
            "bank.validation_failed",
            format!("{label} must be a uuid"),
        ))
    }
}

/// `asAmount`.
fn as_amount(value: &str, what: &str, code: &str) -> Result<Amount, Refusal> {
    parse_amount(value).map_err(|_| refuse(code, format!("{what} is not an exact decimal string")))
}

/// `positive`.
pub fn positive(value: &str, what: &str, code: &str) -> Result<Amount, Refusal> {
    let parsed = as_amount(value, what, code)?;
    if parsed <= Amount::ZERO {
        return Err(refuse(code, format!("{what} must be positive")));
    }
    Ok(parsed)
}

/// `nonNegative`.
fn non_negative(value: &str, what: &str, code: &str) -> Result<Amount, Refusal> {
    let parsed = as_amount(value, what, code)?;
    if parsed < Amount::ZERO {
        return Err(refuse(code, format!("{what} must not be negative")));
    }
    Ok(parsed)
}

/// `assertAsset`.
fn assert_asset(asset_id: &str) -> Result<(), Refusal> {
    let trimmed = js_trim(asset_id);
    if trimmed.is_empty() || trimmed != asset_id || js_len(trimmed) > 16 {
        return Err(refuse(
            "bank.ramp_invalid_asset",
            "Ramp asset id must be a non-empty crypto symbol with no leading or trailing whitespace",
        ));
    }
    Ok(())
}

/// `rampQuoteExpired`: the TEST ramp says this person's quote ran out.
pub fn test_quote_expired(d: &Deps<'_>, user_id: &str) -> bool {
    d.partner
        .partner
        .as_ref()
        .is_some_and(|p| p.lock().board.read(user_id, |s| s.ramp_quote == "expired"))
}

/// `assertRampFeeKnown`: the TEST ramp that gives no fee gives no pay amount either.
fn assert_test_fee_known(d: &Deps<'_>, user_id: &str) -> Result<(), Refusal> {
    let unknown = d
        .partner
        .partner
        .as_ref()
        .is_some_and(|p| p.lock().board.read(user_id, |s| s.ramp_fee == "unknown"));
    if unknown {
        return Err(refuse(
            "bank.onramp_fee_not_known",
            "The partner gave no fee for this purchase, so what you would pay is not known. Nothing was kept or charged.",
        ));
    }
    Ok(())
}

/// What a customer asks to be quoted.
pub struct OnrampAsk<'a> {
    pub user_id: &'a str,
    pub asset_id: &'a str,
    pub amount: &'a str,
    pub method: &'a str,
    pub country: &'a str,
}

/// `quoteOnramp`: pay amount, fee and rate from the rate source, kept as the customer's quote. A blank PSP or a blank
/// source refuses; nothing is invented.
pub fn quote_onramp(d: &Deps<'_>, o: &Onramp, ask: &OnrampAsk<'_>) -> Result<Quote, Refusal> {
    let amount = positive(ask.amount, "On-ramp amount", "bank.ramp_invalid_amount")?;
    assert_asset(ask.asset_id)?;
    let country = js_trim(ask.country).to_uppercase();
    if !super::shape::upper(&country, 2, 2, false) {
        return Err(refuse(
            "bank.validation_failed",
            "On-ramp country must be two letters",
        ));
    }
    let stand_in =
        o.w.stand_in
            .as_ref()
            .filter(|s| s.covers(ask.asset_id, ask.method, &country));
    if stand_in.is_none() {
        rails::assert_fiat_socket_when_none(&o.programme())?;
        rails::resolve_rail_id(o.w.pay_fiat.as_ref(), "onramp")?;
    }
    let source: &dyn super::ports::QuoteSource = match (stand_in, o.w.quotes.as_deref()) {
        (Some(s), _) => s,
        (None, Some(q)) => q,
        (None, None) => {
            return Err(refuse(
                "bank.onramp_rate_unset",
                "On-ramp quote has no rate or fee source. socket.psp-partners is not a price. No pay amount, fee, or rate is invented.",
            ));
        }
    };
    assert_test_fee_known(d, ask.user_id)?;
    let Some(terms) = source.quote(
        &QuoteAsk {
            asset_id: ask.asset_id.to_owned(),
            amount: format_amount(amount),
            method: ask.method.to_owned(),
            country: country.clone(),
        },
        d.now,
    )?
    else {
        return Err(refuse(
            "bank.onramp_rate_unset",
            "The rate source returned no on-ramp quote. socket.psp-partners is not a price. No pay amount, fee, or rate is invented.",
        ));
    };
    let unset = "bank.onramp_rate_unset";
    let pay_amount = positive(&terms.pay_amount, "On-ramp pay amount", unset)?;
    let fee = non_negative(&terms.fee, "On-ramp fee", unset)?;
    let rate = positive(&terms.rate, "On-ramp rate", unset)?;
    let pay_currency = terms
        .pay_currency
        .as_deref()
        .map(js_trim)
        .unwrap_or_default();
    if !super::shape::upper(pay_currency, 3, 16, false) {
        return Err(refuse(unset, "The rate source did not name a pay currency"));
    }
    let Some(expires_at) = terms.expires_at.filter(|e| e.0 > d.now.0) else {
        return Err(refuse(
            unset,
            "The rate source did not publish a future expiry",
        ));
    };
    let estimate = terms
        .delivery_estimate
        .as_deref()
        .map(js_trim)
        .filter(|e| !e.is_empty());
    if estimate.is_some_and(|e| js_len(e) > 140) {
        return Err(refuse(
            unset,
            "The rate source published a delivery estimate longer than 140 characters",
        ));
    }
    with(d.store, |c| {
        let row = c
            .query_one(
                &format!(
                    "INSERT INTO bank.ramp_onramp_quotes (user_id, asset_id, amount, method, country, pay_amount, fee, \
                       rate, pay_currency, expires_at, simulated, delivery_estimate) \
                     VALUES ($1, $2, $3::text::numeric, $4, $5, $6::text::numeric, $7::text::numeric, $8::text::numeric, \
                       $9, {}, true, $11) RETURNING {}",
                    at("$10"),
                    quote_cols()
                ),
                &[
                    &ask.user_id,
                    &ask.asset_id,
                    &format_amount(amount),
                    &ask.method,
                    &country,
                    &format_amount(pay_amount),
                    &format_amount(fee),
                    &format_amount(rate),
                    &pay_currency,
                    &expires_at.0,
                    &estimate,
                ],
            )
            .map_err(|e| pg(&e))?;
        Quote::from_row(&row)
    })
}

/// `loadQuote`: one of the customer's quotes; the TEST ramp that says it expired makes it read as run out now.
fn load_quote(
    c: &mut impl GenericClient,
    d: &Deps<'_>,
    user_id: &str,
    quote_id: &str,
    lock: bool,
) -> Result<Option<Quote>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.ramp_onramp_quotes WHERE id = $1::text::uuid AND user_id = $2{}",
                quote_cols(),
                if lock { " FOR UPDATE" } else { "" }
            ),
            &[&quote_id, &user_id],
        )
        .map_err(|e| pg(&e))?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let mut q = Quote::from_row(row)?;
    if !lock && test_quote_expired(d, user_id) && q.expires_at.0 > d.now.0 {
        q.expires_at = d.now;
    }
    Ok(Some(q))
}

fn quote_missing() -> Refusal {
    refuse("bank.onramp_quote_missing", "On-ramp quote was not found")
}

fn quote_expired() -> Refusal {
    refuse("bank.onramp_quote_expired", "On-ramp quote has expired")
}

/// `onrampQuoteOf`: one of the customer's own quotes as stored, expired or not.
pub fn onramp_quote_of(d: &Deps<'_>, user_id: &str, quote_id: &str) -> Result<Quote, Refusal> {
    assert_uuid(quote_id, "quoteId")?;
    with(d.store, |c| load_quote(c, d, user_id, quote_id, false))?.ok_or_else(quote_missing)
}

fn onramp_by_id(
    c: &mut impl GenericClient,
    id: &str,
    lock: bool,
) -> Result<Option<CustomerOnramp>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.customer_onramps WHERE id = $1::text::uuid{}",
                onramp_cols(),
                if lock { " FOR UPDATE" } else { "" }
            ),
            &[&id],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(CustomerOnramp::from_row).transpose()
}

/// `sameOnramp`.
fn same_onramp(
    row: CustomerOnramp,
    user_id: &str,
    quote_id: &str,
) -> Result<CustomerOnramp, Refusal> {
    if row.user_id != user_id || row.quote_id != quote_id {
        return Err(refuse(
            "bank.ramp_conflict",
            "On-ramp id was already used with different terms",
        ));
    }
    Ok(row)
}

/// What a customer asks to open.
pub struct CreateAsk<'a> {
    pub user_id: &'a str,
    pub onramp_id: &'a str,
    pub quote_id: &'a str,
    pub method: &'a str,
    pub wallet_address: Option<&'a str>,
}

/// The instruction as stored (`normaliseInstruction`'s answer).
struct Stored {
    partner_rail: String,
    hosted_url: Option<String>,
    bank: Option<(String, String, String)>,
}

fn instruction_missing(message: &str) -> Refusal {
    refuse("bank.onramp_instruction_missing", message)
}

/// `isLoopbackHttp`: an http page on this machine, which only a dev or test process takes.
fn is_loopback_http(d: &Deps<'_>, raw: &str) -> bool {
    let s = &d.w.settings;
    if !crate::cards::terms::dev_or_test(s.app_env.as_deref(), s.node_env.as_deref()) {
        return false;
    }
    url::Url::parse(raw).is_ok_and(|u| u.scheme() == "http" && super::payin::is_loopback_host(&u))
}

/// `normaliseInstruction`.
fn normalise(
    d: &Deps<'_>,
    method: &str,
    i: &Instruction,
    loopback_pages: bool,
) -> Result<Stored, Refusal> {
    let partner_rail = i.partner_rail.as_deref().map(js_trim).unwrap_or_default();
    if partner_rail.is_empty() || js_len(partner_rail) > 64 {
        return Err(instruction_missing("The partner did not name its rail"));
    }
    if method == "bank_transfer" {
        let field = |f: fn(&super::ports::BankInstruction) -> &Option<String>| {
            i.bank
                .as_ref()
                .and_then(|b| f(b).as_deref())
                .map(js_trim)
                .unwrap_or_default()
                .to_owned()
        };
        let reference = field(|b| &b.reference);
        let account_name = field(|b| &b.account_name);
        let account_ref = field(|b| &b.account_ref);
        if reference.is_empty()
            || js_len(&reference) > 140
            || account_name.is_empty()
            || js_len(&account_name) > 140
            || !is_bank_destination_ref(&account_ref)
        {
            return Err(instruction_missing(
                "The partner did not return bank-transfer instructions (reference, account name, IBAN or IFSC)",
            ));
        }
        if i.hosted_url.as_deref().is_some_and(|u| !u.is_empty()) {
            return Err(instruction_missing(
                "A bank transfer instruction must not also carry a hosted card URL",
            ));
        }
        let account: String = account_ref
            .chars()
            .filter(|c| !is_js_whitespace(*c))
            .collect::<String>()
            .to_uppercase();
        return Ok(Stored {
            partner_rail: partner_rail.to_owned(),
            hosted_url: None,
            bank: Some((reference, account_name, account)),
        });
    }
    let hosted = i.hosted_url.as_deref().map(js_trim).unwrap_or_default();
    let secure = hosted.starts_with("https://") || (loopback_pages && is_loopback_http(d, hosted));
    if !secure || js_len(hosted) > 2000 || hosted.chars().any(is_js_whitespace) {
        return Err(instruction_missing(
            "The partner did not return an https hosted payment URL",
        ));
    }
    Ok(Stored {
        partner_rail: partner_rail.to_owned(),
        hosted_url: Some(hosted.to_owned()),
        bank: None,
    })
}

/// `createOnramp`: idempotent by the on-ramp id. Stores the partner's instruction and credits nothing. A blank partner
/// refuses `bank.fiat_ramp_socket` before any row.
pub fn create_onramp(
    d: &Deps<'_>,
    o: &Onramp,
    ask: &CreateAsk<'_>,
) -> Result<CustomerOnramp, Refusal> {
    assert_uuid(ask.onramp_id, "onrampId")?;
    assert_uuid(ask.quote_id, "quoteId")?;
    let quote = with(d.store, |c| {
        load_quote(c, d, ask.user_id, ask.quote_id, false)
    })?
    .ok_or_else(quote_missing)?;
    if quote.method != ask.method {
        return Err(refuse(
            "bank.ramp_conflict",
            "On-ramp method does not match the quote",
        ));
    }
    // A replay of an instruction already opened returns it, even after its quote expired: the partner holds it.
    if let Some(existing) = with(d.store, |c| onramp_by_id(c, ask.onramp_id, false))? {
        return same_onramp(existing, ask.user_id, &quote.id);
    }
    if quote.expires_at.0 <= d.now.0 {
        return Err(quote_expired());
    }
    let Some(payments) = o.payments() else {
        return Err(refuse(
            "bank.fiat_ramp_socket",
            "Fiat on-ramp payment is socket.psp-partners — no partner is connected, so no hosted URL or bank instruction is invented. Nothing was charged.",
        ));
    };
    let Some(instruction) = payments.open(
        &OpenAsk {
            onramp_id: ask.onramp_id.to_owned(),
            quote_id: quote.id.clone(),
            method: ask.method.to_owned(),
            user_id: ask.user_id.to_owned(),
            asset_id: quote.asset_id.clone(),
            amount: format_amount(quote.amount),
            wallet_address: ask
                .wallet_address
                .filter(|w| !w.is_empty())
                .map(str::to_owned),
            quote_expires_at: Some(quote.expires_at),
        },
        d.now,
    )?
    else {
        return Err(refuse(
            "bank.fiat_ramp_socket",
            "Fiat on-ramp payment is socket.psp-partners — the partner returned no hosted URL or bank instruction. Nothing was charged.",
        ));
    };
    let stored = normalise(d, ask.method, &instruction, payments.loopback_pages())?;
    let inserted = in_tx(d.store, |tx| {
        let again = load_quote(tx, d, ask.user_id, &quote.id, true)?;
        if again.is_none_or(|q| q.expires_at.0 <= d.now.0) || test_quote_expired(d, ask.user_id) {
            return Err(quote_expired());
        }
        if let Some(prior) = onramp_by_id(tx, ask.onramp_id, true)? {
            return Ok(prior);
        }
        let (reference, name, account) = match &stored.bank {
            Some((a, b, c)) => (Some(a.as_str()), Some(b.as_str()), Some(c.as_str())),
            None => (None, None, None),
        };
        let rows = tx
            .query(
                &format!(
                    "INSERT INTO bank.customer_onramps (id, user_id, quote_id, method, asset_id, amount, pay_amount, fee, \
                       rate, pay_currency, status, simulated, partner_rail, hosted_url, bank_reference, bank_account_name, \
                       bank_account_ref) \
                     VALUES ($1::text::uuid, $2, $3::text::uuid, $4, $5, $6::text::numeric, $7::text::numeric, \
                       $8::text::numeric, $9::text::numeric, $10, 'pending_payment', true, $11, $12, $13, $14, $15) \
                     ON CONFLICT (id) DO NOTHING RETURNING {}",
                    onramp_cols()
                ),
                &[
                    &ask.onramp_id,
                    &ask.user_id,
                    &quote.id,
                    &ask.method,
                    &quote.asset_id,
                    &format_amount(quote.amount),
                    &format_amount(quote.pay_amount),
                    &format_amount(quote.fee),
                    &format_amount(quote.rate),
                    &quote.pay_currency,
                    &stored.partner_rail,
                    &stored.hosted_url,
                    &reference,
                    &name,
                    &account,
                ],
            )
            .map_err(|e| pg(&e))?;
        if let Some(row) = rows.first() {
            return CustomerOnramp::from_row(row);
        }
        onramp_by_id(tx, ask.onramp_id, true)?
            .ok_or_else(|| refuse("bank.ramp_conflict", "On-ramp was not stored"))
    })?;
    same_onramp(inserted, ask.user_id, &quote.id)
}

/// `customerOnrampsByIds`: the customer's own on-ramps among these ids, in one read; someone else's are left out.
pub fn onramps_by_ids(
    c: &mut impl GenericClient,
    user_id: &str,
    ids: &[String],
) -> Result<Vec<CustomerOnramp>, Refusal> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.customer_onramps WHERE id = ANY($1::text[]::uuid[]) AND user_id = $2",
                onramp_cols()
            ),
            &[&ids, &user_id],
        )
        .map_err(|e| pg(&e))?;
    rows.iter().map(CustomerOnramp::from_row).collect()
}

/// `quoteOfframp`: the crypto fee from the fee source. Kind fiat refuses the socket; no source refuses rather than
/// quoting zero; a fee and net that do not add up are not adjusted.
pub fn quote_offramp(
    d: &Deps<'_>,
    o: &Onramp,
    asset_id: &str,
    amount: &str,
    kind: &str,
    destination_ref: &str,
) -> Result<Json, Refusal> {
    if kind == "fiat" {
        return Err(refuse_fiat());
    }
    let amount = positive(amount, "Off-ramp amount", "bank.ramp_invalid_amount")?;
    assert_asset(asset_id)?;
    let destination_ref = js_trim(destination_ref);
    if !is_evm_address_ref(destination_ref) {
        return Err(refuse(
            "bank.ramp_invalid_destination",
            "Crypto off-ramp quote destination must be an EVM address",
        ));
    }
    rails::assert_crypto(&o.programme())?;
    let unset = "bank.offramp_fee_unset";
    let Some(fees) = o.w.fees.as_deref() else {
        return Err(refuse(
            unset,
            "No off-ramp fee schedule is published for the crypto ledger half. A zero fee is not assumed, and no net amount is returned.",
        ));
    };
    let Some(terms) = fees.quote(
        &FeeAsk {
            asset_id: asset_id.to_owned(),
            amount: format_amount(amount),
            destination_ref: destination_ref.to_owned(),
        },
        d.now,
    )?
    else {
        return Err(refuse(
            unset,
            "The fee source returned no off-ramp quote. A zero fee is not assumed, and no net amount is returned.",
        ));
    };
    let fee = non_negative(&terms.fee, "Off-ramp fee", unset)?;
    let net = positive(&terms.net_amount, "Off-ramp net amount", unset)?;
    if fee.checked_add(net) != Some(amount) {
        return Err(refuse(
            "bank.offramp_fee_inconsistent",
            "The fee source published a fee and net that do not add up to the amount. The numbers are not adjusted.",
        ));
    }
    let Some(expires_at) = terms.expires_at.filter(|e| e.0 > d.now.0) else {
        return Err(refuse(
            unset,
            "The fee source did not publish a future expiry",
        ));
    };
    Ok(Json::obj([
        ("assetId", Json::str(asset_id)),
        ("amount", Json::str(format_amount(amount))),
        ("kind", Json::str("crypto")),
        ("destinationRef", Json::str(destination_ref)),
        ("fee", Json::str(format_amount(fee))),
        ("netAmount", Json::str(format_amount(net))),
        ("expiresAt", Json::str(expires_at.iso())),
        ("simulated", Json::Bool(true)),
    ]))
}
