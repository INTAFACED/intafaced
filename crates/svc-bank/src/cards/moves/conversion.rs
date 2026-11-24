//! Just-in-time conversion (§18), the quotation and only the quotation (`conversion.ts`). It moves no value: it decides
//! how many units of the card's FUNDING asset one purchase in its SETTLEMENT asset costs, from a rate quoted once at the
//! authorisation and frozen beside the decision. Capture and reversal read that rate and never ask again: a second
//! quote would settle a different number of funding units than were held.
//!
//! There is no rate source of this platform's own. The rate is the loan book's port (`PriceSource`, svc-trade's ticker
//! in the binary): a card whose settlement asset differs from its funding asset refuses `bank.mark_missing` when no
//! rate can be got, and `bank.mark_unusable` on a rate that fails the seizure bar.

use postgres::GenericClient;
use service_kit::money::{Amount, Rounding, format_amount, mul_div};
use service_kit::time::Instant;

use crate::errors::Refusal;
use crate::loans::prices::{MarkPolicy, MarkQuality, PriceSource, acceptable_for_liquidation};
use crate::partner::refuse;
use crate::spaces::space::pg;

const ONE: Amount = Amount::whole(1);

/// `CardConversionPolicy`: the loan book's `MarkPolicy` and how far back a previous rate still arms the breaker.
pub struct Policy {
    pub mark: MarkPolicy,
    pub deviation_lookback_seconds: i64,
}

/// `DEFAULT_CARD_CONVERSION_POLICY`: the seizure bar, both ages a minute, `last` refused, a 20% breaker armed for an hour.
pub fn default_policy() -> Policy {
    Policy {
        mark: MarkPolicy {
            max_age_seconds: 60,
            liquidation_max_age_seconds: 60,
            max_deviation_bps: 2_000,
            liquidation_qualities: vec![MarkQuality::Index, MarkQuality::Mid],
        },
        deviation_lookback_seconds: 3_600,
    }
}

/// `ConversionQuote`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quote {
    pub settlement_asset_id: String,
    pub settlement_amount: Amount,
    pub funding_asset_id: String,
    pub funding_amount: Amount,
    pub rate: Amount,
    pub quality: &'static str,
    pub rate_as_of: Instant,
}

/// `fundingFor`: how many funding units a settlement amount costs, rounded UP so the rail is never a unit short, and
/// monotonic in the settlement amount so a partial capture never converts to more than the hold.
pub fn funding_for(settlement_amount: Amount, rate: Amount) -> Result<Amount, Refusal> {
    if rate <= Amount::ZERO {
        return Err(refuse(
            "bank.mark_invalid",
            format!(
                "Refusing to convert at a non-positive rate {}",
                format_amount(rate)
            ),
        ));
    }
    Ok(mul_div(settlement_amount, ONE, rate, Rounding::Ceil))
}

/// `PreviousRate`.
pub struct Previous {
    pub rate: Amount,
    pub accepted_at: Instant,
}

/// `quoteConversion`: quote a card spend, or refuse by name. A rate that cannot be got is not a decline: nobody decided.
pub fn quote(
    rates: &dyn PriceSource,
    funding_asset_id: &str,
    settlement_asset_id: &str,
    settlement_amount: Amount,
    previous: Option<Previous>,
    now: Instant,
    policy: &Policy,
) -> Result<Quote, Refusal> {
    let marks = rates.marks(&[funding_asset_id.to_owned()], settlement_asset_id);
    let Some(mark) = marks.get(funding_asset_id) else {
        return Err(refuse(
            "bank.mark_missing",
            format!(
                "No rate for {funding_asset_id} in {settlement_asset_id} \u{2014} refusing to convert a card spend at a rate nobody quoted"
            ),
        ));
    };
    // Only a previous rate recent enough to mean anything arms the breaker (`(now - acceptedAt) / 1000 <= lookback`).
    let previous_rate = previous
        .filter(|p| {
            i128::from(now.0 - p.accepted_at.0)
                <= i128::from(policy.deviation_lookback_seconds) * 1000
        })
        .map(|p| p.rate);
    let check = acceptable_for_liquidation(mark, previous_rate, now, &policy.mark);
    if !check.ok {
        return Err(refuse(
            "bank.mark_unusable",
            format!(
                "Refusing to convert this card spend on that rate \u{2014} {}",
                check.reason.unwrap_or_default()
            ),
        ));
    }
    Ok(Quote {
        settlement_asset_id: settlement_asset_id.to_owned(),
        settlement_amount,
        funding_asset_id: funding_asset_id.to_owned(),
        funding_amount: funding_for(settlement_amount, mark.mark.price)?,
        rate: mark.mark.price,
        quality: mark.quality.as_str(),
        rate_as_of: mark.mark.as_of,
    })
}

/// `lastAcceptedRate`: the last rate this card converted at, declines included (their rate passed the same gate), and
/// never the partner's own rate.
pub fn last_accepted_rate(
    c: &mut impl GenericClient,
    card_id: &str,
) -> Result<Option<Previous>, Refusal> {
    let rows = c
        .query(
            "SELECT c.rate::text, floor(extract(epoch from c.rate_as_of) * 1000)::int8 \
               FROM bank.card_conversions c \
               JOIN bank.card_authorizations a ON a.id = c.authorization_id \
              WHERE a.card_id = $1::text::uuid AND c.rate_quality <> 'partner' \
              ORDER BY c.created_at DESC LIMIT 1",
            &[&card_id],
        )
        .map_err(|e| pg(&e))?;
    rows.first()
        .map(|r| {
            Ok(Previous {
                rate: service_kit::money::parse_amount(&r.get::<_, String>(0))
                    .map_err(Refusal::Other)?,
                accepted_at: Instant(r.get(1)),
            })
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use crate::loans::prices::{FixedPriceSource, QuotedMark};
    use service_kit::money::parse_amount;

    fn amt(s: &str) -> Amount {
        parse_amount(s).unwrap()
    }

    /// One mark, fixed, for `quote`.
    struct One(Option<QuotedMark>);

    impl PriceSource for One {
        fn marks(&self, _: &[String], _: &str) -> crate::loans::prices::Marks {
            self.0
                .iter()
                .map(|m| (m.mark.asset_id.clone(), m.clone()))
                .collect()
        }
    }

    const NOW: Instant = Instant(1_767_225_600_000);

    #[test]
    fn converts_a_settlement_amount_into_funding_units_at_the_quoted_rate() {
        assert_eq!(funding_for(amt("100"), amt("2")).unwrap(), amt("50"));
        assert_eq!(funding_for(amt("1.5"), amt("0.5")).unwrap(), amt("3"));
    }

    #[test]
    fn rounds_up_so_a_spend_never_leaves_the_rail_one_unit_short() {
        let funding = funding_for(amt("1"), amt("3")).unwrap();
        assert_eq!(format_amount(funding), "0.333333333333333334");
        assert!(mul_div(funding, amt("3"), ONE, Rounding::Trunc) >= amt("1"));
    }

    #[test]
    fn is_monotonic_in_the_settlement_amount_and_exact_at_the_full_amount() {
        let rate = amt("1.0837");
        let full = funding_for(amt("100"), rate).unwrap();
        let mut last = Amount::ZERO;
        for part in ["0.01", "1", "33.33", "99.99", "100"] {
            let f = funding_for(amt(part), rate).unwrap();
            assert!(f >= last && f <= full);
            last = f;
        }
        assert_eq!(funding_for(amt("100"), rate).unwrap(), full);
    }

    #[test]
    fn refuses_a_non_positive_rate_rather_than_treating_it_as_a_free_card() {
        for rate in [Amount::ZERO, -Amount::UNIT] {
            let Err(Refusal::Bank(e)) = funding_for(amt("1"), rate) else {
                panic!()
            };
            assert_eq!(e.row.code, "bank.mark_invalid");
        }
    }

    #[test]
    fn makes_quote_refuse_by_name_rather_than_return_a_number() {
        let Err(Refusal::Bank(e)) = quote(
            &FixedPriceSource::empty(),
            "USDT",
            "EUR",
            amt("10"),
            None,
            NOW,
            &default_policy(),
        ) else {
            panic!()
        };
        assert_eq!(e.row.code, "bank.mark_missing");
    }

    #[test]
    fn refuses_a_last_trade_rate_and_a_stale_rate_both_by_name() {
        for (quality, age) in [(MarkQuality::Last, 0), (MarkQuality::Mid, 61_000)] {
            let src = One(Some(QuotedMark::new(
                "USDT",
                amt("0.9"),
                Instant(NOW.0 - age),
                quality,
            )));
            let Err(Refusal::Bank(e)) =
                quote(&src, "USDT", "EUR", amt("10"), None, NOW, &default_policy())
            else {
                panic!()
            };
            assert_eq!(e.row.code, "bank.mark_unusable");
        }
    }

    #[test]
    fn trips_on_a_rate_that_jumped_since_the_last_spend_unless_that_spend_is_too_old() {
        let src = One(Some(QuotedMark::new(
            "USDT",
            amt("1.5"),
            NOW,
            MarkQuality::Mid,
        )));
        let recent = Previous {
            rate: amt("1"),
            accepted_at: Instant(NOW.0 - 60_000),
        };
        let Err(Refusal::Bank(e)) = quote(
            &src,
            "USDT",
            "EUR",
            amt("10"),
            Some(recent),
            NOW,
            &default_policy(),
        ) else {
            panic!()
        };
        assert_eq!(e.row.code, "bank.mark_unusable");
        let old = Previous {
            rate: amt("1"),
            accepted_at: Instant(NOW.0 - 3_601_000),
        };
        let q = quote(
            &src,
            "USDT",
            "EUR",
            amt("10"),
            Some(old),
            NOW,
            &default_policy(),
        )
        .unwrap();
        assert_eq!(q.rate, amt("1.5"));
    }
}
