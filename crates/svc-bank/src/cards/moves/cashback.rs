//! Cashback and the capture's round-up (`card-service.ts`: `rewardsIssuerConnected`, `cashbackRate`, `payCashback`,
//! `oweWalletCashback`, `announceWalletCashback`, `earnMissingCashback`, `retryPendingCashback`, `postCashbackReward`,
//! `fundCashbackPot`, `cashbackCapacity`, `applyRoundUp`; `issuer.ts`: `cashbackOn`).
//!
//! Cashback is a share of what actually left the book, paid from the rewards pot (`rewardPay`, keyed
//! `reward:bank.card.cashback:<authorisation id>`), which `fundCashbackPot` fills from the bank's own fees
//! (`sweepFeesToRewards`). The row is claimed first and its amount is the decision: a later re-rate never posts a
//! different reward. A short pot rejects the row by name and the capture stands. On partner-held spend nothing is
//! credited here: the cashback is recorded once and handed to the rewards programme on the bus
//! (`bankCardCashbackEarned`), which owes it and pays it to the person's own wallet.

use service_kit::json::Json;
use service_kit::money::{Amount, Rounding, format_amount, mul_div, parse_amount};
use service_kit::time::Instant;

use super::{Auth, Moves, code_of, custody_guard};
use crate::automations::auto_invest::service::{Capture, RoundUpOutcome};
use crate::cards::Card;
use crate::errors::Refusal;
use crate::spaces::ports::LedgerAccount;
use crate::spaces::space::{pg, with};

/// `CASHBACK_ANNOUNCE_UNWIRED`.
pub const ANNOUNCE_UNWIRED: &str = "bank.cashback_announce_unwired";
/// `CASHBACK_ANNOUNCE_FAILED`.
pub const ANNOUNCE_FAILED: &str = "bank.cashback_announce_failed";

/// `CashbackOutcome`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    None,
    Paid {
        amount: Amount,
        ledger_tx_id: String,
    },
    Owed {
        amount: Amount,
        announced: bool,
        reason: Option<String>,
    },
    Refused {
        amount: Amount,
        reason: String,
    },
}

impl Outcome {
    fn refused(amount: Amount, reason: &str) -> Outcome {
        Outcome::Refused {
            amount,
            reason: reason.to_owned(),
        }
    }

    /// The router's `cashback` object: `reason` on a refusal, and on an owed one when it names one.
    pub fn json(&self) -> Json {
        let (status, amount, reason) = match self {
            Outcome::None => ("none", Amount::ZERO, None),
            Outcome::Paid { amount, .. } => ("paid", *amount, None),
            Outcome::Owed { amount, reason, .. } => ("owed", *amount, reason.clone()),
            Outcome::Refused { amount, reason } => ("refused", *amount, Some(reason.clone())),
        };
        let mut f = vec![
            ("status".to_owned(), Json::str(status)),
            ("amount".to_owned(), Json::str(format_amount(amount))),
        ];
        if let Some(r) = reason {
            f.push(("reason".to_owned(), Json::str(r)));
        }
        Json::Object(f)
    }
}

/// `cashbackOn`: floor, so no rounding unit is paid that the pot never earned.
pub fn cashback_on(captured: Amount, rate_bps: i64) -> Amount {
    if rate_bps <= 0 {
        return Amount::ZERO;
    }
    // `captured * rate_bps / 10_000`: the rate is a count of basis points, carried as a scaled factor.
    mul_div(
        captured,
        Amount::from_scaled(i128::from(rate_bps)),
        Amount::from_scaled(10_000),
        Rounding::Floor,
    )
}

/// `rewardsEngine(assetId)`: the pot cashback is paid from.
pub fn rewards_pot(asset_id: &str) -> LedgerAccount {
    LedgerAccount {
        owner_type: "house",
        owner_id: "rewards-engine".to_owned(),
        asset_id: asset_id.to_owned(),
        kind: "available",
        purpose: None,
    }
}

/// `rewardsIssuerConnected`: a real issuer is an outside company; card-sim and none are not, but for the boot-guarded
/// TEST switch (`BANK_CARD_SIM_CASHBACK=test`) on the simulator's own card.
pub fn issuer_connected(m: &Moves<'_>, card: &Card) -> bool {
    let p = m.d.issuer().programme();
    if m.d.settings().simulator_pays && p.id == "card-sim" && card.issuer == "card-sim" {
        return true;
    }
    if p.simulated || card.simulated {
        return false;
    }
    if p.id == "none" || p.id == "card-sim" || card.issuer == "none" || card.issuer == "card-sim" {
        return false;
    }
    card.issuer == p.id
}

/// Whether the owner's tier table applies to this card (no operator rate, and the table's asset).
fn tier_applies(m: &Moves<'_>, card: &Card) -> bool {
    card.cashback_bps == 0
        && m.d
            .settings()
            .cashback_rates
            .as_ref()
            .is_some_and(|r| r.asset_id == card.asset_id)
}

/// `cashbackRate`: an operator's per-card rate wins; else the owner's rate for the person's rank tier.
fn rate(m: &Moves<'_>, card: &Card) -> Result<(i64, Option<String>), String> {
    if card.cashback_bps > 0 {
        return Ok((card.cashback_bps, None));
    }
    let Some(rates) =
        m.d.settings()
            .cashback_rates
            .as_ref()
            .filter(|r| r.asset_id == card.asset_id)
    else {
        return Ok((0, None));
    };
    let tier =
        m.d.w
            .rank
            .card_tier_of(&card.user_id)
            .map_err(|e| code_of(&e).unwrap_or("bank.rank_unavailable").to_owned())?;
    match rates.rate(&tier) {
        Some(bps) => Ok((bps, Some(tier))),
        None => Err("bank.cashback_rate_unset".to_owned()),
    }
}

/// `payCashback`: pay the reward, or refuse it by name and leave the capture standing.
pub fn pay(
    m: &Moves<'_>,
    card: &Card,
    authorization: &Auth,
    captured: Amount,
) -> Result<Outcome, Refusal> {
    type Row = (String, String, Option<String>, String, Option<String>);
    let read = || -> Result<Option<Row>, Refusal> {
        with(m.store(), |c| {
            Ok(c.query(
                "SELECT id::text, status::text, ledger_tx_id, amount::text, rejection_code FROM bank.card_cashback \
                  WHERE authorization_id = $1::text::uuid",
                &[&authorization.id],
            )
            .map_err(|e| pg(&e))?
            .first()
            .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4))))
        })
    };
    let row = match read()? {
        Some(row) => row,
        None => {
            if !issuer_connected(m, card) {
                let own = cashback_on(captured, card.cashback_bps);
                if own <= Amount::ZERO && !tier_applies(m, card) {
                    return Ok(Outcome::None);
                }
                return Ok(Outcome::refused(own, "bank.rewards_issuer_unset"));
            }
            let (bps, _) = match rate(m, card) {
                Ok(r) => r,
                Err(code) => return Ok(Outcome::refused(Amount::ZERO, &code)),
            };
            let amount = cashback_on(captured, bps);
            if amount <= Amount::ZERO {
                return Ok(Outcome::None);
            }
            with(m.store(), |c| {
                c.execute(
                    "INSERT INTO bank.card_cashback (authorization_id, rate_bps, amount) \
                     VALUES ($1::text::uuid, $2::int8::int4, $3::text::numeric) ON CONFLICT (authorization_id) DO NOTHING",
                    &[&authorization.id, &bps, &format_amount(amount)],
                )
                .map_err(|e| pg(&e))
            })?;
            read()?.ok_or_else(|| Refusal::Other("cashback claim vanished".to_owned()))?
        }
    };
    let (id, status, tx, raw, rejection) = row;
    let payable = parse_amount(&raw).map_err(Refusal::Other)?;
    if status == "settled"
        && let Some(tx) = tx
    {
        return Ok(Outcome::Paid {
            amount: payable,
            ledger_tx_id: tx,
        });
    }
    if status == "rejected" {
        return Ok(Outcome::refused(
            payable,
            rejection.as_deref().unwrap_or("bank.cashback_pot_unfunded"),
        ));
    }
    post_reward(m, card, &authorization.id, &id, payable)
}

/// `postCashbackReward`: post one reward, or record why it did not pay. Insufficient funds is the only error that rejects
/// the row; any other leaves it `pending` and does not throw.
fn post_reward(
    m: &Moves<'_>,
    card: &Card,
    authorization_id: &str,
    row_id: &str,
    amount: Amount,
) -> Result<Outcome, Refusal> {
    let reward_id = format!("bank.card.cashback:{authorization_id}");
    let key = format!("reward:{reward_id}");
    // A legacy pending row may name a reward whose acknowledgement was lost: reconcile it without posting again.
    let committed = match m.d.t.ledger.tx_by_key(&key) {
        Ok(t) => t,
        Err(_) => return Ok(Outcome::refused(amount, "bank.post_failed")),
    };
    if committed.is_none() && !issuer_connected(m, card) {
        return Ok(Outcome::refused(amount, "bank.rewards_issuer_unset"));
    }
    let posted = match committed {
        Some(tx) => tx.id,
        None => {
            // The custody guard's refusal is not a ledger error: it reads as `bank.post_failed`, as the TypeScript's.
            if custody_guard(m).is_err() {
                return Ok(Outcome::refused(amount, "bank.post_failed"));
            }
            let input = Json::obj([
                ("rewardId", Json::str(reward_id.clone())),
                ("userId", Json::str(card.user_id.clone())),
                ("assetId", Json::str(card.asset_id.clone())),
                ("amount", Json::str(format_amount(amount))),
                ("reason", Json::str("bank.card.cashback")),
            ]);
            match m.d.t.ledger.post_recipe("rewardPay", &input, &key) {
                Ok(tx) => tx.id,
                Err(f) if f.insufficient() => {
                    with(m.store(), |c| {
                        c.execute(
                            "UPDATE bank.card_cashback SET status = 'rejected', rejection_code = 'bank.cashback_pot_unfunded' \
                              WHERE id = $1::text::uuid AND status = 'pending'",
                            &[&row_id],
                        )
                        .map_err(|e| pg(&e))
                    })?;
                    return Ok(Outcome::refused(amount, "bank.cashback_pot_unfunded"));
                }
                Err(f) => {
                    return Ok(Outcome::refused(
                        amount,
                        f.code().unwrap_or("bank.post_failed"),
                    ));
                }
            }
        }
    };
    with(m.store(), |c| {
        c.execute(
            "UPDATE bank.card_cashback SET status = 'settled', ledger_tx_id = $2, settled_at = now(), rejection_code = NULL \
              WHERE id = $1::text::uuid AND status <> 'settled'",
            &[&row_id, &posted],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(Outcome::Paid {
        amount,
        ledger_tx_id: posted,
    })
}

/// `retryPendingCashback`: re-drive a ledger cashback row still `pending`, for the amount stored on it.
pub fn retry_pending(m: &Moves<'_>, card: &Card, authorization_id: &str) -> Result<(), Refusal> {
    let rows: Vec<(String, String)> = with(m.store(), |c| {
        Ok(c.query(
            "SELECT id::text, amount::text FROM bank.card_cashback \
              WHERE authorization_id = $1::text::uuid AND status = 'pending' AND paid_by = 'ledger'",
            &[&authorization_id],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect())
    })?;
    for (id, raw) in rows {
        let amount = parse_amount(&raw).map_err(Refusal::Other)?;
        post_reward(m, card, authorization_id, &id, amount)?;
    }
    Ok(())
}

/// `earnMissingCashback`: a settled capture whose cashback was never claimed earns it now, once.
pub fn earn_missing(m: &Moves<'_>, card: &Card, authorization: &Auth) -> Result<(), Refusal> {
    let captured: Option<String> = with(m.store(), |c| {
        Ok(c.query(
            "SELECT s.amount::text FROM bank.card_settlements s \
              WHERE s.authorization_id = $1::text::uuid AND s.sequence = 0 AND s.kind = 'capture' AND s.status = 'settled' \
                AND NOT EXISTS (SELECT 1 FROM bank.card_cashback cb WHERE cb.authorization_id = s.authorization_id)",
            &[&authorization.id],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(|r| r.get(0)))
    })?;
    if let Some(raw) = captured {
        pay(
            m,
            card,
            authorization,
            parse_amount(&raw).map_err(Refusal::Other)?,
        )?;
    }
    Ok(())
}

/// `oweWalletCashback`: cashback on a partner-held capture, recorded once (`paid_by = 'wallet'`) and handed to the
/// rewards programme. Never a balance here.
pub fn owe_wallet(
    m: &Moves<'_>,
    card: &Card,
    authorization: &Auth,
    captured: Amount,
) -> Result<Outcome, Refusal> {
    let read = || -> Result<Option<(String, String, bool)>, Refusal> {
        with(m.store(), |c| {
            Ok(c.query(
                "SELECT amount::text, paid_by, announced_at IS NOT NULL FROM bank.card_cashback \
                  WHERE authorization_id = $1::text::uuid",
                &[&authorization.id],
            )
            .map_err(|e| pg(&e))?
            .first()
            .map(|r| (r.get(0), r.get(1), r.get(2))))
        })
    };
    let row = match read()? {
        Some(r) => r,
        None => {
            if !issuer_connected(m, card) {
                if card.cashback_bps <= 0 && !tier_applies(m, card) {
                    return Ok(Outcome::None);
                }
                return Ok(Outcome::refused(Amount::ZERO, "bank.rewards_issuer_unset"));
            }
            let (bps, tier) = match rate(m, card) {
                Ok(r) => r,
                Err(code) => return Ok(Outcome::refused(Amount::ZERO, &code)),
            };
            let amount = cashback_on(captured, bps);
            if amount <= Amount::ZERO {
                return Ok(Outcome::None);
            }
            let tier = tier.unwrap_or_else(|| "card".to_owned());
            with(m.store(), |c| {
                c.execute(
                    "INSERT INTO bank.card_cashback (authorization_id, rate_bps, amount, paid_by, spend, tier) \
                     VALUES ($1::text::uuid, $2::int8::int4, $3::text::numeric, 'wallet', $4::text::numeric, $5) \
                     ON CONFLICT (authorization_id) DO NOTHING",
                    &[&authorization.id, &bps, &format_amount(amount), &format_amount(captured), &tier],
                )
                .map_err(|e| pg(&e))
            })?;
            read()?.ok_or_else(|| Refusal::Other("cashback claim vanished".to_owned()))?
        }
    };
    let (raw, paid_by, announced_at) = row;
    let amount = parse_amount(&raw).map_err(Refusal::Other)?;
    if paid_by != "wallet" {
        return Ok(Outcome::refused(amount, "bank.card_partner_held"));
    }
    let announced = announced_at || announce_wallet(m, &authorization.id)?;
    Ok(Outcome::Owed {
        amount,
        announced,
        reason: (!announced).then(|| {
            if m.cashback.is_some() {
                ANNOUNCE_FAILED
            } else {
                ANNOUNCE_UNWIRED
            }
            .to_owned()
        }),
    })
}

/// `announceWalletCashback`: hand one recorded, unannounced wallet cashback to the rewards programme; true once it was
/// taken, now or before.
pub fn announce_wallet(m: &Moves<'_>, authorization_id: &str) -> Result<bool, Refusal> {
    type Row = (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        i64,
        i64,
        bool,
    );
    let row: Option<Row> = with(m.store(), |c| {
        Ok(c.query(
            "SELECT cb.authorization_id::text, a.card_id::text, c.user_id, c.asset_id, cb.amount::text, cb.spend::text, \
                    cb.tier, cb.rate_bps::int8, floor(extract(epoch from cb.created_at) * 1000)::int8, \
                    cb.announced_at IS NOT NULL \
               FROM bank.card_cashback cb \
               JOIN bank.card_authorizations a ON a.id = cb.authorization_id \
               JOIN bank.cards c ON c.id = a.card_id \
              WHERE cb.authorization_id = $1::text::uuid AND cb.paid_by = 'wallet'",
            &[&authorization_id],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(|r| {
            (
                r.get(0),
                r.get(1),
                r.get(2),
                r.get(3),
                r.get(4),
                r.get(5),
                r.get(6),
                r.get(7),
                r.get(8),
                r.get(9),
            )
        }))
    })?;
    let Some((auth, card_id, user_id, asset_id, amount, spend, tier, rate_bps, created, announced)) =
        row
    else {
        return Ok(false);
    };
    if announced {
        return Ok(true);
    }
    let Some(bus) = m.cashback else {
        return Ok(false);
    };
    let canon = |s: &str| {
        parse_amount(s)
            .map(format_amount)
            .unwrap_or_else(|_| s.to_owned())
    };
    let key = format!("bank.card_cashback:{auth}");
    let payload = Json::obj([
        ("authorizationId", Json::str(auth)),
        ("cardId", Json::str(card_id)),
        ("userId", Json::str(user_id)),
        ("spend", Json::str(canon(&spend))),
        ("cashback", Json::str(canon(&amount))),
        ("assetId", Json::str(asset_id)),
        ("tier", Json::str(tier)),
        ("rateBps", Json::int(rate_bps)),
        ("earnedAt", Json::str(Instant(created).iso())),
    ]);
    let notices = crate::transfers::notices::Notices {
        bus,
        producer: &m.d.t.w.settings.producer,
        now: m.now(),
    };
    if notices
        .publish(
            "bankCardCashbackEarned",
            "intafaced.bank.card_cashback.earned",
            &key,
            payload,
            true,
        )
        .is_err()
    {
        return Ok(false);
    }
    with(m.store(), |c| {
        c.execute(
            "UPDATE bank.card_cashback SET announced_at = now() WHERE authorization_id = $1::text::uuid AND announced_at IS NULL",
            &[&authorization_id],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(true)
}

/// `applyRoundUp`: the spare-change sweep after the capture; never throws out to the capture.
pub fn apply_round_up(
    m: &Moves<'_>,
    card: &Card,
    authorization: &Auth,
    captured: Amount,
    partner_held: bool,
) -> RoundUpOutcome {
    let Some(hook) = m.round_up else {
        return RoundUpOutcome::None;
    };
    let cap = Capture {
        user_id: &card.user_id,
        asset_id: &card.asset_id,
        authorization_id: &authorization.id,
        captured,
        partner_held,
    };
    hook(&cap).unwrap_or_else(|e| RoundUpOutcome::Refused {
        amount: Amount::ZERO,
        reason: code_of(&e)
            .unwrap_or("bank.auto_invest_run_failed")
            .to_owned(),
    })
}

/// `fundCashbackPot`: bank revenue into the pot cashback is paid from (`sweepFeesToRewards`), the bank's own money.
pub fn fund_pot(
    m: &Moves<'_>,
    window_id: &str,
    asset_id: &str,
    amount: Amount,
) -> Result<String, Refusal> {
    let window = format!("bank.card:{window_id}");
    let input = Json::obj([
        ("windowId", Json::str(window.clone())),
        ("sourceModule", Json::str("bank")),
        ("assetId", Json::str(asset_id)),
        ("amount", Json::str(format_amount(amount))),
    ]);
    m.d.t
        .ledger
        .post_recipe(
            "sweepFeesToRewards",
            &input,
            &format!("token.fee.sweep:{window}:bank:{asset_id}"),
        )
        .map(|tx| tx.id)
        .map_err(|f| super::post_refusal(&f))
}

/// `cashbackCapacity`: what the pot can pay now, a ledger read.
pub fn capacity(m: &Moves<'_>, asset_id: &str) -> Result<Amount, Refusal> {
    m.d.t
        .ledger
        .balance(&rewards_pot(asset_id))
        .map_err(Refusal::Other)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    fn amt(s: &str) -> Amount {
        parse_amount(s).unwrap()
    }

    /// `cards.test.ts`: "cashbackOn".
    #[test]
    fn cashback_is_floored_and_a_rate_of_zero_or_less_earns_nothing() {
        assert_eq!(cashback_on(amt("100"), 100), amt("1"));
        assert_eq!(format_amount(cashback_on(amt("250"), 50)), "1.25");
        assert_eq!(cashback_on(amt("1"), 10_000), amt("1"));
        assert_eq!(cashback_on(Amount::from_scaled(1), 100), Amount::ZERO);
        assert_eq!(
            cashback_on(amt("0.000000000000000199"), 100),
            Amount::from_scaled(1)
        );
        assert_eq!(cashback_on(amt("100"), 0), Amount::ZERO);
        assert_eq!(cashback_on(amt("100"), -1), Amount::ZERO);
    }
}
