//! What metering asks outside svc-agents, each behind one trait, built once in `main.rs` and handed to the door
//! (`docs/agents/shape.md` rule 5):
//!
//! - [`Ledger`]: svc-ledger's `postRecipe` door. A window's charge names a `packages/ledger-client` recipe
//!   (`feeCharge`, `chargeEarn`, `chargeCollect`) and its business inputs; svc-ledger builds the entries (AGENTS.md
//!   floor 1). svc-agents builds none and holds no balance.
//! - [`UsagePayment`]: how a person pays, read from svc-bank (`payment/usage-payment.ts`, `POST
//!   /internal/agents/usage-payment`). No `BANK_URL`: everyone is on the custodial ledger charge ([`LedgerOnly`]).
//! - [`Affiliates`]: svc-identity's affiliate accrue and payout after a charge (`affiliate-accrue.ts`,
//!   `affiliate-payout.ts`): best effort, never failing the charge. No `IDENTITY_URL`: nothing is asked.
//! - [`Bus`]: the event bus's publish side, for `agentUsageSettled`.

use std::sync::Arc;
use std::time::Duration;

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount};
use service_kit::s2s::CallSigner;

/// One `packages/ledger-client` recipe a window's charge names, with its business inputs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recipe {
    /// `recipes.feeCharge({ chargeId, userId, module, mode: 'asset', assetId, amount, reason })`: the custodial charge.
    FeeCharge {
        charge_id: String,
        user_id: String,
        module: String,
        asset_id: String,
        amount: Amount,
        reason: String,
    },
    /// `recipes.chargeEarn({ module, saleId, userId, memberUserId?, assetId, price: { perUnit }, units: 1n })`: the window
    /// earned in our ledger as owed by the person (or the business, naming the member).
    ChargeEarn {
        module: String,
        sale_id: String,
        user_id: String,
        member_user_id: Option<String>,
        asset_id: String,
        per_unit: Amount,
    },
    /// `recipes.chargeCollect({ module, userId, to: { kind: 'partner-reserve', partnerId }, paymentId, assetId, amount })`.
    ChargeCollect {
        module: String,
        user_id: String,
        partner_id: String,
        payment_id: String,
        asset_id: String,
        amount: Amount,
    },
}

impl Recipe {
    /// The recipe's name at the `postRecipe` door.
    pub fn name(&self) -> &'static str {
        match self {
            Recipe::FeeCharge { .. } => "feeCharge",
            Recipe::ChargeEarn { .. } => "chargeEarn",
            Recipe::ChargeCollect { .. } => "chargeCollect",
        }
    }

    /// The idempotency key the recipe builds from its inputs, and so the key the ledger's receipt must name.
    pub fn idempotency_key(&self) -> String {
        match self {
            Recipe::FeeCharge {
                module, charge_id, ..
            } => format!("fee:{module}:{charge_id}"),
            Recipe::ChargeEarn {
                module, sale_id, ..
            } => format!("charge:earned:{module}:{sale_id}"),
            Recipe::ChargeCollect {
                partner_id,
                asset_id,
                payment_id,
                ..
            } => format!("charge:collected:partner-reserve:{partner_id}:{asset_id}:{payment_id}"),
        }
    }

    /// The business inputs, amounts as decimal strings and counts as integer strings, as on the wire.
    pub fn input(&self) -> Json {
        match self {
            Recipe::FeeCharge {
                charge_id,
                user_id,
                module,
                asset_id,
                amount,
                reason,
            } => Json::obj([
                ("chargeId", Json::str(charge_id.clone())),
                ("userId", Json::str(user_id.clone())),
                ("module", Json::str(module.clone())),
                ("mode", Json::str("asset")),
                ("assetId", Json::str(asset_id.clone())),
                ("amount", Json::str(format_amount(*amount))),
                ("reason", Json::str(reason.clone())),
            ]),
            Recipe::ChargeEarn {
                module,
                sale_id,
                user_id,
                member_user_id,
                asset_id,
                per_unit,
            } => {
                let mut fields = vec![
                    ("module", Json::str(module.clone())),
                    ("saleId", Json::str(sale_id.clone())),
                    ("userId", Json::str(user_id.clone())),
                ];
                if let Some(m) = member_user_id {
                    fields.push(("memberUserId", Json::str(m.clone())));
                }
                fields.extend([
                    ("assetId", Json::str(asset_id.clone())),
                    (
                        "price",
                        Json::obj([("perUnit", Json::str(format_amount(*per_unit)))]),
                    ),
                    ("units", Json::str("1")),
                ]);
                obj(fields)
            }
            Recipe::ChargeCollect {
                module,
                user_id,
                partner_id,
                payment_id,
                asset_id,
                amount,
            } => Json::obj([
                ("module", Json::str(module.clone())),
                ("userId", Json::str(user_id.clone())),
                (
                    "to",
                    Json::obj([
                        ("kind", Json::str("partner-reserve")),
                        ("partnerId", Json::str(partner_id.clone())),
                    ]),
                ),
                ("paymentId", Json::str(payment_id.clone())),
                ("assetId", Json::str(asset_id.clone())),
                ("amount", Json::str(format_amount(*amount))),
            ]),
        }
    }
}

/// A post the ledger did not take: the code it named (`ledger.insufficient_funds`, `ledger.posting_frozen`, ...) when
/// it named one, and why. Nothing is assumed booked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerError {
    pub code: Option<String>,
    pub message: String,
}

/// svc-ledger's `postRecipe`.
pub trait Ledger: Send + Sync {
    /// Books the recipe once under its key; the transaction id, the same on every repeat of the key.
    fn post_recipe(&self, recipe: &Recipe) -> Result<String, LedgerError>;
}

/// No `LEDGER_URL`: every post is refused, so nothing is charged and every window stays owed on its key.
pub struct NoLedger;

impl Ledger for NoLedger {
    fn post_recipe(&self, _recipe: &Recipe) -> Result<String, LedgerError> {
        Err(LedgerError {
            code: None,
            message: "svc-agents: no ledger is wired".to_owned(),
        })
    }
}

/// `POST /trpc/postRecipe` on svc-ledger, signed as svc-agents. A 502, 503 or 504 is asked again, twice at most, under
/// the same key; any other refusal is returned as the ledger named it. The receipt must name the recipe's own key.
pub struct LedgerHttp {
    pub base_url: String,
    pub signer: CallSigner,
    pub fetch: Arc<dyn Fetch>,
    pub timeout_ms: u64,
    pub retries: u32,
    pub sleep: fn(Duration),
}

/// svc-ledger's `postRecipe` path.
pub const POST_RECIPE_PATH: &str = "/trpc/postRecipe";

impl LedgerHttp {
    pub fn new(base_url: &str, signer: CallSigner, fetch: Arc<dyn Fetch>) -> LedgerHttp {
        LedgerHttp {
            base_url: base_url.trim_end_matches('/').to_owned(),
            signer,
            fetch,
            timeout_ms: 10_000,
            retries: 2,
            sleep: std::thread::sleep,
        }
    }
}

fn ledger_refusal(status: u16, body: &str) -> LedgerError {
    let parsed = json::parse(body).ok();
    let text = |v: Option<&Json>| match v {
        Some(Json::String(s)) => Some(s.clone()),
        _ => None,
    };
    let code = parsed.as_ref().and_then(|p| text(p.get("code")));
    let message = parsed
        .as_ref()
        .and_then(|p| text(p.get("message")))
        .unwrap_or_else(|| format!("svc-ledger postRecipe failed ({status}): {body}"));
    LedgerError { code, message }
}

impl Ledger for LedgerHttp {
    fn post_recipe(&self, recipe: &Recipe) -> Result<String, LedgerError> {
        let payload = Json::obj([
            ("recipe", Json::str(recipe.name())),
            ("input", recipe.input()),
        ])
        .compact();
        let url = format!("{}{POST_RECIPE_PATH}", self.base_url);
        let mut attempt = 0;
        loop {
            let headers = self
                .signer
                .sign(&payload, "POST", POST_RECIPE_PATH, "application/json")
                .map_err(|message| LedgerError {
                    code: None,
                    message,
                })?;
            let mut all = vec![("content-type".to_owned(), "application/json".to_owned())];
            all.extend(headers);
            let sent = self.fetch.fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: url.clone(),
                headers: all,
                body: Some(payload.clone()),
                timeout_ms: Some(self.timeout_ms),
                refuse_redirect: false,
            });
            let retryable = match &sent {
                Err(_) => true,
                Ok(res) => [502, 503, 504].contains(&res.status),
            };
            if retryable && attempt < self.retries {
                (self.sleep)(Duration::from_millis(150 << attempt));
                attempt += 1;
                continue;
            }
            let res = sent.map_err(|e| LedgerError {
                code: None,
                message: e.message,
            })?;
            if !res.ok() {
                return Err(ledger_refusal(res.status, &res.body));
            }
            let receipt = json::parse(&res.body).map_err(|e| LedgerError {
                code: None,
                message: format!("svc-ledger postRecipe answered no JSON: {}", e.message),
            })?;
            let key = recipe.idempotency_key();
            let named = matches!(receipt.get("idempotencyKey"), Some(Json::String(k)) if *k == key);
            return match receipt.get("txId") {
                Some(Json::String(tx)) if named && !tx.trim().is_empty() => Ok(tx.clone()),
                _ => Err(LedgerError {
                    code: None,
                    message: format!(
                        "svc-ledger postRecipe answered a receipt that is not for {key}"
                    ),
                }),
            };
        }
    }
}

/// How the person (or the team's business) pays for this window (`AgentsUsagePaymentRead`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeldBy {
    /// The custodial layer: a ledger fee charge.
    Ledger,
    /// Their partner holds their money: the window is earned as owed, then collected.
    Partner,
    /// No payment method: the window is earned as owed and nothing is asked of a partner.
    None,
}

/// `AgentsUsagePaymentCollect`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Collected {
    Paid {
        payment_id: String,
        partner_id: String,
        label: String,
    },
    /// The partner refused, by name (`insufficient_funds`, `partner_unavailable`, ...): the window stays owed.
    Refused(String),
}

/// `UsagePaymentUnavailable`: how this person pays could not be read. Never read as "no payment method".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaymentUnavailable;

/// `UsagePaymentPort`.
pub trait UsagePayment: Send + Sync {
    fn read(
        &self,
        user_id: &str,
        asset_id: &str,
        business_id: Option<&str>,
    ) -> Result<HeldBy, PaymentUnavailable>;
    /// `read` with the partner's reported balance (`available`), which the runtime's funds check reads; none when
    /// the partner has not reported it (an unknown figure, never 0).
    fn read_available(
        &self,
        user_id: &str,
        asset_id: &str,
        business_id: Option<&str>,
    ) -> Result<(HeldBy, Option<String>), PaymentUnavailable> {
        self.read(user_id, asset_id, business_id).map(|h| (h, None))
    }
    fn collect(
        &self,
        user_id: &str,
        asset_id: &str,
        amount: Amount,
        charge_key: &str,
        business_id: Option<&str>,
    ) -> Result<Collected, PaymentUnavailable>;
}

/// `ledgerOnlyPayment`: no `BANK_URL`, everyone on the custodial ledger charge.
pub struct LedgerOnly;

impl UsagePayment for LedgerOnly {
    fn read(&self, _: &str, _: &str, _: Option<&str>) -> Result<HeldBy, PaymentUnavailable> {
        Ok(HeldBy::Ledger)
    }
    fn collect(
        &self,
        _: &str,
        _: &str,
        _: Amount,
        _: &str,
        _: Option<&str>,
    ) -> Result<Collected, PaymentUnavailable> {
        Ok(Collected::Refused("not_partner_held".to_owned()))
    }
}

/// `AGENTS_USAGE_PAYMENT_PATH`.
pub const USAGE_PAYMENT_PATH: &str = "/internal/agents/usage-payment";

/// `AGENTS_USAGE_PAYMENT_REFUSALS`.
pub const PAYMENT_REFUSALS: [&str; 6] = [
    "insufficient_funds",
    "partner_unavailable",
    "reply_lost",
    "posting_frozen",
    "partner_stopped",
    "not_partner_held",
];

/// `createHttpUsagePaymentPort`: svc-bank's door, signed as svc-agents for svc-bank. A failed call or an answer that
/// breaks the contract's schema is `PaymentUnavailable`; a collect answered for another amount is too.
pub struct UsagePaymentHttp {
    pub url: String,
    pub signer: CallSigner,
    pub fetch: Arc<dyn Fetch>,
}

impl UsagePaymentHttp {
    pub fn new(bank_url: &str, signer: CallSigner, fetch: Arc<dyn Fetch>) -> UsagePaymentHttp {
        UsagePaymentHttp {
            url: format!("{}{USAGE_PAYMENT_PATH}", bank_url.trim_end_matches('/')),
            signer,
            fetch,
        }
    }

    fn call(&self, payload: &Json) -> Result<Json, PaymentUnavailable> {
        let body = payload.compact();
        let headers = self
            .signer
            .sign(&body, "POST", USAGE_PAYMENT_PATH, "application/json")
            .map_err(|_| PaymentUnavailable)?;
        let mut all = vec![
            ("accept".to_owned(), "application/json".to_owned()),
            ("content-type".to_owned(), "application/json".to_owned()),
        ];
        all.extend(headers);
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: self.url.clone(),
                headers: all,
                body: Some(body),
                timeout_ms: None,
                refuse_redirect: false,
            })
            .map_err(|_| PaymentUnavailable)?;
        if !res.ok() {
            return Err(PaymentUnavailable);
        }
        json::parse(&res.body).map_err(|_| PaymentUnavailable)
    }
}

fn keys_are(o: &Json, allowed: &[&str]) -> bool {
    match o {
        Json::Object(fields) => fields.iter().all(|(k, _)| allowed.contains(&k.as_str())),
        _ => false,
    }
}

fn str_of<'a>(o: &'a Json, k: &str) -> Option<&'a str> {
    match o.get(k) {
        Some(Json::String(s)) => Some(s.as_str()),
        _ => None,
    }
}

/// The contract's `decimal`: up to 30 digits, then up to 18 after a point.
fn is_decimal(s: &str) -> bool {
    let (whole, frac) = s.split_once('.').map_or((s, None), |(w, f)| (w, Some(f)));
    (1..=30).contains(&whole.len())
        && whole.bytes().all(|b| b.is_ascii_digit())
        && frac.is_none_or(|f| (1..=18).contains(&f.len()) && f.bytes().all(|b| b.is_ascii_digit()))
}

fn payment_id_ok(s: &str) -> bool {
    (1..=128).contains(&s.len()) && !s.chars().any(|c| c == ':' || c.is_whitespace())
}

fn partner_id_ok(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=64).contains(&b.len())
        && b.first()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

fn label_ok(s: &str) -> bool {
    (1..=64).contains(&s.encode_utf16().count())
}

fn with_business(mut fields: Vec<(&'static str, Json)>, business_id: Option<&str>) -> Json {
    if let Some(b) = business_id {
        fields.push(("businessId", Json::str(b)));
    }
    obj(fields)
}

impl UsagePayment for UsagePaymentHttp {
    fn read(
        &self,
        user_id: &str,
        asset_id: &str,
        business_id: Option<&str>,
    ) -> Result<HeldBy, PaymentUnavailable> {
        self.read_available(user_id, asset_id, business_id)
            .map(|(h, _)| h)
    }

    fn read_available(
        &self,
        user_id: &str,
        asset_id: &str,
        business_id: Option<&str>,
    ) -> Result<(HeldBy, Option<String>), PaymentUnavailable> {
        let answer = self.call(&with_business(
            vec![
                ("action", Json::str("read")),
                ("userId", Json::str(user_id)),
                ("assetId", Json::str(asset_id)),
            ],
            business_id,
        ))?;
        match str_of(&answer, "heldBy") {
            Some("ledger") if keys_are(&answer, &["heldBy"]) => Ok((HeldBy::Ledger, None)),
            Some("none") if keys_are(&answer, &["heldBy"]) => Ok((HeldBy::None, None)),
            Some("partner")
                if keys_are(&answer, &["heldBy", "label", "available", "asOf"])
                    && str_of(&answer, "label").is_some_and(label_ok)
                    && match answer.get("available") {
                        Some(Json::Null) => true,
                        Some(Json::String(a)) => is_decimal(a),
                        _ => false,
                    }
                    && match answer.get("asOf") {
                        Some(Json::Null) => true,
                        Some(Json::String(t)) => {
                            service_kit::time::zod_datetime(t, false).is_some()
                        }
                        _ => false,
                    } =>
            {
                Ok((
                    HeldBy::Partner,
                    str_of(&answer, "available").map(str::to_owned),
                ))
            }
            _ => Err(PaymentUnavailable),
        }
    }

    fn collect(
        &self,
        user_id: &str,
        asset_id: &str,
        amount: Amount,
        charge_key: &str,
        business_id: Option<&str>,
    ) -> Result<Collected, PaymentUnavailable> {
        let asked = format_amount(amount);
        let answer = self.call(&with_business(
            vec![
                ("action", Json::str("collect")),
                ("userId", Json::str(user_id)),
                ("assetId", Json::str(asset_id)),
                ("amount", Json::str(asked.clone())),
                ("chargeKey", Json::str(charge_key)),
            ],
            business_id,
        ))?;
        match answer.get("ok") {
            Some(Json::Bool(false)) => match str_of(&answer, "reason") {
                Some(r)
                    if keys_are(&answer, &["ok", "reason"]) && PAYMENT_REFUSALS.contains(&r) =>
                {
                    Ok(Collected::Refused(r.to_owned()))
                }
                _ => Err(PaymentUnavailable),
            },
            Some(Json::Bool(true)) => {
                let (Some(payment_id), Some(partner_id), Some(label), Some(paid), Some(paid_at)) = (
                    str_of(&answer, "paymentId"),
                    str_of(&answer, "partnerId"),
                    str_of(&answer, "label"),
                    str_of(&answer, "amount"),
                    str_of(&answer, "paidAt"),
                ) else {
                    return Err(PaymentUnavailable);
                };
                let shaped = keys_are(
                    &answer,
                    &["ok", "paymentId", "partnerId", "label", "amount", "paidAt"],
                ) && payment_id_ok(payment_id)
                    && partner_id_ok(partner_id)
                    && label_ok(label)
                    && is_decimal(paid)
                    && service_kit::time::zod_datetime(paid_at, false).is_some();
                // The partner's answer must be for the amount asked; any other is not this window's payment.
                if !shaped || paid != asked {
                    return Err(PaymentUnavailable);
                }
                Ok(Collected::Paid {
                    payment_id: payment_id.to_owned(),
                    partner_id: partner_id.to_owned(),
                    label: label.to_owned(),
                })
            }
            _ => Err(PaymentUnavailable),
        }
    }
}

/// svc-identity's affiliate legs after a usage charge. Best effort: a failure never unwinds the charge.
pub trait Affiliates: Send + Sync {
    /// `POST /internal/affiliates/accrue` with the fee.
    fn accrue(
        &self,
        fee_event_id: &str,
        user_id: &str,
        fee: Amount,
        asset_id: &str,
    ) -> Result<(), String>;
    /// `POST /internal/affiliates/payout` with the fee event id.
    fn payout(&self, fee_event_id: &str) -> Result<(), String>;
}

/// `NoopAffiliateAccrue` and `NoopAffiliatePayout`: no `IDENTITY_URL`.
pub struct NoAffiliates;

impl Affiliates for NoAffiliates {
    fn accrue(&self, _: &str, _: &str, _: Amount, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn payout(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}

/// `AFFILIATE_PRODUCER_PATH` and `AFFILIATE_PRODUCER_PAYOUT_PATH`.
pub const ACCRUE_PATH: &str = "/internal/affiliates/accrue";
pub const PAYOUT_PATH: &str = "/internal/affiliates/payout";

/// `createAffiliateAccrueClient` and `createAffiliatePayoutClient`: signed as svc-agents for svc-identity, 2 s each; a
/// 412 (rates unset or unpublished, nothing accrued) is not a failure.
pub struct AffiliatesHttp {
    pub base_url: String,
    pub signer: CallSigner,
    pub fetch: Arc<dyn Fetch>,
}

impl AffiliatesHttp {
    pub fn new(identity_url: &str, signer: CallSigner, fetch: Arc<dyn Fetch>) -> AffiliatesHttp {
        AffiliatesHttp {
            base_url: identity_url.trim_end_matches('/').to_owned(),
            signer,
            fetch,
        }
    }

    fn post(&self, path: &str, body: &Json, what: &str) -> Result<(), String> {
        let body = body.compact();
        let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
        headers.extend(self.signer.sign(&body, "POST", path, "application/json")?);
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: format!("{}{path}", self.base_url),
                headers,
                body: Some(body),
                timeout_ms: Some(2_000),
                refuse_redirect: false,
            })
            .map_err(|e| e.message)?;
        if res.ok() || res.status == 412 {
            return Ok(());
        }
        Err(format!("affiliate {what} refused ({})", res.status))
    }
}

impl Affiliates for AffiliatesHttp {
    fn accrue(
        &self,
        fee_event_id: &str,
        user_id: &str,
        fee: Amount,
        asset_id: &str,
    ) -> Result<(), String> {
        self.post(
            ACCRUE_PATH,
            &Json::obj([
                ("feeEventId", Json::str(fee_event_id)),
                ("userId", Json::str(user_id)),
                ("feeAmount", Json::str(format_amount(fee))),
                ("asset", Json::str(asset_id)),
                ("sourceModule", Json::str("agents")),
            ]),
            "accrue",
        )
    }

    fn payout(&self, fee_event_id: &str) -> Result<(), String> {
        self.post(
            PAYOUT_PATH,
            &Json::obj([("feeEventId", Json::str(fee_event_id))]),
            "payout",
        )
    }
}

/// The event bus's publish side (`JetStreamEventBus.publish`).
pub trait Bus: Send + Sync {
    /// Publishes one envelope, deduplicated by `msg_id` (the event's idempotency key).
    fn publish(&self, subject: &str, msg_id: &str, envelope: &Json) -> Result<(), String>;
}

/// No bus: a publish fails, as `JetStreamEventBus` would with no connection.
pub struct NoBus;

impl Bus for NoBus {
    fn publish(&self, _: &str, _: &str, _: &Json) -> Result<(), String> {
        Err("svc-agents: no event bus is wired".to_owned())
    }
}

/// The bus over NATS JetStream, into the agents' own stream.
pub struct JetStreamBus(pub Arc<service_kit::nats::JetStream>);

impl Bus for JetStreamBus {
    fn publish(&self, subject: &str, msg_id: &str, envelope: &Json) -> Result<(), String> {
        self.0
            .publish(subject, msg_id, envelope.compact().as_bytes())
            .map(|_| ())
            .map_err(|e| e.0)
    }
}

/// An object from fields built up one by one, in their order.
fn obj(fields: Vec<(&str, Json)>) -> Json {
    Json::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}
