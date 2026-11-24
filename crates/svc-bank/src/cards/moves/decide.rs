//! The authorisation (`card-service.ts`: `authorize`, `redriveHold`, `commitHold`, `declineReason`, `quote`,
//! `recordTrace`, `recordDecision`, `approvedSpend`, `pinDecline`; `card-controls.ts`: `blockedBy`;
//! `programme/rules.ts` and `programme/decision-store.ts`: the promoted rules, the 3DS policy and the trace).
//!
//! IF THIS CRASHES EXACTLY HERE, WHOSE FUNDS ARE STRANDED? None. The decision and its frozen rate are one transaction
//! (`record_decision`); the hold is posted under `withdraw.hold:<authorisation id>` after it, so a process that dies
//! between them leaves an approved `pending` row with no hold, and a redelivery re-drives the stored amount under the
//! same key, never a second quote. A ledger that never spoke is not a decline: the row stays `pending`.

use postgres::GenericClient;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, js_trim, parse_amount};

use super::conversion::{self, Quote};
use super::partner_book;
use super::{Auth, Moves, custody_guard, held_by, post_refusal, read_by_ref, reread, tell_issuer};
use crate::cards::Card;
use crate::cards::issuer::PinVerdict;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::ports::LedgerAccount;
use crate::spaces::space::{in_tx, pg, with};

/// What the issuer asks (`authorize`'s input).
#[derive(Debug, Clone, Default)]
pub struct Ask {
    pub card_id: String,
    pub authorization_ref: String,
    /// The merchant's number, in the card's settlement asset.
    pub amount: Amount,
    pub merchant_category: Option<String>,
    pub merchant: Option<String>,
    pub merchant_country: Option<String>,
    /// Omitted is card-present.
    pub channel: Option<String>,
    pub pin: Option<String>,
    pub recurring: bool,
    /// `authenticated` or `failed`.
    pub three_ds: Option<String>,
}

/// One step of the decision's trace (`TraceStep`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub check: String,
    /// `pass`, `decline` or `skip`.
    pub result: &'static str,
    pub detail: String,
}

impl Step {
    fn json(&self) -> Json {
        Json::obj([
            ("check", Json::str(self.check.clone())),
            ("result", Json::str(self.result)),
            ("detail", Json::str(self.detail.clone())),
        ])
    }
}

/// `RuleParams`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuleParams {
    AmountAbove { asset_id: String, amount: String },
    MerchantCategory { category: String },
    Channel { channel: String },
}

const CHANNELS: [&str; 5] = ["card-present", "online", "contactless", "atm", "foreign"];

/// `^\d+(\.\d{1,18})?$`.
fn is_rule_decimal(s: &str) -> bool {
    let (whole, frac) = s.split_once('.').map_or((s, None), |(w, f)| (w, Some(f)));
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && frac.is_none_or(|f| (1..=18).contains(&f.len()) && f.bytes().all(|b| b.is_ascii_digit()))
}

/// `^[A-Z0-9]{2,16}$`.
fn is_rule_asset(s: &str) -> bool {
    (2..=16).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

fn strict_keys(v: &Json, keys: &[&str]) -> Option<()> {
    let Json::Object(f) = v else { return None };
    f.iter()
        .all(|(k, _)| keys.contains(&k.as_str()))
        .then_some(())
}

fn str_at<'v>(v: &'v Json, key: &str) -> Option<&'v str> {
    match v.get(key) {
        Some(Json::String(s)) => Some(s),
        _ => None,
    }
}

impl RuleParams {
    /// `ruleParamsSchema.safeParse`: a stored rule that does not parse is left out, never guessed.
    pub fn parse(v: &Json) -> Option<RuleParams> {
        match str_at(v, "kind")? {
            "amount_above" => {
                strict_keys(v, &["kind", "assetId", "amount"])?;
                let asset_id = str_at(v, "assetId").filter(|a| is_rule_asset(a))?;
                let amount = str_at(v, "amount").filter(|a| is_rule_decimal(a))?;
                Some(RuleParams::AmountAbove {
                    asset_id: asset_id.to_owned(),
                    amount: amount.to_owned(),
                })
            }
            "merchant_category" => {
                strict_keys(v, &["kind", "category"])?;
                let category = js_trim(str_at(v, "category")?);
                (1..=64)
                    .contains(&category.chars().count())
                    .then(|| RuleParams::MerchantCategory {
                        category: category.to_owned(),
                    })
            }
            "channel" => {
                strict_keys(v, &["kind", "channel"])?;
                let channel = str_at(v, "channel").filter(|c| CHANNELS.contains(c))?;
                Some(RuleParams::Channel {
                    channel: channel.to_owned(),
                })
            }
            _ => None,
        }
    }

    /// `ruleDeclines`.
    pub fn declines(
        &self,
        asset_id: &str,
        amount: Amount,
        channel: &str,
        category: Option<&str>,
    ) -> bool {
        match self {
            RuleParams::AmountAbove {
                asset_id: a,
                amount: limit,
            } => a == asset_id && parse_amount(limit).is_ok_and(|l| amount > l),
            RuleParams::MerchantCategory { category: c } => category == Some(c.as_str()),
            RuleParams::Channel { channel: c } => c == channel,
        }
    }

    /// `ruleWords`.
    pub fn words(&self) -> String {
        match self {
            RuleParams::AmountAbove { asset_id, amount } => {
                format!("declines a payment above {amount} {asset_id}")
            }
            RuleParams::MerchantCategory { category } => {
                format!("declines merchant category {category}")
            }
            RuleParams::Channel { channel } => format!("declines the {channel} channel"),
        }
    }
}

/// `ActiveRule`.
pub struct Rule {
    pub name: String,
    pub version: i64,
    pub params: RuleParams,
}

/// `ProgrammeDecisionStore.activeRules`.
pub fn active_rules(c: &mut impl GenericClient) -> Result<Vec<Rule>, Refusal> {
    let rows = c
        .query(
            "SELECT name, version::int8, params::text FROM bank.card_programme_rules \
              WHERE state = 'active' ORDER BY promoted_at, id",
            &[],
        )
        .map_err(|e| pg(&e))?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let params = json::parse(&r.get::<_, String>(2)).ok()?;
            Some(Rule {
                name: r.get(0),
                version: r.get(1),
                params: RuleParams::parse(&params)?,
            })
        })
        .collect())
}

/// `ThreeDsPolicy`.
pub struct ThreeDsPolicy {
    /// `challenge_all` or `frictionless`.
    pub mode: String,
    /// The low-value exemption's asset and limit, as written.
    pub exemption: Option<(String, String)>,
}

fn parse_policy(v: &Json) -> Option<ThreeDsPolicy> {
    strict_keys(v, &["mode", "lowValueExemption"])?;
    let mode = str_at(v, "mode").filter(|m| *m == "challenge_all" || *m == "frictionless")?;
    let exemption = match v.get("lowValueExemption")? {
        Json::Null => None,
        e => {
            strict_keys(e, &["assetId", "limit"])?;
            let asset = str_at(e, "assetId").filter(|a| is_rule_asset(a))?;
            let limit = str_at(e, "limit").filter(|l| is_rule_decimal(l))?;
            Some((asset.to_owned(), limit.to_owned()))
        }
    };
    Some(ThreeDsPolicy {
        mode: mode.to_owned(),
        exemption,
    })
}

/// `ProgrammeDecisionStore.threeDsPolicy`: an unreadable policy reads as no policy.
pub fn three_ds_policy(c: &mut impl GenericClient) -> Result<Option<ThreeDsPolicy>, Refusal> {
    let rows = c
        .query(
            "SELECT value::text FROM bank.card_programme_settings WHERE key = 'threeds'",
            &[],
        )
        .map_err(|e| pg(&e))?;
    Ok(rows
        .first()
        .and_then(|r| json::parse(&r.get::<_, String>(0)).ok())
        .and_then(|v| parse_policy(&v)))
}

/// `threeDsDecision`: the step, and the decline when one is due.
fn three_ds_decision(
    policy: Option<&ThreeDsPolicy>,
    channel: &str,
    asset_id: &str,
    amount: Amount,
    result: Option<&str>,
) -> Option<(Step, Option<&'static str>)> {
    if channel != "online" {
        return None;
    }
    let step = |result, detail: String| Step {
        check: "3DS policy".to_owned(),
        result,
        detail,
    };
    let Some(policy) = policy else {
        return Some((
            step(
                "skip",
                "No 3DS policy is set, so this app asked no challenge.".to_owned(),
            ),
            None,
        ));
    };
    let shown = format_amount(amount);
    if let Some((asset, limit)) = &policy.exemption
        && asset == asset_id
        && parse_amount(limit).is_ok_and(|l| amount <= l)
    {
        return Some((
            step(
                "skip",
                format!(
                    "SCA low-value exemption: {shown} {asset_id} is under the exemption limit of {limit} {asset}, so the challenge was skipped."
                ),
            ),
            None,
        ));
    }
    if policy.mode == "frictionless" {
        return Some((
            step(
                "pass",
                "The 3DS policy is frictionless: no challenge is asked.".to_owned(),
            ),
            None,
        ));
    }
    let why = policy.exemption.as_ref().map_or_else(
        || "no exemption is set".to_owned(),
        |(asset, limit)| {
            format!("{shown} {asset_id} is not under the exemption limit of {limit} {asset}")
        },
    );
    if result == Some("authenticated") {
        return Some((
            step(
                "pass",
                format!("Challenge required ({why}); the cardholder passed it."),
            ),
            None,
        ));
    }
    let passed = if result == Some("failed") {
        "the cardholder failed it"
    } else {
        "none was passed"
    };
    Some((
        step("decline", format!("Challenge required ({why}); {passed}.")),
        Some("bank.card_3ds_required"),
    ))
}

/// `recordTrace`: written once beside the decision; a write that fails never undoes it, and is only logged.
fn record_trace(m: &Moves<'_>, authorization_id: &str, steps: &[Step]) {
    let body = Json::Array(steps.iter().map(Step::json).collect()).compact();
    let written = with(m.store(), |c| {
        c.execute(
            "INSERT INTO bank.card_authorization_traces (authorization_id, steps) \
             VALUES ($1::text::uuid, $2::text::jsonb) ON CONFLICT (authorization_id) DO NOTHING",
            &[&authorization_id, &body],
        )
        .map_err(|e| pg(&e))
    });
    if written.is_err() {
        eprintln!(
            "{}",
            Json::obj([
                ("level", Json::str("error")),
                ("service", Json::str("svc-bank")),
                ("event", Json::str("bank.card_trace_unrecorded")),
                ("authorizationId", Json::str(authorization_id)),
                ("reason", Json::str("Error")),
            ])
            .compact()
        );
    }
}

/// `channelOpen`.
fn channel_open(card: &Card, channel: &str) -> bool {
    match channel {
        "online" => card.online,
        "contactless" => card.contactless,
        "atm" => card.atm,
        "foreign" => card.abroad,
        _ => true,
    }
}

/// `blockedBy`: the person's own blocks, read now.
fn blocked_by(
    c: &mut impl GenericClient,
    card_id: &str,
    ask: &Ask,
) -> Result<Option<&'static str>, Refusal> {
    let controls: Vec<(String, String)> = c
        .query(
            "SELECT kind, value FROM bank.card_controls WHERE card_id = $1::text::uuid AND lifted_at IS NULL \
              ORDER BY created_at, id",
            &[&card_id],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    let live = |kind: &str, value: Option<String>| {
        value.is_some_and(|v| {
            !js_trim(&v).is_empty() && controls.iter().any(|(k, x)| k == kind && *x == v)
        })
    };
    let trimmed = |v: &Option<String>| v.as_deref().map(|s| js_trim(s).to_owned());
    if live("category", trimmed(&ask.merchant_category)) {
        return Ok(Some("bank.card_category_blocked"));
    }
    if live("merchant", trimmed(&ask.merchant).map(|s| s.to_lowercase())) {
        return Ok(Some("bank.card_merchant_blocked"));
    }
    if live(
        "country",
        trimmed(&ask.merchant_country).map(|s| s.to_uppercase()),
    ) {
        return Ok(Some("bank.card_country_blocked"));
    }
    Ok(None)
}

/// `approvedSpend` since the start of the UTC `unit` (`day` or `month`) now; a pay-from payment counts at the merchant's
/// amount.
fn approved_spend(
    m: &Moves<'_>,
    card_id: &str,
    unit: &str,
    channel: Option<&str>,
) -> Result<Amount, Refusal> {
    let now_ms = m.now().0;
    let total: String = with(m.store(), |c| {
        Ok(c.query_one(
            "SELECT COALESCE(SUM(COALESCE( \
                    (SELECT c.settlement_amount FROM bank.card_conversions c \
                      WHERE c.authorization_id = a.id AND c.rate_quality = 'partner'), \
                    a.amount)), 0)::text \
               FROM bank.card_authorizations a \
              WHERE card_id = $1::text::uuid AND decision = 'approved' AND status <> 'rejected' \
                AND decided_at >= (date_trunc($2, to_timestamp($3::int8 / 1000.0) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') \
                AND ($4::text IS NULL OR channel = $4)",
            &[&card_id, &unit, &now_ms, &channel],
        )
        .map_err(|e| pg(&e))?
        .get(0))
    })?;
    parse_amount(&total).map_err(Refusal::Other)
}

/// `pinDecline`: a PIN typed at a terminal, checked by the issuer against the owner's try limit; `None` is a right PIN.
fn pin_decline(
    m: &Moves<'_>,
    card: &Card,
    pin: &str,
    authorization_ref: &str,
) -> Option<&'static str> {
    let Some(limit) = m.d.settings().pin_try_limit else {
        return Some("bank.card_pin_try_limit_unset");
    };
    if !crate::cards::secrets::live_secret_programme(m.d) {
        return Some("bank.card_pin_issuer_unset");
    }
    match m
        .d
        .issuer()
        .verify_pin(&card.id, authorization_ref, pin, limit)
    {
        None => Some("bank.card_pin_issuer_unset"),
        Some(PinVerdict::Ok) => None,
        Some(PinVerdict::Unset) => Some("bank.card_pin_not_set"),
        Some(PinVerdict::Blocked) => Some("bank.card_pin_blocked"),
        Some(PinVerdict::Wrong) => Some("bank.card_pin_wrong"),
    }
}

/// What the partner says before anything is decided.
enum PartnerFunds {
    /// Not a partner-held person.
    None,
    /// `partner-decides`: a pay-from order, which the partner walks.
    Decides,
    Available(Amount),
}

/// `declineReason`: named declines only, each a step of the trace.
#[allow(
    clippy::too_many_lines,
    reason = "one check after another, in the TypeScript's order"
)]
fn decline_reason(
    m: &Moves<'_>,
    card: &Card,
    funding: Amount,
    channel: &str,
    ask: &Ask,
    partner: &PartnerFunds,
    trace: &mut Vec<Step>,
) -> Result<Option<&'static str>, Refusal> {
    fn step(
        trace: &mut Vec<Step>,
        check: &str,
        code: Option<&'static str>,
        passed: String,
    ) -> Option<&'static str> {
        trace.push(match code {
            Some(c) => Step {
                check: check.to_owned(),
                result: "decline",
                detail: format!("Declined: {c}."),
            },
            None => Step {
                check: check.to_owned(),
                result: "pass",
                detail: passed,
            },
        });
        code
    }
    let amount = format!("{} {}", format_amount(funding), card.asset_id);
    let inactive = (card.status != "active" || card.inactive()).then_some("bank.card_not_active");
    if let Some(c) = step(
        trace,
        "Card status",
        inactive,
        "The card is active.".to_owned(),
    ) {
        return Ok(Some(c));
    }
    let blocked = with(m.store(), |c| blocked_by(c, &card.id, ask))?;
    if let Some(c) = step(
        trace,
        "Cardholder\u{2019}s own controls",
        blocked,
        "No category, merchant or country the cardholder blocked.".to_owned(),
    ) {
        return Ok(Some(c));
    }
    let rules = with(m.store(), active_rules)?;
    if let Some(hit) = rules.iter().find(|r| {
        r.params.declines(
            &card.asset_id,
            funding,
            channel,
            ask.merchant_category.as_deref(),
        )
    }) {
        trace.push(Step {
            check: "Programme rules".to_owned(),
            result: "decline",
            detail: format!(
                "Declined by rule \u{201c}{}\u{201d} version {}: it {}.",
                hit.name,
                hit.version,
                hit.params.words()
            ),
        });
        return Ok(Some("bank.card_rule_declined"));
    }
    trace.push(Step {
        check: "Programme rules".to_owned(),
        result: "pass",
        detail: if rules.is_empty() {
            "No programme rule is promoted.".to_owned()
        } else {
            format!("None of {} promoted rules declines it.", rules.len())
        },
    });
    if let Some(pin) = &ask.pin {
        let declined = pin_decline(m, card, pin, &ask.authorization_ref);
        if let Some(c) = step(trace, "PIN", declined, "The PIN matched.".to_owned()) {
            return Ok(Some(c));
        }
    }
    let limit = format!(
        "{} {}",
        format_amount(card.per_authorization_limit),
        card.asset_id
    );
    if let Some(c) = step(
        trace,
        "Per-payment limit",
        (funding > card.per_authorization_limit).then_some("bank.card_limit_exceeded"),
        format!("{amount} is within the card\u{2019}s limit of {limit}."),
    ) {
        return Ok(Some(c));
    }
    if let Some(c) = step(
        trace,
        "Channel",
        (!channel_open(card, channel)).then_some("bank.card_channel_off"),
        format!("The {channel} channel is on for this card."),
    ) {
        return Ok(Some(c));
    }
    let policy = with(m.store(), three_ds_policy)?;
    if let Some((s, decline)) = three_ds_decision(
        policy.as_ref(),
        channel,
        &card.asset_id,
        funding,
        ask.three_ds.as_deref(),
    ) {
        trace.push(s);
        if let Some(d) = decline {
            return Ok(Some(d));
        }
    }
    if let Some(limit) = card.daily_limit {
        let spent = approved_spend(m, &card.id, "day", None)?;
        if let Some(c) = step(
            trace,
            "Daily limit",
            (spent + funding > limit).then_some("bank.card_daily_limit_exceeded"),
            "Within the daily limit.".to_owned(),
        ) {
            return Ok(Some(c));
        }
    }
    if let Some(limit) = card.monthly_limit {
        let spent = approved_spend(m, &card.id, "month", None)?;
        if let Some(c) = step(
            trace,
            "Monthly limit",
            (spent + funding > limit).then_some("bank.card_monthly_limit_exceeded"),
            "Within the monthly limit.".to_owned(),
        ) {
            return Ok(Some(c));
        }
    }
    if channel == "atm"
        && let Some(limit) = card.cash_limit
    {
        let spent = approved_spend(m, &card.id, "day", Some("atm"))?;
        if let Some(c) = step(
            trace,
            "Cash limit",
            (spent + funding > limit).then_some("bank.card_cash_limit_exceeded"),
            "Within the daily cash limit.".to_owned(),
        ) {
            return Ok(Some(c));
        }
    }
    match partner {
        PartnerFunds::Decides => {
            trace.push(Step {
                check: "Funds at the card partner".to_owned(),
                result: "pass",
                detail: "The card partner holds from the first asset in the pay-from order that covers the payment, or declines."
                    .to_owned(),
            });
            Ok(None)
        }
        PartnerFunds::Available(available) => Ok(step(
            trace,
            "Funds at the card partner",
            (*available < funding).then_some("bank.card_partner_insufficient_funds"),
            format!(
                "The partner reports {} {} available, enough for {amount}.",
                format_amount(*available),
                card.asset_id
            ),
        )),
        PartnerFunds::None => {
            let balance =
                m.d.t
                    .ledger
                    .balance(&LedgerAccount::user_available(
                        &card.user_id,
                        &card.asset_id,
                    ))
                    .map_err(Refusal::Other)?;
            Ok(step(
                trace,
                "Available balance",
                (balance < funding).then_some("ledger.insufficient_funds"),
                format!("The available balance covers {amount}."),
            ))
        }
    }
}

/// `quote`: a same-asset card quotes nothing and never touches the rate source.
fn quote(m: &Moves<'_>, card: &Card, settlement_amount: Amount) -> Result<Option<Quote>, Refusal> {
    if card.settlement_asset_id == card.asset_id {
        return Ok(None);
    }
    let previous = with(m.store(), |c| conversion::last_accepted_rate(c, &card.id))?;
    conversion::quote(
        m.d.rates,
        &card.asset_id,
        &card.settlement_asset_id,
        settlement_amount,
        previous,
        m.now(),
        &conversion::default_policy(),
    )
    .map(Some)
}

/// What `record_decision` writes.
struct Decision<'a> {
    card: &'a Card,
    ask: &'a Ask,
    channel: &'a str,
    funding: Amount,
    quote: Option<&'a Quote>,
    decision: &'static str,
    decline_code: Option<&'static str>,
    held_by: &'static str,
    pay_from_order: Option<&'a [String]>,
}

/// `recordDecision`: the decision and the rate it was taken at, in one transaction. Two deliveries race on
/// `unique(card_id, authorization_ref)`; the loser writes no conversion and reads the winner's decision.
fn record_decision(m: &Moves<'_>, x: &Decision<'_>) -> Result<Auth, Refusal> {
    let order: Option<Vec<String>> = x
        .pay_from_order
        .filter(|o| !o.is_empty())
        .map(<[String]>::to_vec);
    let merchant = x
        .ask
        .merchant
        .as_deref()
        .map(js_trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let country = x
        .ask
        .merchant_country
        .as_deref()
        .map(|s| js_trim(s).to_uppercase())
        .filter(|s| !s.is_empty());
    let funding = format_amount(x.funding);
    in_tx(m.store(), |tx| {
        let mut decision = x.decision;
        let mut decline_code = x.decline_code;
        if decision == "approved"
            && let Some(allowed) = x.card.uses_allowed
        {
            tx.execute(
                "SELECT id FROM bank.cards WHERE id = $1::text::uuid FOR UPDATE",
                &[&x.card.id],
            )
            .map_err(|e| pg(&e))?;
            let used: i64 = tx
                .query_one(
                    "SELECT count(*)::int8 FROM bank.card_authorizations a \
                      WHERE a.card_id = $1::text::uuid AND a.decision = 'approved' \
                        AND NOT EXISTS (SELECT 1 FROM bank.card_settlements s \
                             WHERE s.authorization_id = a.id AND s.sequence = 0 AND s.kind = 'reversal' AND s.status = 'settled')",
                    &[&x.card.id],
                )
                .map_err(|e| pg(&e))?
                .get(0);
            if used >= allowed {
                decision = "declined";
                decline_code = Some("bank.card_use_limit_reached");
            }
        }
        let status = if decision == "approved" {
            "pending"
        } else {
            "rejected"
        };
        let claimed = tx
            .query(
                "INSERT INTO bank.card_authorizations (card_id, authorization_ref, amount, merchant_category, merchant, \
                   merchant_country, channel, recurring, decision, decline_code, status, money_book, pay_from_order) \
                 VALUES ($1::text::uuid, $2, $3::text::numeric, $4, $5, $6, $7, $8, $9::text::bank.card_decision, $10, \
                   $11::text::bank.loan_event_status, $12, $13::text[]) \
                 ON CONFLICT (card_id, authorization_ref) DO NOTHING RETURNING id::text",
                &[
                    &x.card.id,
                    &x.ask.authorization_ref,
                    &funding,
                    &x.ask.merchant_category,
                    &merchant,
                    &country,
                    &x.channel,
                    &x.ask.recurring,
                    &decision,
                    &decline_code,
                    &status,
                    &x.held_by,
                    &order,
                ],
            )
            .map_err(|e| pg(&e))?;
        let (Some(row), Some(q)) = (claimed.first(), x.quote) else {
            return Ok(());
        };
        let id: String = row.get(0);
        let as_of = q.rate_as_of.0;
        tx.execute(
            "INSERT INTO bank.card_conversions (authorization_id, settlement_asset_id, settlement_amount, \
               funding_asset_id, funding_amount, rate, rate_quality, rate_as_of) \
             VALUES ($1::text::uuid, $2, $3::text::numeric, $4, $5::text::numeric, $6::text::numeric, $7, \
               to_timestamp($8::int8 / 1000.0))",
            &[
                &id,
                &q.settlement_asset_id,
                &format_amount(q.settlement_amount),
                &q.funding_asset_id,
                &format_amount(q.funding_amount),
                &format_amount(q.rate),
                &q.quality,
                &as_of,
            ],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })?;
    reread(m, x.card, &x.ask.authorization_ref)
}

/// The hold for an approved row that never received one: no quote, the stored amount, the same key.
fn redrive_hold(m: &Moves<'_>, card: &Card, already: &Auth) -> Result<Auth, Refusal> {
    let merchant = already
        .conversion
        .as_ref()
        .map_or(already.amount, |c| c.settlement_amount);
    commit_hold(m, card, already, merchant)
}

/// Mark the claimed row declined (`status = 'rejected'`), tell the issuer, and read it back.
pub(super) fn decline_claimed(
    m: &Moves<'_>,
    card: &Card,
    claimed: &Auth,
    reason: &str,
    only_pending: bool,
) -> Result<Auth, Refusal> {
    with(m.store(), |c| {
        c.execute(
            &format!(
                "UPDATE bank.card_authorizations SET decision = 'declined', decline_code = $2, status = 'rejected' \
                  WHERE id = $1::text::uuid{}",
                if only_pending { " AND status = 'pending'" } else { "" }
            ),
            &[&claimed.id, &reason],
        )
        .map_err(|e| pg(&e))
    })?;
    let declined = reread(m, card, &claimed.authorization_ref)?;
    tell_issuer(m);
    Ok(declined)
}

/// `commitHold`: post the hold for the claimed row's amount (never this call's quote), then write the row. The ledger's
/// no is a decline; anything else leaves the row `pending` for a redelivery.
fn commit_hold(
    m: &Moves<'_>,
    card: &Card,
    claimed: &Auth,
    merchant: Amount,
) -> Result<Auth, Refusal> {
    if claimed.held_by == "partner" {
        return super::partner::commit_partner_hold(m, card, claimed, merchant);
    }
    custody_guard(m)?;
    let input = Json::obj([
        ("userId", Json::str(card.user_id.clone())),
        ("assetId", Json::str(card.asset_id.clone())),
        ("amount", Json::str(format_amount(claimed.amount))),
        ("rail", Json::str(card.issuer.clone())),
        ("withdrawalId", Json::str(claimed.id.clone())),
    ]);
    match m.d.t.ledger.post_recipe(
        "withdrawHold",
        &input,
        &format!("withdraw.hold:{}", claimed.id),
    ) {
        Ok(tx) => {
            with(m.store(), |c| {
                c.execute(
                    "UPDATE bank.card_authorizations SET status = 'settled', hold_ledger_tx_id = $2, settled_at = now() \
                      WHERE id = $1::text::uuid",
                    &[&claimed.id, &tx.id],
                )
                .map_err(|e| pg(&e))
            })?;
        }
        Err(f) if f.insufficient() => {
            return decline_claimed(m, card, claimed, "ledger.insufficient_funds", false);
        }
        Err(f) => return Err(post_refusal(&f)),
    }
    let approved = reread(m, card, &claimed.authorization_ref)?;
    tell_issuer(m);
    Ok(approved)
}

/// `authorize`: the issuer asks; the answer is a decision recorded once, and on an approval the amount held.
pub fn authorize(m: &Moves<'_>, ask: &Ask) -> Result<Auth, Refusal> {
    m.d.assert_module_enabled()?;
    m.d.assert_issuer_may_mutate()?;
    let card = crate::cards::read_card(m.d, &ask.card_id)?;
    // Idempotency first: a finished row returns before the rate source is touched. An approved row still pending with
    // no hold is not a decision delivered: its hold is re-driven at the stored amount.
    if let Some(already) = read_by_ref(m, &card.id, &ask.authorization_ref)? {
        let stranded = already.decision == "approved"
            && already.status == "pending"
            && if already.held_by == "partner" {
                already.partner_hold_ref.is_none()
            } else {
                already.hold_ledger_tx_id.is_none()
            };
        if !stranded {
            return Ok(already);
        }
        return redrive_hold(m, &card, &already);
    }
    let held_by = held_by(m, &card.user_id);
    if held_by == "none" {
        return Err(refuse(
            "bank.partner_unset",
            "No partner is set to hold this money, and INTAFACED holds no customer money (the custodial layer is off). Nothing was sent or changed.",
        ));
    }
    let pay_from_order = if held_by == "partner" {
        super::partner::pay_from_order_for(m, &card)?
    } else {
        None
    };
    let partner = if held_by != "partner" {
        PartnerFunds::None
    } else if pay_from_order.is_some() {
        PartnerFunds::Decides
    } else {
        PartnerFunds::Available(super::partner::partner_available(m, &card)?)
    };
    let quote = if pay_from_order.is_some() {
        None
    } else {
        quote(m, &card, ask.amount)?
    };
    let funding = quote.as_ref().map_or(ask.amount, |q| q.funding_amount);
    let mut decided = card.clone();
    if pay_from_order.is_some() {
        decided.asset_id = card.settlement_asset_id.clone();
    }
    let channel = ask
        .channel
        .clone()
        .unwrap_or_else(|| "card-present".to_owned());
    let mut trace = Vec::new();
    let decline = decline_reason(m, &decided, funding, &channel, ask, &partner, &mut trace)?;
    let traced = |row: Auth, last: Option<Step>, trace: &mut Vec<Step>| {
        trace.extend(last);
        record_trace(m, &row.id, trace);
        row
    };
    let x = |decision, decline_code| Decision {
        card: &card,
        ask,
        channel: &channel,
        funding,
        quote: quote.as_ref(),
        decision,
        decline_code,
        held_by,
        pay_from_order: pay_from_order.as_deref(),
    };
    if let Some(code) = decline {
        let declined = record_decision(m, &x("declined", Some(code)))?;
        tell_issuer(m);
        return Ok(traced(declined, None, &mut trace));
    }
    let claimed = record_decision(m, &x("approved", None))?;
    if claimed.decision == "declined" {
        let code = claimed.decline_code.clone().unwrap_or_default();
        if code == "bank.card_use_limit_reached" {
            tell_issuer(m);
        }
        let last = Step {
            check: "Card use limit".to_owned(),
            result: "decline",
            detail: format!("Declined: {code}."),
        };
        return Ok(traced(claimed, Some(last), &mut trace));
    }
    let finished = commit_hold(m, &card, &claimed, ask.amount)?;
    if finished.decision == "declined" {
        let last = Step {
            check: "Hold".to_owned(),
            result: "decline",
            detail: format!(
                "The hold was refused: {}.",
                finished.decline_code.clone().unwrap_or_default()
            ),
        };
        return Ok(traced(finished, Some(last), &mut trace));
    }
    let detail = if finished.held_by == "partner" {
        "Approved: the card partner holds the amount."
    } else {
        "Approved: the amount is held."
    };
    let last = Step {
        check: "Hold".to_owned(),
        result: "pass",
        detail: detail.to_owned(),
    };
    Ok(traced(finished, Some(last), &mut trace))
}

/// The partner card instruction's guard refusals that mean the partner was never asked (`PARTNER_NOT_ASKED`).
pub(super) const PARTNER_NOT_ASKED: [&str; 3] = [
    "bank.posting_frozen",
    "bank.partner_stopped",
    "bank.partner_stop_unreadable",
];

/// Whether a partner instruction's error is a guard's before the partner was asked.
pub(super) fn not_asked(e: &partner_book::PartnerErr) -> bool {
    matches!(e, partner_book::PartnerErr::Other(r) if super::code_of(r).is_some_and(|c| PARTNER_NOT_ASKED.contains(&c)))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn a_rule_is_read_strictly_and_one_that_does_not_parse_is_left_out() {
        let p = |s: &str| RuleParams::parse(&json::parse(s).unwrap());
        assert_eq!(
            p(r#"{"kind":"amount_above","assetId":"USDT","amount":"50"}"#),
            Some(RuleParams::AmountAbove {
                asset_id: "USDT".to_owned(),
                amount: "50".to_owned()
            })
        );
        assert_eq!(
            p(r#"{"kind":"amount_above","assetId":"usdt","amount":"50"}"#),
            None
        );
        assert_eq!(
            p(r#"{"kind":"amount_above","assetId":"USDT","amount":"5e1"}"#),
            None
        );
        assert_eq!(
            p(r#"{"kind":"channel","channel":"online","extra":1}"#),
            None
        );
        assert_eq!(p(r#"{"kind":"merchant_category","category":"  "}"#), None);
        assert!(
            p(r#"{"kind":"channel","channel":"atm"}"#)
                .unwrap()
                .declines("USDT", Amount::from_scaled(1), "atm", None)
        );
    }

    #[test]
    fn the_3ds_policy_asks_online_payments_only_and_exempts_low_values_in_its_asset() {
        let policy = ThreeDsPolicy {
            mode: "challenge_all".to_owned(),
            exemption: Some(("USDT".to_owned(), "30".to_owned())),
        };
        assert!(
            three_ds_decision(
                Some(&policy),
                "card-present",
                "USDT",
                Amount::from_scaled(1),
                None
            )
            .is_none()
        );
        let low = three_ds_decision(
            Some(&policy),
            "online",
            "USDT",
            parse_amount("30").unwrap(),
            None,
        )
        .unwrap();
        assert_eq!((low.0.result, low.1), ("skip", None));
        let high = three_ds_decision(
            Some(&policy),
            "online",
            "USDT",
            parse_amount("31").unwrap(),
            None,
        )
        .unwrap();
        assert_eq!(high.1, Some("bank.card_3ds_required"));
        assert_eq!(
            high.0.detail,
            "Challenge required (31 USDT is not under the exemption limit of 30 USDT); none was passed."
        );
        let passed = three_ds_decision(
            Some(&policy),
            "online",
            "USDT",
            parse_amount("31").unwrap(),
            Some("authenticated"),
        )
        .unwrap();
        assert_eq!((passed.0.result, passed.1), ("pass", None));
        assert_eq!(
            three_ds_decision(None, "online", "USDT", Amount::from_scaled(1), None)
                .unwrap()
                .0
                .result,
            "skip"
        );
    }
}
