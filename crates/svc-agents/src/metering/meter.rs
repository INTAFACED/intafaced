//! The meter (`services/svc-agents/src/metering/meter.ts`, `UsageMeter`): exact per-session usage in `usage_records`
//! and `usage_windows`, and each window billed once.
//!
//! Exact: `usage_records` holds integer token counts and the rate in force, never a cost; a window's cost is computed
//! once, at its seal, by [`crate::metering::pricing::window_cost`].
//!
//! Idempotent, in three layers: a retried completion carries the same request id and its insert is discarded (unique
//! `(session_id, request_id)`); settlement seals the window in its own transaction before anything leaves the process,
//! so its amount is frozen (the migration's trigger refuses usage into a sealed window); and the charge goes to the
//! ledger under the window's business key (`agent.usage:<session>:<window>`), so a resumed settle posts nothing twice.
//! Seal, then post, then record the transaction id: a crash anywhere after the seal resumes to the same amount.

use postgres::{GenericClient, IsolationLevel};

use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::pg::Pool;
use service_kit::time::Instant;

use crate::db::{self, StoreError};
use crate::errors::{AgentError, Refusal};
use crate::metering::Metering;
use crate::metering::ports::{Collected, HeldBy, LedgerError, Recipe};
use crate::metering::pricing::{self, ModelPrice, UsageGroup, charge_key_for};

/// What metering can fail with, kept apart until a caller decides how to answer it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MeterError {
    /// A domain refusal (`AgentError`): the window sealed or not found, or owed and not collected.
    Agent(AgentError),
    Store(StoreError),
    /// A post the ledger did not take (`InsufficientFundsError`, a posting freeze, the ledger down).
    Ledger(LedgerError),
    /// `UsagePaymentUnavailable`: how the person pays could not be read.
    PaymentUnavailable,
    /// `PricingError`.
    Pricing(String),
}

impl From<StoreError> for MeterError {
    fn from(e: StoreError) -> MeterError {
        MeterError::Store(e)
    }
}

impl From<postgres::Error> for MeterError {
    fn from(e: postgres::Error) -> MeterError {
        MeterError::Store(StoreError::from(e))
    }
}

impl From<pricing::PricingError> for MeterError {
    fn from(e: pricing::PricingError) -> MeterError {
        MeterError::Pricing(e.0)
    }
}

/// How the router's guard answers it: a domain refusal by its code, anything else as the engine's outage.
impl From<MeterError> for Refusal {
    fn from(e: MeterError) -> Refusal {
        match e {
            MeterError::Agent(a) => Refusal::Agent(a),
            MeterError::Store(s) => Refusal::Other(s.to_string()),
            MeterError::Ledger(l) => Refusal::Other(l.message),
            MeterError::PaymentUnavailable => {
                Refusal::Other("How this person pays could not be read from svc-bank".to_owned())
            }
            MeterError::Pricing(p) => Refusal::Other(p),
        }
    }
}

fn agent(code: &str, key: &str, message: String) -> MeterError {
    // Every code here is one `errors.ts` declares; `AgentError::new` refuses any other.
    AgentError::new(code, key, message.clone())
        .map_or(MeterError::Pricing(message), MeterError::Agent)
}

/// `UsageOwedError`: the window is earned as owed and was not collected.
pub fn owed(reason: &str) -> MeterError {
    agent(
        "agents.window_unpaid",
        "agents.error.window_unpaid",
        format!("A usage window is owed and was not collected: {reason}"),
    )
}

/// One call's usage (`RecordUsageInput`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageInput<'a> {
    pub session_id: &'a str,
    pub request_id: &'a str,
    pub task: &'a str,
    pub provider_id: &'a str,
    pub model: &'a str,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub price: ModelPrice,
    pub at: Instant,
}

/// `RecordedUsage`: `recorded` is false when this request was already metered (a retry).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recorded {
    pub window_id: String,
    pub recorded: bool,
}

/// `SettlementResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settlement {
    pub session_id: String,
    pub window_id: String,
    pub charge_key: String,
    pub amount: Amount,
    /// None when nothing was billable, or the post is still owed.
    pub charge_tx_id: Option<String>,
    /// False when the window was already settled: the retry path.
    pub settled: bool,
}

/// `UsageWindowView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowView {
    pub session_id: String,
    pub window_id: String,
    /// `open`, `unpaid` or `settled`.
    pub state: &'static str,
    /// None while open: the amount is fixed only at the seal.
    pub amount: Option<Amount>,
    pub asset_id: String,
    pub charge_key: Option<String>,
    /// `opened_at`, as Postgres writes it in UTC ISO form.
    pub opened_at: String,
}

/// `UsageDayView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DayView {
    pub agent_id: String,
    pub day: String,
    pub task: String,
    pub amount: Amount,
    pub windows: i32,
    pub asset_id: String,
}

/// A settled window with nothing to bill carries this as its charge id.
const NO_CHARGE: &str = "none";

/// `unpaidWindow(sql)`: sealed, its amount fixed and positive, and the ledger has not taken it. The one definition the
/// retry, the Usage page and session settlement share.
pub const UNPAID: &str =
    "(w.sealed_at IS NOT NULL AND w.charge_tx_id IS NULL AND w.charged_amount > 0)";

fn amount_of(text: &str) -> Result<Amount, MeterError> {
    parse_amount(text).map_err(MeterError::Pricing)
}

fn groups_of(rows: &[postgres::Row]) -> Result<Vec<UsageGroup>, MeterError> {
    rows.iter()
        .map(|r| {
            let count = |i: usize| -> Result<i128, MeterError> {
                // `BigInt(r.input_tokens ?? '0')`: SUM of a bigint column, an integer.
                let t: Option<String> = r.try_get(i)?;
                t.map_or(Ok(0), |t| {
                    t.parse::<i128>()
                        .map_err(|e| MeterError::Pricing(e.to_string()))
                })
            };
            let price = |i: usize| -> Result<Amount, MeterError> {
                let t: String = r.try_get(i)?;
                amount_of(&t)
            };
            Ok(UsageGroup {
                input_tokens: count(0)?,
                output_tokens: count(1)?,
                price: ModelPrice {
                    input_per_million: price(2)?,
                    output_per_million: price(3)?,
                },
            })
        })
        .collect()
}

/// `windowFor(at)`.
pub fn window_for(m: &Metering, at: Instant) -> Result<String, MeterError> {
    Ok(pricing::window_id_for(at, m.window_minutes)?)
}

/// `record(tx, input)`: inside the caller's transaction, so the usage commits with the audit row of the same call.
/// Usage into a sealed window is refused `agents.window_sealed` (the migration's trigger, SQLSTATE 23001).
pub fn record(
    m: &Metering,
    tx: &mut impl GenericClient,
    input: &UsageInput<'_>,
) -> Result<Recorded, MeterError> {
    let window_id = window_for(m, input.at)?;
    tx.execute(
        "INSERT INTO agents.usage_windows (session_id, window_id) VALUES ($1::text::uuid, $2::text)
         ON CONFLICT (session_id, window_id) DO NOTHING",
        &[&input.session_id, &window_id],
    )?;
    let inserted = tx.query(
        "INSERT INTO agents.usage_records (
           session_id, window_id, request_id, task, provider_id, model,
           input_tokens, output_tokens, input_price_per_million, output_price_per_million, recorded_at
         ) VALUES (
           $1::text::uuid, $2::text, $3::text, $4::text, $5::text, $6::text,
           $7::text::bigint, $8::text::bigint, $9::text::numeric, $10::text::numeric, $11::text::timestamptz
         )
         ON CONFLICT (session_id, request_id) DO NOTHING
         RETURNING id",
        &[
            &input.session_id,
            &window_id,
            &input.request_id,
            &input.task,
            &input.provider_id,
            &input.model,
            &input.input_tokens.to_string(),
            &input.output_tokens.to_string(),
            &format_amount(input.price.input_per_million),
            &format_amount(input.price.output_per_million),
            &input.at.iso(),
        ],
    );
    match inserted {
        Ok(rows) => Ok(Recorded {
            window_id,
            recorded: !rows.is_empty(),
        }),
        Err(e) if e.code().is_some_and(|c| c.code() == "23001") => Err(agent(
            "agents.window_sealed",
            "agents.error.window_sealed",
            format!(
                "Usage window {window_id} for session {} is already settled",
                input.session_id
            ),
        )),
        Err(e) => Err(e.into()),
    }
}

/// `claimRequest`: the unique insert is the claim on `(session, request id)` before the provider is called.
pub fn claim_request(pool: &Pool, session_id: &str, request_id: &str) -> Result<bool, MeterError> {
    Ok(db::with_client(pool, |c| {
        Ok(!c.query(
            "INSERT INTO agents.think_claims (session_id, request_id) VALUES ($1::text::uuid, $2::text)
             ON CONFLICT (session_id, request_id) DO NOTHING RETURNING request_id",
            &[&session_id, &request_id],
        )?
        .is_empty())
    })?)
}

/// `releaseClaim`: the provider never returned a completion.
pub fn release_claim(pool: &Pool, session_id: &str, request_id: &str) -> Result<(), MeterError> {
    Ok(db::with_client(pool, |c| {
        c.execute(
            "DELETE FROM agents.think_claims WHERE session_id = $1::text::uuid AND request_id = $2::text",
            &[&session_id, &request_id],
        )?;
        Ok(())
    })?)
}

/// `hasRequest`.
pub fn has_request(pool: &Pool, session_id: &str, request_id: &str) -> Result<bool, MeterError> {
    Ok(db::with_client(pool, |c| {
        Ok(!c
            .query(
                "SELECT 1::text AS n FROM agents.usage_records
                  WHERE session_id = $1::text::uuid AND request_id = $2::text LIMIT 1",
                &[&session_id, &request_id],
            )?
            .is_empty())
    })?)
}

const GROUPS: &str = "SELECT SUM(input_tokens)::text, SUM(output_tokens)::text,
        input_price_per_million::text, output_price_per_million::text
   FROM agents.usage_records";

/// `groupsFor`: exact token totals per rate for one window.
pub fn groups_for(
    c: &mut impl GenericClient,
    session_id: &str,
    window_id: &str,
) -> Result<Vec<UsageGroup>, MeterError> {
    let rows = c.query(
        &format!(
            "{GROUPS} WHERE session_id = $1::text::uuid AND window_id = $2::text
              GROUP BY input_price_per_million, output_price_per_million
              ORDER BY input_price_per_million, output_price_per_million"
        ),
        &[&session_id, &window_id],
    )?;
    groups_of(&rows)
}

/// `pendingCost`: what a window would cost if settled now. Bills nothing.
pub fn pending_cost(pool: &Pool, session_id: &str, window_id: &str) -> Result<Amount, MeterError> {
    let mut conn = pool.get().map_err(StoreError::from)?;
    let groups = groups_for(
        conn.client().map_err(StoreError::from)?,
        session_id,
        window_id,
    )?;
    Ok(pricing::window_cost(&groups)?)
}

/// `sessionSpend`: the session's metered cost so far, across its windows, from the same counts and rates.
pub fn session_spend(c: &mut impl GenericClient, session_id: &str) -> Result<Amount, MeterError> {
    let rows = c.query(
        &format!(
            "{GROUPS} WHERE session_id = $1::text::uuid
              GROUP BY input_price_per_million, output_price_per_million"
        ),
        &[&session_id],
    )?;
    Ok(pricing::window_cost(&groups_of(&rows)?)?)
}

/// What the seal step found.
struct Sealed {
    amount: Amount,
    charge_tx_id: Option<String>,
    freshly_sealed: bool,
}

/// `settle`: seal the window, then bill it. `settled: false` when it was already settled, and then nothing is posted.
pub fn settle(
    m: &Metering,
    pool: &Pool,
    session_id: &str,
    user_id: &str,
    window_id: &str,
) -> Result<Settlement, MeterError> {
    let charge_key = charge_key_for(session_id, window_id);

    // Step 1, the seal: the amount frozen under FOR UPDATE. The usage trigger takes the same lock before it trusts
    // sealed_at, so no usage row can commit into a window once this commit lands.
    let sealed = db::transaction_retrying(pool, IsolationLevel::ReadCommitted, 5, |tx| {
        let rows = tx.query(
            "SELECT sealed_at IS NOT NULL, charged_amount::text, charge_tx_id
               FROM agents.usage_windows
              WHERE session_id = $1::text::uuid AND window_id = $2::text
              FOR UPDATE",
            &[&session_id, &window_id],
        )?;
        let Some(row) = rows.first() else {
            return Err(Fail::Meter(agent(
                "agents.window_not_found",
                "agents.error.window_sealed",
                format!("No usage window {window_id} for session {session_id}"),
            )));
        };
        let was_sealed: bool = row.try_get(0)?;
        if was_sealed {
            let charged: Option<String> = row.try_get(1)?;
            return Ok(Sealed {
                amount: amount_of(charged.as_deref().unwrap_or("0")).map_err(Fail::Meter)?,
                charge_tx_id: row.try_get(2)?,
                freshly_sealed: false,
            });
        }
        let groups = groups_for(tx, session_id, window_id).map_err(Fail::Meter)?;
        let amount = pricing::window_cost(&groups).map_err(|e| Fail::Meter(e.into()))?;
        // Nothing billable: sealed and closed now. The ledger refuses a zero entry, and an open zero window could be
        // "settled" twice.
        let tx_id = (amount <= Amount::ZERO).then(|| NO_CHARGE.to_owned());
        tx.execute(
            "UPDATE agents.usage_windows
                SET sealed_at = now(), charged_amount = $3::text::numeric, charged_asset = $4::text,
                    charge_key = $5::text, charge_tx_id = $6::text
              WHERE session_id = $1::text::uuid AND window_id = $2::text",
            &[
                &session_id,
                &window_id,
                &format_amount(amount),
                &m.fee_asset_id,
                &charge_key,
                &tx_id,
            ],
        )?;
        Ok(Sealed {
            amount,
            charge_tx_id: tx_id,
            freshly_sealed: true,
        })
    })
    .map_err(Fail::into_meter)?;

    // Already fully settled, or nothing to bill: nothing leaves the process.
    if let Some(tx_id) = sealed.charge_tx_id {
        return Ok(Settlement {
            session_id: session_id.to_owned(),
            window_id: window_id.to_owned(),
            charge_key,
            amount: sealed.amount,
            charge_tx_id: (tx_id != NO_CHARGE).then_some(tx_id),
            settled: sealed.freshly_sealed,
        });
    }

    // Step 2, the charge: sealed but unbilled, by this call or by one that died after its seal. Both resume to the same
    // amount under the same keys. Where the person's money is held decides how (launch money model): on the custodial
    // layer one fee charge; otherwise earned as owed and collected by their partner. A team run is owed by its
    // business, naming the member.
    let business = team_business_of(pool, session_id)?;
    let held = m
        .payment
        .read(user_id, &m.fee_asset_id, business.as_deref())
        .map_err(|_| MeterError::PaymentUnavailable)?;
    if held != HeldBy::Ledger {
        return earn_and_collect(
            m,
            pool,
            session_id,
            user_id,
            window_id,
            &charge_key,
            sealed.amount,
            &held,
            business.as_deref(),
        );
    }
    let tx_id = m
        .ledger
        .post_recipe(&Recipe::FeeCharge {
            charge_id: charge_key.clone(),
            user_id: user_id.to_owned(),
            module: m.module.clone(),
            asset_id: m.fee_asset_id.clone(),
            amount: sealed.amount,
            reason: "agents.usage.metered".to_owned(),
        })
        .map_err(MeterError::Ledger)?;
    notify_affiliates(m, &charge_key, user_id, sealed.amount);

    // Step 3, the record: of two settles of one unpaid window at once, both post (the ledger key keeps one charge) and
    // only the one that records the id reports a settlement.
    let recorded = db::with_client(pool, |c| {
        Ok(c.query(
            "UPDATE agents.usage_windows SET charge_tx_id = $3::text, paid_by = 'ledger'
              WHERE session_id = $1::text::uuid AND window_id = $2::text AND charge_tx_id IS NULL
             RETURNING window_id",
            &[&session_id, &window_id, &tx_id],
        )?
        .len())
    })?;
    Ok(Settlement {
        session_id: session_id.to_owned(),
        window_id: window_id.to_owned(),
        charge_key,
        amount: sealed.amount,
        charge_tx_id: Some(tx_id),
        settled: recorded > 0,
    })
}

/// `earnAndCollect`: earn the window once (`charge:earned:agents:<session>.<window>`), have the partner collect it
/// under the window's key, record the collect (keyed on the partner's own payment id). A partner refusal, or no payment
/// method, leaves it earned and owed, and throws `UsageOwedError`; the next settle asks again under the same keys.
#[expect(
    clippy::too_many_arguments,
    reason = "the TypeScript's own inputs, one each"
)]
fn earn_and_collect(
    m: &Metering,
    pool: &Pool,
    session_id: &str,
    user_id: &str,
    window_id: &str,
    charge_key: &str,
    amount: Amount,
    held: &HeldBy,
    business: Option<&str>,
) -> Result<Settlement, MeterError> {
    let debtor = business.unwrap_or(user_id);
    m.ledger
        .post_recipe(&Recipe::ChargeEarn {
            module: m.module.clone(),
            sale_id: format!("{session_id}.{window_id}"),
            user_id: debtor.to_owned(),
            member_user_id: business.map(|_| user_id.to_owned()),
            asset_id: m.fee_asset_id.clone(),
            per_unit: amount,
        })
        .map_err(MeterError::Ledger)?;
    if let Some(b) = business {
        db::with_client(pool, |c| {
            c.execute(
                "UPDATE agents.usage_windows SET owed_by_business = $3::text
                  WHERE session_id = $1::text::uuid AND window_id = $2::text AND owed_by_business IS NULL",
                &[&session_id, &window_id, &b],
            )?;
            Ok(())
        })?;
    }
    if *held == HeldBy::None {
        return Err(owed("no_payment_method"));
    }
    let (payment_id, partner_id, label) = match m
        .payment
        .collect(user_id, &m.fee_asset_id, amount, charge_key, business)
        .map_err(|_| MeterError::PaymentUnavailable)?
    {
        Collected::Paid {
            payment_id,
            partner_id,
            label,
        } => (payment_id, partner_id, label),
        Collected::Refused(reason) => return Err(owed(&reason)),
    };
    let tx_id = m
        .ledger
        .post_recipe(&Recipe::ChargeCollect {
            module: m.module.clone(),
            user_id: debtor.to_owned(),
            partner_id,
            payment_id: payment_id.clone(),
            asset_id: m.fee_asset_id.clone(),
            amount,
        })
        .map_err(MeterError::Ledger)?;
    notify_affiliates(m, charge_key, user_id, amount);
    let recorded = db::with_client(pool, |c| {
        Ok(c.query(
            "UPDATE agents.usage_windows
                SET charge_tx_id = $3::text, paid_by = 'partner', payment_ref = $4::text, payment_label = $5::text
              WHERE session_id = $1::text::uuid AND window_id = $2::text AND charge_tx_id IS NULL
             RETURNING window_id",
            &[&session_id, &window_id, &tx_id, &payment_id, &label],
        )?
        .len())
    })?;
    Ok(Settlement {
        session_id: session_id.to_owned(),
        window_id: window_id.to_owned(),
        charge_key: charge_key.to_owned(),
        amount,
        charge_tx_id: Some(tx_id),
        settled: recorded > 0,
    })
}

/// `fireAffiliateAccrue` then `fireAffiliatePayout`: a zero fee has nothing to share; a failure never unwinds the
/// charge already posted.
fn notify_affiliates(m: &Metering, fee_event_id: &str, user_id: &str, fee: Amount) {
    if fee <= Amount::ZERO {
        return;
    }
    let _accrued = m
        .affiliates
        .accrue(fee_event_id, user_id, fee, &m.fee_asset_id);
    let _paid = m.affiliates.payout(fee_event_id);
}

/// `teamBusinessOf`: the business a team session runs for, or none.
fn team_business_of(pool: &Pool, session_id: &str) -> Result<Option<String>, MeterError> {
    Ok(db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT business_id::text FROM agents.team_sessions WHERE session_id = $1::text::uuid",
            &[&session_id],
        )?
        .first()
        .map(|r| r.try_get::<_, String>(0))
        .transpose()?)
    })?)
}

/// `unpaidWindows`: a person's sealed, unpaid windows across their sessions, smallest first.
pub fn unpaid_windows(
    pool: &Pool,
    user_id: &str,
) -> Result<Vec<(String, String, Amount)>, MeterError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT w.session_id::text, w.window_id, w.charged_amount::text
                   FROM agents.usage_windows w
                   JOIN agents.agent_sessions s ON s.id = w.session_id
                  WHERE s.user_id = $1::text AND {UNPAID}
                  ORDER BY w.charged_amount, w.sealed_at, w.window_id"
            ),
            &[&user_id],
        )?)
    })?;
    rows.iter()
        .map(|r| {
            let amount: String = r.try_get(2)?;
            Ok((r.try_get(0)?, r.try_get(1)?, amount_of(&amount)?))
        })
        .collect()
}

/// `windowsOf`: one agent's sessions' windows of a person's, newest first.
pub fn windows_of(
    m: &Metering,
    pool: &Pool,
    user_id: &str,
    agent_id: &str,
    limit: i64,
) -> Result<Vec<WindowView>, MeterError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT w.session_id::text, w.window_id, w.sealed_at IS NOT NULL, {UNPAID},
                        w.charged_amount::text, w.charged_asset, w.charge_key,
                        to_char(w.opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
                   FROM agents.usage_windows w
                   JOIN agents.agent_sessions s ON s.id = w.session_id
                  WHERE s.user_id = $1::text AND s.agent_id = $2::text
                  ORDER BY w.opened_at DESC, w.window_id DESC
                  LIMIT $3::text::bigint"
            ),
            &[&user_id, &agent_id, &limit.to_string()],
        )?)
    })?;
    rows.iter()
        .map(|r| {
            let sealed: bool = r.try_get(2)?;
            let unpaid: bool = r.try_get(3)?;
            let charged: Option<String> = r.try_get(4)?;
            let asset: Option<String> = r.try_get(5)?;
            Ok(WindowView {
                session_id: r.try_get(0)?,
                window_id: r.try_get(1)?,
                state: if !sealed {
                    "open"
                } else if unpaid {
                    "unpaid"
                } else {
                    "settled"
                },
                amount: match (sealed, charged) {
                    (true, Some(a)) => Some(amount_of(&a)?),
                    _ => None,
                },
                asset_id: asset.unwrap_or_else(|| m.fee_asset_id.clone()),
                charge_key: r.try_get(6)?,
                opened_at: r.try_get(7)?,
            })
        })
        .collect()
}

/// `usageByDay`: these agents' sealed usage of a person's, per agent, UTC day and task, summed exactly.
pub fn usage_by_day(
    m: &Metering,
    pool: &Pool,
    user_id: &str,
    agent_ids: &[String],
) -> Result<Vec<DayView>, MeterError> {
    if agent_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids = service_kit::json::Json::Array(
        agent_ids
            .iter()
            .map(|a| service_kit::json::Json::str(a.clone()))
            .collect(),
    )
    .compact();
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT s.agent_id, left(w.window_id, 10) AS day, coalesce(t.tasks, '') AS task,
                    coalesce(sum(w.charged_amount), 0)::text AS amount, count(*)::int AS windows,
                    coalesce(w.charged_asset, $3::text) AS asset
               FROM agents.usage_windows w
               JOIN agents.agent_sessions s ON s.id = w.session_id
               LEFT JOIN LATERAL (
                 SELECT string_agg(DISTINCT r.task, ', ' ORDER BY r.task) AS tasks
                   FROM agents.usage_records r
                  WHERE r.session_id = w.session_id AND r.window_id = w.window_id
               ) t ON true
              WHERE s.user_id = $1::text
                AND s.agent_id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::text::jsonb)))
                AND w.sealed_at IS NOT NULL
              GROUP BY 1, 2, 3, 6
              ORDER BY day DESC, s.agent_id, task",
            &[&user_id, &ids, &m.fee_asset_id],
        )?)
    })?;
    rows.iter()
        .map(|r| {
            let amount: String = r.try_get(3)?;
            Ok(DayView {
                agent_id: r.try_get(0)?,
                day: r.try_get(1)?,
                task: r.try_get(2)?,
                amount: amount_of(&amount)?,
                windows: r.try_get(4)?,
                asset_id: r.try_get(5)?,
            })
        })
        .collect()
}

/// `isSealed`.
pub fn is_sealed(pool: &Pool, session_id: &str, window_id: &str) -> Result<bool, MeterError> {
    Ok(db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT sealed_at IS NOT NULL FROM agents.usage_windows
              WHERE session_id = $1::text::uuid AND window_id = $2::text",
            &[&session_id, &window_id],
        )?
        .first()
        .map(|r| r.try_get::<_, bool>(0))
        .transpose()?
        .unwrap_or(false))
    })?)
}

/// `openWindows`: every window of a session that still needs settle work: unsealed, or sealed and unpaid (a crash
/// between seal and post). A zero window seals with no charge and is not returned.
pub fn open_windows(pool: &Pool, session_id: &str) -> Result<Vec<String>, MeterError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT w.window_id FROM agents.usage_windows w
                  WHERE w.session_id = $1::text::uuid AND (w.sealed_at IS NULL OR {UNPAID})
                  ORDER BY w.window_id ASC"
            ),
            &[&session_id],
        )?)
    })?;
    Ok(rows
        .iter()
        .map(|r| r.try_get(0))
        .collect::<Result<_, _>>()
        .map_err(StoreError::from)?)
}

/// A transaction body's failure: the database's (retried when it is a serialization failure or a deadlock) or the
/// meter's own (never retried).
pub enum Fail {
    Store(StoreError),
    Meter(MeterError),
}

impl From<postgres::Error> for Fail {
    fn from(e: postgres::Error) -> Fail {
        Fail::Store(StoreError::from(e))
    }
}

impl From<StoreError> for Fail {
    fn from(e: StoreError) -> Fail {
        Fail::Store(e)
    }
}

impl Fail {
    fn into_meter(self) -> MeterError {
        match self {
            Fail::Store(s) => MeterError::Store(s),
            Fail::Meter(m) => m,
        }
    }
}

impl db::Retryable for Fail {
    fn store(&self) -> Option<&StoreError> {
        match self {
            Fail::Store(s) => Some(s),
            Fail::Meter(_) => None,
        }
    }
}
