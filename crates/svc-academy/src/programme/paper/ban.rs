//! The second door (`paper/real-money-ban.ts`, D26-P1-C4): no paper payload, inbound or outbound, may carry a key that
//! claims real custody, flip a seal to true, or name a venue other than paper, at any depth. It invents nothing; it only
//! refuses shapes that would let a paper flag be read as real money.

use service_kit::json::Json;
use service_kit::schema::Value;

use crate::errors::{AcademyError, Refusal};

/// `PAPER_REAL_MONEY_BANNED_KEYS`. Simulated P&L names (`realisedPnl`, `unrealisedPnl`, `totalPnl`) travel under the
/// seal and are not banned.
pub const PAPER_REAL_MONEY_BANNED_KEYS: [&str; 20] = [
    "availableBalance",
    "available",
    "balance",
    "balances",
    "ledgerBalance",
    "ledgerTxId",
    "ledgerEntryId",
    "idempotencyKey",
    "holdAmount",
    "holdAsset",
    "settlementId",
    "custodyBalance",
    "withdrawableBalance",
    "withdrawableAmount",
    "realMoneyBalance",
    "fundedAmount",
    "reservedAmount",
    "walletBalance",
    "cashBalance",
    "buyingPower",
];

/// `PAPER_SEAL_FALSE_KEYS`: booleans that stay false on any paper door.
pub const PAPER_SEAL_FALSE_KEYS: [&str; 5] =
    ["realMoney", "realLedger", "withdrawable", "live", "isLive"];

const PAPER_VENUE: &str = "paper";

fn refuse(why: &str) -> Refusal {
    AcademyError::new(
        format!(
            "Paper payload refused — {why}. A paper flag must never be readable as real money."
        ),
        "academy.paper_looks_like_real_money",
    )
    .into()
}

/// `isPaperRealMoneyBannedKey`.
pub fn is_paper_real_money_banned_key(key: &str) -> bool {
    PAPER_REAL_MONEY_BANNED_KEYS.contains(&key)
}

/// One object key's own checks, before its value is walked.
fn check_key(here: &str, key: &str, is_true: bool, venue: Option<String>) -> Result<(), Refusal> {
    if is_paper_real_money_banned_key(key) {
        return Err(refuse(&format!("{here} claims real custody (\"{key}\")")));
    }
    if PAPER_SEAL_FALSE_KEYS.contains(&key) && is_true {
        return Err(refuse(&format!(
            "{here} is true — paper must keep {key}=false"
        )));
    }
    if key == "venue"
        && let Some(shown) = venue
    {
        return Err(refuse(&format!(
            "{here} is {shown} — paper doors are venue={PAPER_VENUE}"
        )));
    }
    Ok(())
}

/// `assertPaperNeverReadableAsRealMoney(payload, path)` over an outbound payload.
pub fn assert_never_real_money(payload: &Json, path: &str) -> Result<(), Refusal> {
    match payload {
        Json::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                assert_never_real_money(item, &format!("{path}[{i}]"))?;
            }
            Ok(())
        }
        Json::Object(fields) => {
            for (key, value) in fields {
                let here = format!("{path}.{key}");
                let venue = match value {
                    Json::String(s) if s == PAPER_VENUE => None,
                    other => Some(other.compact()),
                };
                check_key(&here, key, matches!(value, Json::Bool(true)), venue)?;
                assert_never_real_money(value, &here)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// `assertPaperNeverReadableAsRealMoney(payload)`: the path starts at `payload`.
pub fn assert_paper_never_readable_as_real_money(payload: &Json) -> Result<(), Refusal> {
    assert_never_real_money(payload, "payload")
}

/// The same walk over a value as zod returned it (an inbound body).
fn assert_value(payload: &Value, path: &str) -> Result<(), Refusal> {
    match payload {
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                assert_value(item, &format!("{path}[{i}]"))?;
            }
            Ok(())
        }
        Value::Object(fields) => {
            for (key, value) in fields {
                let here = format!("{path}.{key}");
                let venue = match value {
                    Value::String(s) if s == PAPER_VENUE => None,
                    // `JSON.stringify(undefined)` is `undefined`, which the template prints as such.
                    Value::Undefined => Some("undefined".to_owned()),
                    other => Some(
                        other
                            .to_json()
                            .map_or_else(|| "undefined".to_owned(), |j| j.compact()),
                    ),
                };
                check_key(&here, key, matches!(value, Value::Bool(true)), venue)?;
                assert_value(value, &here)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// `assertPaperInputNeverClaimsLive(payload)`: an inbound body that already claims live or real money refuses.
pub fn assert_paper_input_never_claims_live(payload: &Value) -> Result<(), Refusal> {
    assert_value(payload, "input")
}
