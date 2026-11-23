//! The owner's send review (`transfers/send-review.ts`, PP-send-request-10): a send to another person above its asset's
//! line (`BANK_PERSONAL_SEND_REVIEW_JSON`) is held for a review before any money moves. No rule published, no send is
//! held. The held row (`bank.personal_send_reviews`) is written and decided by `personal`.

use std::collections::BTreeMap;

use postgres::Row;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;

use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::pg;

/// `SendReviewRule`: each asset's line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub lines: BTreeMap<String, Amount>,
}

fn decimal_ok(v: &str) -> bool {
    let (int, frac) = v.split_once('.').map_or((v, None), |(i, f)| (i, Some(f)));
    let int_ok = int == "0"
        || (!int.is_empty()
            && int.len() <= 20
            && !int.starts_with('0')
            && int.bytes().all(|b| b.is_ascii_digit()));
    int_ok
        && frac.is_none_or(|f| (1..=18).contains(&f.len()) && f.bytes().all(|b| b.is_ascii_digit()))
}

/// `parseSendReviewRule`: blank is no rule; anything else is the rule or a start-up error naming what is wrong.
pub fn parse_rule(raw: Option<&str>) -> Result<Option<Rule>, String> {
    let Some(raw) = raw.filter(|r| !r.trim().is_empty()) else {
        return Ok(None);
    };
    let parsed = json::parse(raw).map_err(|_| {
        "BANK_PERSONAL_SEND_REVIEW_JSON is not JSON: write {\"<asset>\": \"<amount>\"}".to_owned()
    })?;
    let Json::Object(fields) = parsed else {
        return Err(
            "BANK_PERSONAL_SEND_REVIEW_JSON must be an object of {\"<asset>\": \"<amount>\"}"
                .to_owned(),
        );
    };
    let mut lines = BTreeMap::new();
    for (asset, value) in fields {
        let asset_ok = (1..=16).contains(&asset.len())
            && asset
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
        if !asset_ok {
            return Err(format!(
                "BANK_PERSONAL_SEND_REVIEW_JSON names \"{asset}\", which is not an asset id"
            ));
        }
        let Json::String(v) = value else {
            return Err(format!(
                "BANK_PERSONAL_SEND_REVIEW_JSON line for {asset} must be a decimal string"
            ));
        };
        if !decimal_ok(&v) {
            return Err(format!(
                "BANK_PERSONAL_SEND_REVIEW_JSON line for {asset} must be a decimal string"
            ));
        }
        let line = parse_amount(&v)?;
        if line <= Amount::ZERO {
            return Err(format!(
                "BANK_PERSONAL_SEND_REVIEW_JSON line for {asset} must be above zero"
            ));
        }
        lines.insert(asset, line);
    }
    if lines.is_empty() {
        return Err(
            "BANK_PERSONAL_SEND_REVIEW_JSON names no asset; leave it unset for no review rule"
                .to_owned(),
        );
    }
    Ok(Some(Rule { lines }))
}

/// The rule as published, read where it is used. A value `env.rs` let through always parses; one that does not is no
/// rule, as it could not have started the TypeScript service.
pub fn rule_of(raw: Option<&str>) -> Option<Rule> {
    parse_rule(raw).ok().flatten()
}

/// `reviewReason`: `amount_over_review_line` above the asset's line, else none.
pub fn reason(rule: Option<&Rule>, asset_id: &str, amount: Amount) -> Option<&'static str> {
    let line = rule?.lines.get(&asset_id.to_uppercase())?;
    (amount > *line).then_some("amount_over_review_line")
}

/// `PersonalPayService.overReviewLine`.
pub fn over_review_line(raw: Option<&str>, asset_id: &str, amount: Amount) -> bool {
    reason(rule_of(raw).as_ref(), asset_id, amount).is_some()
}

/// `SEND_REVIEW_COLS`, in [`ReviewRow::from_row`]'s order.
pub const COLS: &str = "transfer_id, from_user_id, from_space_id::text, to_user_id, asset_id, amount::text, note, \
     reference, request_id::text, from_handle, to_handle, reason_class, status, decided_by, ledger_tx_id, \
     floor(extract(epoch from created_at) * 1000)::int8, floor(extract(epoch from decided_at) * 1000)::int8";

/// `SendReviewRow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewRow {
    pub transfer_id: String,
    pub from_user_id: String,
    pub from_space_id: String,
    pub to_user_id: String,
    pub asset_id: String,
    pub amount: Amount,
    pub note: Option<String>,
    pub reference: Option<String>,
    pub request_id: Option<String>,
    pub from_handle: Option<String>,
    pub to_handle: Option<String>,
    pub reason_class: String,
    /// `in_review`, `releasing`, `released` or `rejected`.
    pub status: String,
    pub decided_by: Option<String>,
    pub ledger_tx_id: Option<String>,
    pub created_at: Instant,
    pub decided_at: Option<Instant>,
}

impl ReviewRow {
    /// A row of [`COLS`].
    pub fn from_row(r: &Row) -> Result<ReviewRow, Refusal> {
        let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
        let o = |i: usize| r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e));
        Ok(ReviewRow {
            transfer_id: s(0)?,
            from_user_id: s(1)?,
            from_space_id: s(2)?,
            to_user_id: s(3)?,
            asset_id: s(4)?,
            amount: parse_amount(&s(5)?).map_err(Refusal::Other)?,
            note: o(6)?,
            reference: o(7)?,
            request_id: o(8)?,
            from_handle: o(9)?,
            to_handle: o(10)?,
            reason_class: s(11)?,
            status: s(12)?,
            decided_by: o(13)?,
            ledger_tx_id: o(14)?,
            created_at: Instant(r.try_get::<_, i64>(15).map_err(|e| pg(&e))?),
            decided_at: r
                .try_get::<_, Option<i64>>(16)
                .map_err(|e| pg(&e))?
                .map(Instant),
        })
    }
}

/// `HeldSendView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldView {
    pub transfer_id: String,
    /// `in_review` (a release under way reads as still in review), `released` or `rejected`.
    pub status: String,
    pub reason_class: String,
    pub amount: Amount,
    pub asset_id: String,
    pub note: Option<String>,
    pub reference: Option<String>,
    pub request_id: Option<String>,
    pub to_handle: Option<String>,
    pub ledger_tx_id: Option<String>,
    pub created_at: Instant,
    pub decided_at: Option<Instant>,
}

/// `heldSendView`.
pub fn held_view(row: &ReviewRow) -> HeldView {
    HeldView {
        transfer_id: row.transfer_id.clone(),
        status: if row.status == "releasing" {
            "in_review".to_owned()
        } else {
            row.status.clone()
        },
        reason_class: row.reason_class.clone(),
        amount: row.amount,
        asset_id: row.asset_id.clone(),
        note: row.note.clone(),
        reference: row.reference.clone(),
        request_id: row.request_id.clone(),
        to_handle: row.to_handle.clone(),
        ledger_tx_id: row.ledger_tx_id.clone(),
        created_at: row.created_at,
        decided_at: row.decided_at,
    }
}

fn opt(s: Option<&String>) -> Json {
    s.map_or(Json::Null, |v| Json::str(v.clone()))
}

impl HeldView {
    /// `heldSendOutput`, in its schema's key order.
    pub fn fields(&self) -> Vec<(String, Json)> {
        vec![
            ("transferId".to_owned(), Json::str(self.transfer_id.clone())),
            ("status".to_owned(), Json::str(self.status.clone())),
            (
                "reasonClass".to_owned(),
                Json::str(self.reason_class.clone()),
            ),
            ("amount".to_owned(), Json::str(format_amount(self.amount))),
            ("assetId".to_owned(), Json::str(self.asset_id.clone())),
            ("note".to_owned(), opt(self.note.as_ref())),
            ("reference".to_owned(), opt(self.reference.as_ref())),
            ("requestId".to_owned(), opt(self.request_id.as_ref())),
            ("toHandle".to_owned(), opt(self.to_handle.as_ref())),
            ("ledgerTxId".to_owned(), opt(self.ledger_tx_id.as_ref())),
            ("createdAt".to_owned(), Json::str(self.created_at.iso())),
            (
                "decidedAt".to_owned(),
                self.decided_at.map_or(Json::Null, |t| Json::str(t.iso())),
            ),
        ]
    }

    pub fn json(&self) -> Json {
        Json::Object(self.fields())
    }
}

/// What a send asks for, as `sameHeldSend` compares it.
pub struct SendAsk<'a> {
    pub actor_user_id: &'a str,
    pub from_space_id: &'a str,
    pub to_user_id: &'a str,
    pub asset_id: &'a str,
    pub amount: Amount,
    pub note: Option<&'a str>,
    pub reference: Option<&'a str>,
    pub request_id: Option<&'a str>,
}

/// `sameHeldSend`.
pub fn same_held_send(row: &ReviewRow, ask: &SendAsk<'_>) -> bool {
    row.from_user_id == ask.actor_user_id
        && row.from_space_id == ask.from_space_id
        && row.to_user_id == ask.to_user_id
        && row.asset_id == ask.asset_id
        && row.amount == ask.amount
        && row.note.as_deref() == ask.note
        && row.reference.as_deref() == ask.reference
        && row.request_id.as_deref() == ask.request_id
}

/// `heldRefusal`.
pub fn held_refusal(view: &HeldView) -> Refusal {
    if view.status == "rejected" {
        refuse(
            "bank.personal_send_rejected",
            format!(
                "Payment {} was not sent: the review rejected it (bank.personal_send_rejected)",
                view.transfer_id
            ),
        )
    } else {
        refuse(
            "bank.personal_send_in_review",
            format!(
                "Payment {} is in review before it is sent; nothing has moved (bank.personal_send_in_review)",
                view.transfer_id
            ),
        )
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn the_rule_holds_only_above_its_assets_line() {
        let rule = parse_rule(Some(r#"{"USDC":"1000"}"#)).unwrap().unwrap();
        assert_eq!(
            reason(Some(&rule), "usdc", parse_amount("1000").unwrap()),
            None
        );
        assert_eq!(
            reason(Some(&rule), "USDC", parse_amount("1000.01").unwrap()),
            Some("amount_over_review_line")
        );
        assert_eq!(
            reason(Some(&rule), "EUR", parse_amount("5000").unwrap()),
            None
        );
        assert_eq!(parse_rule(Some("  ")).unwrap(), None);
        assert!(parse_rule(Some("{}")).is_err());
        assert!(parse_rule(Some(r#"{"usdc":"1"}"#)).is_err());
        assert!(parse_rule(Some(r#"{"USDC":"0"}"#)).is_err());
        assert!(parse_rule(Some(r#"{"USDC":1}"#)).is_err());
    }
}
