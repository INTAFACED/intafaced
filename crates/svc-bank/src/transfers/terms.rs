//! The owner's personal transfer terms (`transfers/transfer-terms.ts`, PP-send-request-07) and what reads them: the
//! published fee schedule (`PersonalPayService.feeSchedule`, the call `fees.schedule.get`), a send's quote and its check
//! against the terms (`quote`, `assertWithinTerms`, `spentToday` in `transfers/personal-pay.ts`).
//!
//! A send with no terms row for its asset refuses `bank.personal_transfer_terms_unset`: blank is not unlimited. A
//! published fee above zero refuses every send (`bank.personal_transfer_fee_unwired`): no send has a fee leg yet. The
//! one writer of a row is compliance with a second person (`ops.publishTransferTerms`, slice `ops-desk`), which calls
//! [`assert_transfer_terms`], [`publish_fields`] and [`publish`] here.

use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::{Instant, civil_from_days, days_from_civil};

use super::Deps;
use super::limits::granted_limits;
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{at, pg, with};

/// `PUBLISH_TRANSFER_TERMS_ACTION`: the approval's action type.
pub const PUBLISH_TRANSFER_TERMS_ACTION: &str = "bank.ops.publishTransferTerms";

/// `STALE_RESERVATION_MS`: a reservation older than this is released by the person's next send.
pub const STALE_RESERVATION_MS: i64 = 15 * 60 * 1000;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

const FEE_UNWIRED: &str = "bank.personal_transfer_fee_unwired";

fn amount(s: &str) -> Result<Amount, Refusal> {
    parse_amount(s).map_err(Refusal::Other)
}

/// `termsUnset`.
pub fn terms_unset(asset_id: &str) -> Refusal {
    refuse(
        "bank.personal_transfer_terms_unset",
        format!(
            "No per-transfer limit, daily limit, or fee is published for {asset_id} (bank.personal_transfer_terms_unset)"
        ),
    )
}

/// `utcDayStart`: midnight UTC of the day `now` falls in.
pub fn utc_day_start(now: Instant) -> Instant {
    let (y, m, d) = civil_from_days(now.0.div_euclid(DAY_MS));
    Instant(days_from_civil(y, m, d) * DAY_MS)
}

/// `TermsRow`: one asset's published figures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TermsRow {
    pub per_transfer_limit: Amount,
    pub daily_limit: Amount,
    pub fee: Amount,
}

/// The terms row for an asset, or none while nothing is published for it.
pub fn terms_row(c: &mut impl GenericClient, asset_id: &str) -> Result<Option<TermsRow>, Refusal> {
    let rows = c
        .query(
            "SELECT per_transfer_limit::text, daily_limit::text, fee::text
               FROM bank.personal_transfer_terms WHERE asset_id = $1",
            &[&asset_id],
        )
        .map_err(|e| pg(&e))?;
    let Some(r) = rows.first() else {
        return Ok(None);
    };
    let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
    Ok(Some(TermsRow {
        per_transfer_limit: amount(&s(0)?)?,
        daily_limit: amount(&s(1)?)?,
        fee: amount(&s(2)?)?,
    }))
}

/// `spentToday`: posted since `start`, plus what is reserved since `reserved_since` (a send passes `start`; a quote
/// passes the stale cutoff, so it does not count a reservation the next send would release).
pub fn spent_today(
    c: &mut impl GenericClient,
    user_id: &str,
    asset_id: &str,
    start: Instant,
    reserved_since: Instant,
) -> Result<Amount, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT COALESCE(SUM(amount), 0)::text AS spent
                   FROM bank.personal_transfers
                  WHERE from_user_id = $1 AND asset_id = $2 AND created_at >= {}
                    AND (status = 'posted' OR (status = 'reserved' AND created_at >= {}))",
                at("$3"),
                at("$4")
            ),
            &[&user_id, &asset_id, &start.0, &reserved_since.0],
        )
        .map_err(|e| pg(&e))?;
    let spent = match rows.first() {
        Some(r) => r.try_get::<_, String>(0).map_err(|e| pg(&e))?,
        None => "0".to_owned(),
    };
    amount(&spent)
}

/// `assertWithinTerms`: the terms are published, no fee is due, and the amount is within the person's per-transfer
/// limit and what is left of today's (a granted limit replaces the published one of its kind). Run inside the send's
/// transaction.
pub fn assert_within_terms(
    c: &mut impl GenericClient,
    user_id: &str,
    asset_id: &str,
    amount: Amount,
    now: Instant,
) -> Result<(), Refusal> {
    let terms = terms_row(c, asset_id)?.ok_or_else(|| terms_unset(asset_id))?;
    if terms.fee > 0 {
        return Err(refuse(
            FEE_UNWIRED,
            format!(
                "A fee of {} {asset_id} is published, and this transfer has no fee leg to collect it (bank.personal_transfer_fee_unwired)",
                format_amount(terms.fee)
            ),
        ));
    }
    let (granted_per, granted_daily) = granted_limits(c, user_id, asset_id)?;
    let per = granted_per.unwrap_or(terms.per_transfer_limit);
    if amount > per {
        return Err(refuse(
            "bank.personal_transfer_limit_exceeded",
            format!(
                "Amount is above the per-transfer limit of {} {asset_id} (bank.personal_transfer_limit_exceeded)",
                format_amount(per)
            ),
        ));
    }
    let start = utc_day_start(now);
    let spent = spent_today(c, user_id, asset_id, start, start)?;
    let daily = granted_daily.unwrap_or(terms.daily_limit);
    if spent + amount > daily {
        return Err(refuse(
            "bank.personal_transfer_daily_limit_exceeded",
            format!(
                "Amount would pass the daily limit of {} {asset_id} (bank.personal_transfer_daily_limit_exceeded)",
                format_amount(daily)
            ),
        ));
    }
    Ok(())
}

/// `TransferQuote`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quote {
    pub asset_id: String,
    pub amount: Amount,
    pub per_transfer_limit: Amount,
    pub daily_limit: Amount,
    pub spent_today: Amount,
    pub remaining_today: Amount,
    pub fee: Amount,
    pub fee_blocker: Option<&'static str>,
    pub within_per_transfer: bool,
    pub within_daily: bool,
}

impl Quote {
    /// `transfers.quote`'s output in its schema's key order. `network_fee`: `None` leaves the key out (no partner reports
    /// one), `Some(Json::Null)` is a partner fee not known, never 0.
    pub fn json(&self, network_fee: Option<Json>) -> Json {
        let mut f = vec![
            ("assetId".to_owned(), Json::str(self.asset_id.clone())),
            ("amount".to_owned(), Json::str(format_amount(self.amount))),
            (
                "perTransferLimit".to_owned(),
                Json::str(format_amount(self.per_transfer_limit)),
            ),
            (
                "dailyLimit".to_owned(),
                Json::str(format_amount(self.daily_limit)),
            ),
            (
                "spentToday".to_owned(),
                Json::str(format_amount(self.spent_today)),
            ),
            (
                "remainingToday".to_owned(),
                Json::str(format_amount(self.remaining_today)),
            ),
            ("fee".to_owned(), Json::str(format_amount(self.fee))),
            (
                "feeBlocker".to_owned(),
                self.fee_blocker.map_or(Json::Null, Json::str),
            ),
        ];
        if let Some(n) = network_fee {
            f.push(("networkFee".to_owned(), n));
        }
        f.push((
            "withinPerTransfer".to_owned(),
            Json::Bool(self.within_per_transfer),
        ));
        f.push(("withinDaily".to_owned(), Json::Bool(self.within_daily)));
        Json::Object(f)
    }
}

/// `PersonalPayService.quote`: the person's limits, what they sent today and the fee, before the review step. Refuses
/// when nothing is published; never fills a zero fee or a default cap.
pub fn quote(
    c: &mut impl GenericClient,
    user_id: &str,
    asset_id: &str,
    amount: Amount,
    now: Instant,
) -> Result<Quote, Refusal> {
    let terms = terms_row(c, asset_id)?.ok_or_else(|| terms_unset(asset_id))?;
    let reserved_since = Instant(now.0 - STALE_RESERVATION_MS);
    let spent = spent_today(c, user_id, asset_id, utc_day_start(now), reserved_since)?;
    let (granted_per, granted_daily) = granted_limits(c, user_id, asset_id)?;
    let per = granted_per.unwrap_or(terms.per_transfer_limit);
    let daily = granted_daily.unwrap_or(terms.daily_limit);
    Ok(Quote {
        asset_id: asset_id.to_owned(),
        amount,
        per_transfer_limit: per,
        daily_limit: daily,
        spent_today: spent,
        remaining_today: if daily > spent { daily - spent } else { 0 },
        fee: terms.fee,
        fee_blocker: (terms.fee > 0).then_some(FEE_UNWIRED),
        within_per_transfer: amount <= per,
        within_daily: spent + amount <= daily,
    })
}

/// `PersonalPayService.feeSchedule`: every published fee row, by asset. No rows is `published: false`; a published zero
/// is free, never inferred from blank.
pub fn fee_schedule(c: &mut impl GenericClient) -> Result<Json, Refusal> {
    let rows = c
        .query(
            "SELECT asset_id, fee::text, floor(extract(epoch from published_at) * 1000)::int8
               FROM bank.personal_transfer_terms
              ORDER BY asset_id",
            &[],
        )
        .map_err(|e| pg(&e))?;
    let mut entries = Vec::new();
    for r in &rows {
        let asset: String = r.try_get(0).map_err(|e| pg(&e))?;
        let fee = amount(&r.try_get::<_, String>(1).map_err(|e| pg(&e))?)?;
        let published: i64 = r.try_get(2).map_err(|e| pg(&e))?;
        entries.push(Json::obj([
            ("assetId", Json::str(asset)),
            ("fee", Json::str(format_amount(fee))),
            ("free", Json::Bool(fee == 0)),
            (
                "feeBlocker",
                if fee > 0 {
                    Json::str(FEE_UNWIRED)
                } else {
                    Json::Null
                },
            ),
            ("publishedAt", Json::str(Instant(published).iso())),
        ]));
    }
    Ok(Json::obj([
        ("published", Json::Bool(!entries.is_empty())),
        ("entries", Json::Array(entries)),
    ]))
}

/// `assertTransferTerms`: refuses figures the send path could not honour, before any approval is spent.
pub fn assert_transfer_terms(per: Amount, daily: Amount) -> Result<(), Refusal> {
    if per <= 0 || daily <= 0 {
        return Err(refuse(
            "bank.personal_transfer_terms_invalid",
            "Per-transfer and daily limits must be above zero (bank.personal_transfer_terms_invalid)",
        ));
    }
    if daily < per {
        return Err(refuse(
            "bank.personal_transfer_terms_invalid",
            format!(
                "The daily limit {} is below the per-transfer limit {} (bank.personal_transfer_terms_invalid)",
                format_amount(daily),
                format_amount(per)
            ),
        ));
    }
    Ok(())
}

/// `publishTransferTermsFields`: what the approval is bound to, in canonical decimal form and key order.
pub fn publish_fields(
    asset_id: &str,
    per: Amount,
    daily: Amount,
    fee: Amount,
) -> Vec<(String, String)> {
    vec![
        ("assetId".to_owned(), asset_id.trim().to_owned()),
        ("perTransferLimit".to_owned(), format_amount(per)),
        ("dailyLimit".to_owned(), format_amount(daily)),
        ("fee".to_owned(), format_amount(fee)),
    ]
}

/// `PublishedTransferTerms`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Published {
    pub asset_id: String,
    pub terms: TermsRow,
    pub published_at: Instant,
}

impl Published {
    /// The publish call's output before `approvedBy`, in its schema's key order.
    pub fn fields(&self) -> Vec<(String, Json)> {
        vec![
            ("assetId".to_owned(), Json::str(self.asset_id.clone())),
            (
                "perTransferLimit".to_owned(),
                Json::str(format_amount(self.terms.per_transfer_limit)),
            ),
            (
                "dailyLimit".to_owned(),
                Json::str(format_amount(self.terms.daily_limit)),
            ),
            ("fee".to_owned(), Json::str(format_amount(self.terms.fee))),
            ("publishedAt".to_owned(), Json::str(self.published_at.iso())),
        ]
    }
}

/// `publishTransferTerms`: writes the asset's row, replacing any earlier one for that asset only.
pub fn publish(
    c: &mut impl GenericClient,
    asset_id: &str,
    terms: TermsRow,
) -> Result<Published, Refusal> {
    let (per, daily, fee) = (
        format_amount(terms.per_transfer_limit),
        format_amount(terms.daily_limit),
        format_amount(terms.fee),
    );
    let rows = c
        .query(
            "INSERT INTO bank.personal_transfer_terms (asset_id, per_transfer_limit, daily_limit, fee, published_at)
             VALUES ($1, $2::text::numeric, $3::text::numeric, $4::text::numeric, now())
             ON CONFLICT (asset_id) DO UPDATE
               SET per_transfer_limit = EXCLUDED.per_transfer_limit,
                   daily_limit = EXCLUDED.daily_limit,
                   fee = EXCLUDED.fee,
                   published_at = EXCLUDED.published_at
             RETURNING asset_id, per_transfer_limit::text, daily_limit::text, fee::text,
                       floor(extract(epoch from published_at) * 1000)::int8",
            &[&asset_id, &per, &daily, &fee],
        )
        .map_err(|e| pg(&e))?;
    let Some(r) = rows.first() else {
        return Err(Refusal::Other(format!(
            "The terms row for {asset_id} came back empty from its upsert"
        )));
    };
    let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
    Ok(Published {
        asset_id: s(0)?,
        terms: TermsRow {
            per_transfer_limit: amount(&s(1)?)?,
            daily_limit: amount(&s(2)?)?,
            fee: amount(&s(3)?)?,
        },
        published_at: Instant(r.try_get::<_, i64>(4).map_err(|e| pg(&e))?),
    })
}

/// The answer of `fees.schedule.get`; `None` for any other path.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    match ctx.call.path {
        "fees.schedule.get" => Some(with(d.store, fee_schedule)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use service_kit::time::js_date;

    #[test]
    fn the_day_starts_at_midnight_utc() {
        let now = js_date("2026-03-01T23:59:59.999Z").unwrap();
        assert_eq!(utc_day_start(now).iso(), "2026-03-01T00:00:00.000Z");
        let before_epoch = js_date("1969-12-31T12:00:00.000Z").unwrap();
        assert_eq!(
            utc_day_start(before_epoch).iso(),
            "1969-12-31T00:00:00.000Z"
        );
    }

    #[test]
    fn terms_refuse_zero_and_inverted_limits() {
        let a = |s: &str| parse_amount(s).unwrap();
        assert!(assert_transfer_terms(a("0"), a("10")).is_err());
        assert!(assert_transfer_terms(a("10"), a("0")).is_err());
        let Err(Refusal::Bank(e)) = assert_transfer_terms(a("1001"), a("1000")) else {
            panic!()
        };
        assert_eq!(
            e.message,
            "The daily limit 1000 is below the per-transfer limit 1001 (bank.personal_transfer_terms_invalid)"
        );
        assert!(assert_transfer_terms(a("250"), a("1000")).is_ok());
        assert_eq!(
            publish_fields(" USDT ", a("250.0"), a("1000"), a("0")),
            vec![
                ("assetId".to_owned(), "USDT".to_owned()),
                ("perTransferLimit".to_owned(), "250".to_owned()),
                ("dailyLimit".to_owned(), "1000".to_owned()),
                ("fee".to_owned(), "0".to_owned()),
            ]
        );
    }
}
