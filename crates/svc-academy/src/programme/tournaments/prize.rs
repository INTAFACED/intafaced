//! IFC prize pools refuse-closed (`tournaments/prize-refuse.ts`). Ledger fund and payout recipes are Class M and do
//! not exist on this path: every prize-shaped intent refuses, a blank pool cannot start (`academy.prize_pool_unset`),
//! and a present amount still refuses (`academy.prize_refuse_closed`). Nothing here holds, parses or invents an amount.

use service_kit::json::Json;
use service_kit::schema::{Value, js_trim};

use super::ladder::TournamentError;

/// `PRIZE_REFUSE_CODE`.
pub const PRIZE_REFUSE_CODE: &str = "academy.prize_refuse_closed";
/// `PRIZE_POOL_UNSET_CODE`.
pub const PRIZE_POOL_UNSET_CODE: &str = "academy.prize_pool_unset";

const MESSAGE: &str = "IFC prize pools are refuse-closed — no invent pools, no academy balances, Class M ledger recipes only";
const UNSET_MESSAGE: &str =
    "IFC prize pool is unset — blank pool cannot start; refuse-closed (no invent IFC amounts)";

/// `PRIZE_POOL_UNSET_RESIDUAL`.
pub const PRIZE_POOL_UNSET_RESIDUAL: &str = "TRK-academy.tournaments D26-P1-C3 — prize pool unset; blank cannot start; refuse-closed (no invent IFC)";
/// `PRIZE_POOL_CLASS_M_RESIDUAL`.
pub const PRIZE_POOL_CLASS_M_RESIDUAL: &str = "TRK-academy.tournaments Class M — prize fund/payout recipes unset; refuse-closed (no invent IFC)";

/// `PrizeIntentKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrizeIntentKind {
    FundPool,
    Payout,
    Escrow,
    Clawback,
    InventBalance,
}

impl PrizeIntentKind {
    pub const ALL: [PrizeIntentKind; 5] = [
        PrizeIntentKind::FundPool,
        PrizeIntentKind::Payout,
        PrizeIntentKind::Escrow,
        PrizeIntentKind::Clawback,
        PrizeIntentKind::InventBalance,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            PrizeIntentKind::FundPool => "fund_pool",
            PrizeIntentKind::Payout => "payout",
            PrizeIntentKind::Escrow => "escrow",
            PrizeIntentKind::Clawback => "clawback",
            PrizeIntentKind::InventBalance => "invent_balance",
        }
    }

    pub fn parse(s: &str) -> Option<PrizeIntentKind> {
        PrizeIntentKind::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

/// `PrizeDecision`: always the closed refuse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrizeDecision {
    pub status: &'static str,
    pub code: &'static str,
    pub kind: PrizeIntentKind,
    pub message: &'static str,
    pub academy_holds_prize_balance: bool,
    pub ledger_recipe_ready: bool,
}

impl PrizeDecision {
    /// The decision as the TypeScript object (`JSON.stringify(d)`).
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("status", Json::str(self.status)),
            ("code", Json::str(self.code)),
            ("kind", Json::str(self.kind.as_str())),
            ("message", Json::str(self.message)),
            (
                "academyHoldsPrizeBalance",
                Json::Bool(self.academy_holds_prize_balance),
            ),
            ("ledgerRecipeReady", Json::Bool(self.ledger_recipe_ready)),
        ])
    }
}

/// Why a start refuses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartReason {
    Unset,
    ClassM,
}

impl StartReason {
    pub fn as_str(self) -> &'static str {
        match self {
            StartReason::Unset => "unset",
            StartReason::ClassM => "class_m",
        }
    }
}

/// `PrizeStartDecision`: never ok.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrizeStartDecision {
    pub status: &'static str,
    pub code: &'static str,
    pub reason: StartReason,
    pub message: &'static str,
    pub academy_holds_prize_balance: bool,
    pub ledger_recipe_ready: bool,
    pub invented_ifc: bool,
}

impl PrizeStartDecision {
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("status", Json::str(self.status)),
            ("code", Json::str(self.code)),
            ("reason", Json::str(self.reason.as_str())),
            ("message", Json::str(self.message)),
            (
                "academyHoldsPrizeBalance",
                Json::Bool(self.academy_holds_prize_balance),
            ),
            ("ledgerRecipeReady", Json::Bool(self.ledger_recipe_ready)),
            ("inventedIfc", Json::Bool(self.invented_ifc)),
        ])
    }
}

/// `PrizePoolRefuseError`: answered 412 with its own message and code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrizePoolRefuseError {
    pub message: &'static str,
    pub code: &'static str,
    pub residual: &'static str,
    pub reason: StartReason,
}

/// `decidePrizeIntent`.
pub fn decide_prize_intent(kind: PrizeIntentKind) -> PrizeDecision {
    PrizeDecision {
        status: "refuse",
        code: PRIZE_REFUSE_CODE,
        kind,
        message: MESSAGE,
        academy_holds_prize_balance: false,
        ledger_recipe_ready: false,
    }
}

/// `refuseFundPrizePool`.
pub fn refuse_fund_prize_pool() -> PrizeDecision {
    decide_prize_intent(PrizeIntentKind::FundPool)
}

/// `refusePrizePayout`.
pub fn refuse_prize_payout() -> PrizeDecision {
    decide_prize_intent(PrizeIntentKind::Payout)
}

/// `refusePrizeEscrow`.
pub fn refuse_prize_escrow() -> PrizeDecision {
    decide_prize_intent(PrizeIntentKind::Escrow)
}

/// `refusePrizeClawback`.
pub fn refuse_prize_clawback() -> PrizeDecision {
    decide_prize_intent(PrizeIntentKind::Clawback)
}

/// `refuseInventPrizeBalance`.
pub fn refuse_invent_prize_balance() -> PrizeDecision {
    decide_prize_intent(PrizeIntentKind::InventBalance)
}

/// `value == null`: JavaScript's loose null (null or undefined).
fn nullish(v: &Value) -> bool {
    matches!(v, Value::Null | Value::Undefined)
}

fn is_blank_amount(v: &Value) -> bool {
    match v {
        Value::String(s) => js_trim(s).is_empty(),
        _ => true,
    }
}

/// `isPrizePoolUnset`: blank, missing or of an unknown shape is unset (fail closed). A JS array is an object, so it is
/// read as one: it holds none of the amount keys.
pub fn is_prize_pool_unset(pool: &Value) -> bool {
    match pool {
        Value::String(s) => js_trim(s).is_empty(),
        Value::Object(fields) => {
            let present: Vec<&Value> = ["amount", "ifcAmount", "prizePool", "prizeAmount"]
                .iter()
                .filter_map(|k| fields.iter().find(|(key, _)| key == k).map(|(_, v)| v))
                .collect();
            present.is_empty() || present.into_iter().all(is_blank_amount)
        }
        _ => true,
    }
}

/// `decidePrizePoolStart`.
pub fn decide_prize_pool_start(pool: &Value) -> PrizeStartDecision {
    let (code, reason, message) = if is_prize_pool_unset(pool) {
        (PRIZE_POOL_UNSET_CODE, StartReason::Unset, UNSET_MESSAGE)
    } else {
        (PRIZE_REFUSE_CODE, StartReason::ClassM, MESSAGE)
    };
    PrizeStartDecision {
        status: "refuse",
        code,
        reason,
        message,
        academy_holds_prize_balance: false,
        ledger_recipe_ready: false,
        invented_ifc: false,
    }
}

/// `assertMayStartPrizeSeason`: always refuses, unset or Class M.
pub fn assert_may_start_prize_season(pool: &Value) -> PrizePoolRefuseError {
    let d = decide_prize_pool_start(pool);
    PrizePoolRefuseError {
        message: d.message,
        code: d.code,
        residual: match d.reason {
            StartReason::Unset => PRIZE_POOL_UNSET_RESIDUAL,
            StartReason::ClassM => PRIZE_POOL_CLASS_M_RESIDUAL,
        },
        reason: d.reason,
    }
}

/// `refuseUnsetPrizePoolStart`.
pub fn refuse_unset_prize_pool_start() -> PrizePoolRefuseError {
    assert_may_start_prize_season(&Value::Null)
}

/// `tryRefusePrizePoolStart`.
pub fn try_refuse_prize_pool_start(pool: &Value) -> PrizeStartDecision {
    decide_prize_pool_start(pool)
}

/// `prizePoolUnsetResidualIsHonest`.
pub fn prize_pool_unset_residual_is_honest(residual: &str) -> bool {
    residual.contains("unset")
        && residual.contains("refuse-closed")
        && residual.contains("no invent IFC")
}

/// `PRIZE_ATTACHMENT_KEYS`.
const PRIZE_ATTACHMENT_KEYS: [&str; 9] = [
    "prize",
    "prizePool",
    "prizeAmount",
    "ifcPrize",
    "payout",
    "escrowAmount",
    "poolBalance",
    "amount",
    "ifcAmount",
];

fn reject_prize_attachment_keys(fields: &[(String, Value)]) -> Result<(), TournamentError> {
    for key in PRIZE_ATTACHMENT_KEYS {
        if fields.iter().any(|(k, v)| k == key && !nullish(v)) {
            return Err(TournamentError::new(MESSAGE, "academy.season_invalid"));
        }
    }
    Ok(())
}

/// `assertNoPrizeAttachment`: a prize-shaped key on the payload, or on a row of its `standings`, refuses.
pub fn assert_no_prize_attachment(payload: &Value) -> Result<(), TournamentError> {
    let fields: &[(String, Value)] = match payload {
        Value::Object(f) => f,
        // An array is an object in JavaScript; its indices are never a prize key.
        _ => return Ok(()),
    };
    reject_prize_attachment_keys(fields)?;
    let Some(Value::Array(rows)) = fields
        .iter()
        .find(|(k, _)| k == "standings")
        .map(|(_, v)| v)
    else {
        return Ok(());
    };
    for row in rows {
        if let Value::Object(f) = row {
            reject_prize_attachment_keys(f)?;
        }
    }
    Ok(())
}

/// `isPrizeRefuseClosed`.
pub fn is_prize_refuse_closed(d: &PrizeDecision) -> bool {
    d.status == "refuse" && d.code == PRIZE_REFUSE_CODE && !d.ledger_recipe_ready
}

/// `isPrizePoolUnsetRefuse`.
pub fn is_prize_pool_unset_refuse(d: &PrizeStartDecision) -> bool {
    d.status == "refuse" && d.code == PRIZE_POOL_UNSET_CODE && d.reason == StartReason::Unset
}

/// `prizeRefuseStatusLine`.
pub fn prize_refuse_status_line() -> String {
    format!(
        "prizes=refuse_closed code={PRIZE_REFUSE_CODE} unset={PRIZE_POOL_UNSET_CODE} ledger=0 inventIfc=0"
    )
}

/// `prizePoolStartRefuseExportLine`.
pub fn prize_pool_start_refuse_export_line(d: &PrizeStartDecision) -> String {
    format!("{},{}", d.reason.as_str(), d.code)
}

/// `prizePoolStartRefuseExportHeader`.
pub fn prize_pool_start_refuse_export_header() -> &'static str {
    "reason,code"
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
pub(crate) mod tests {
    //! `tournaments/prize-refuse.test.ts` and the prize half of `tournaments/wire-lifecycle.test.ts`.
    use super::*;

    pub fn obj(fields: &[(&str, Value)]) -> Value {
        Value::Object(
            fields
                .iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone()))
                .collect(),
        )
    }

    pub fn s(v: &str) -> Value {
        Value::String(v.to_owned())
    }

    fn has_decimal(text: &str) -> bool {
        let b = text.as_bytes();
        b.windows(3)
            .any(|w| w[0].is_ascii_digit() && w[1] == b'.' && w[2].is_ascii_digit())
    }

    #[test]
    fn refuses_fund_payout_escrow_clawback_invent() {
        for d in [
            refuse_fund_prize_pool(),
            refuse_prize_payout(),
            refuse_prize_escrow(),
            refuse_prize_clawback(),
            refuse_invent_prize_balance(),
            decide_prize_intent(PrizeIntentKind::FundPool),
        ] {
            assert_eq!(d.status, "refuse");
            assert_eq!(d.code, PRIZE_REFUSE_CODE);
            assert!(!d.academy_holds_prize_balance);
            assert!(!d.ledger_recipe_ready);
            assert!(is_prize_refuse_closed(&d));
            assert!(d.message.contains("refuse-closed"));
        }
    }

    #[test]
    fn allows_rank_only_freeze_payloads() {
        assert!(
            assert_no_prize_attachment(&obj(&[
                ("seasonId", s("s1")),
                ("standings", Value::Array(vec![])),
                ("frozenAt", Value::Date(Some(0))),
            ]))
            .is_ok()
        );
        assert!(assert_no_prize_attachment(&Value::Null).is_ok());
    }

    #[test]
    fn throws_on_invent_prize_fields() {
        for payload in [
            obj(&[("prize", s("10.00"))]),
            obj(&[("prizePool", obj(&[("amount", s("1"))]))]),
            obj(&[("ifcPrize", Value::Number(1.0))]),
            obj(&[("payout", Value::Bool(true))]),
            obj(&[("escrowAmount", s("0"))]),
            obj(&[("poolBalance", s("0"))]),
        ] {
            assert!(assert_no_prize_attachment(&payload).is_err());
        }
    }

    #[test]
    fn rejects_amount_ifc_amount_and_a_prize_nested_in_standings() {
        for payload in [
            obj(&[("amount", s("1000.00"))]),
            obj(&[("ifcAmount", s("10.00"))]),
            obj(&[(
                "standings",
                Value::Array(vec![obj(&[("prize", s("10.00"))])]),
            )]),
        ] {
            assert_eq!(
                assert_no_prize_attachment(&payload).unwrap_err().code,
                "academy.season_invalid"
            );
        }
        assert!(
            assert_no_prize_attachment(&obj(&[
                ("seasonId", s("s1")),
                (
                    "standings",
                    Value::Array(vec![obj(&[
                        ("seasonId", s("s1")),
                        ("userId", s("u1")),
                        ("score", Value::Number(3.0)),
                        ("rank", Value::Number(1.0)),
                    ])])
                ),
            ]))
            .is_ok()
        );
    }

    #[test]
    fn status_line_is_honest() {
        assert_eq!(
            prize_refuse_status_line(),
            format!(
                "prizes=refuse_closed code={PRIZE_REFUSE_CODE} unset={PRIZE_POOL_UNSET_CODE} ledger=0 inventIfc=0"
            )
        );
        // wire-lifecycle.test.ts: the literal line.
        assert_eq!(
            prize_refuse_status_line(),
            "prizes=refuse_closed code=academy.prize_refuse_closed unset=academy.prize_pool_unset ledger=0 inventIfc=0"
        );
    }

    #[test]
    fn detects_blank_or_missing_pool_as_unset() {
        for unset in [
            Value::Null,
            Value::Undefined,
            s(""),
            s("   "),
            obj(&[]),
            obj(&[("amount", Value::Null)]),
            obj(&[("amount", s(""))]),
            obj(&[("prizePool", s("  "))]),
            Value::Number(0.0),
        ] {
            assert!(is_prize_pool_unset(&unset), "{unset:?}");
        }
        assert!(!is_prize_pool_unset(&obj(&[("amount", s("100.00"))])));
        assert!(!is_prize_pool_unset(&s("250.50")));
    }

    #[test]
    fn blank_prize_pool_cannot_start() {
        let d = decide_prize_pool_start(&Value::Null);
        assert_eq!(d.status, "refuse");
        assert_eq!(d.code, PRIZE_POOL_UNSET_CODE);
        assert_eq!(d.reason, StartReason::Unset);
        assert!(!d.invented_ifc);
        assert!(!d.ledger_recipe_ready);
        assert!(is_prize_pool_unset_refuse(&d));
        assert!(d.message.contains("unset"));
        assert!(!d.to_json().compact().contains("\"amount\""));
    }

    #[test]
    fn present_amount_still_refuses_class_m() {
        let d = decide_prize_pool_start(&obj(&[("amount", s("1000.00"))]));
        assert_eq!(d.status, "refuse");
        assert_eq!(d.code, PRIZE_REFUSE_CODE);
        assert_eq!(d.reason, StartReason::ClassM);
        assert!(!d.invented_ifc);
        assert!(!is_prize_pool_unset_refuse(&d));
    }

    #[test]
    fn assert_may_start_refuses_without_invent_decimals() {
        let e = assert_may_start_prize_season(&Value::Undefined);
        assert_eq!(e.code, PRIZE_POOL_UNSET_CODE);
        let e = assert_may_start_prize_season(&s(""));
        assert_eq!(e.code, PRIZE_POOL_UNSET_CODE);
        assert_eq!(e.reason, StartReason::Unset);
        assert_eq!(e.residual, PRIZE_POOL_UNSET_RESIDUAL);
        assert!(prize_pool_unset_residual_is_honest(e.residual));
        // JSON.stringify(e) of an Error holds its own fields: code, residual, reason (and name).
        let text = format!("{}{}{}", e.code, e.residual, e.reason.as_str());
        assert!(!has_decimal(&text));
        let e = assert_may_start_prize_season(&obj(&[("amount", s("50.00"))]));
        assert_eq!(e.code, PRIZE_REFUSE_CODE);
        assert_eq!(e.reason, StartReason::ClassM);
        assert_eq!(e.residual, PRIZE_POOL_CLASS_M_RESIDUAL);
    }

    #[test]
    fn refuse_unset_start_is_typed_unset() {
        assert_eq!(refuse_unset_prize_pool_start().code, PRIZE_POOL_UNSET_CODE);
    }

    #[test]
    fn export_line_carries_reason_and_code_only() {
        let unset = try_refuse_prize_pool_start(&Value::Null);
        assert_eq!(prize_pool_start_refuse_export_header(), "reason,code");
        assert_eq!(
            prize_pool_start_refuse_export_line(&unset),
            format!("unset,{PRIZE_POOL_UNSET_CODE}")
        );
        let set = try_refuse_prize_pool_start(&s("10"));
        assert_eq!(
            prize_pool_start_refuse_export_line(&set),
            format!("class_m,{PRIZE_REFUSE_CODE}")
        );
    }

    /// The TypeScript pins its own source; this pins this file's.
    #[test]
    fn source_still_pins_unset_and_never_returns_ok() {
        let src = include_str!("prize.rs");
        assert!(
            src.contains("pub const PRIZE_POOL_UNSET_CODE: &str = \"academy.prize_pool_unset\";")
        );
        assert!(src.contains("pub fn decide_prize_pool_start"));
        assert!(src.contains("pub fn refuse_fund_prize_pool"));
        assert!(src.contains("pub fn assert_may_start_prize_season"));
        let ok = ["status: \"", "ok\""].concat();
        assert!(!src.contains(&ok));
        for invented in ["PRIZE", "POOL", "IFC"] {
            assert!(!src.contains(&["DEFAULT_", invented].concat()));
        }
        assert!(!src.contains(&["invented_ifc: ", "true"].concat()));
        assert!(src.contains("invented_ifc: false"));
    }

    #[test]
    fn start_refuses_every_unset_pool() {
        for unset in [
            Value::Null,
            Value::Undefined,
            s(""),
            s("   "),
            obj(&[]),
            obj(&[("amount", Value::Null)]),
            obj(&[("amount", s(""))]),
        ] {
            let d = decide_prize_pool_start(&unset);
            assert_eq!(d.status, "refuse");
            assert_eq!(d.code, PRIZE_POOL_UNSET_CODE);
            assert_eq!(d.reason, StartReason::Unset);
            assert!(!d.invented_ifc);
            assert!(!d.ledger_recipe_ready);
            let text = d.to_json().compact();
            assert!(!text.contains("\"amount\"") && !text.contains("\"prizePool\""));
            assert_eq!(
                assert_may_start_prize_season(&unset).code,
                PRIZE_POOL_UNSET_CODE
            );
        }
    }

    #[test]
    fn fund_refuses_with_no_invented_credit() {
        let d = refuse_fund_prize_pool();
        assert_eq!(d.status, "refuse");
        assert_eq!(d.code, PRIZE_REFUSE_CODE);
        assert_eq!(d.kind, PrizeIntentKind::FundPool);
        assert!(!d.academy_holds_prize_balance);
        assert!(!d.ledger_recipe_ready);
        let text = d.to_json().compact();
        assert!(!text.contains("\"amount\""));
        assert!(!has_decimal(&text));
    }

    #[test]
    fn every_intent_refuses_closed_with_no_amount() {
        for kind in PrizeIntentKind::ALL {
            let d = decide_prize_intent(kind);
            assert!(is_prize_refuse_closed(&d));
            assert!(!d.academy_holds_prize_balance && !d.ledger_recipe_ready);
            let text = d.to_json().compact();
            assert!(!text.contains("\"amount\"") && !text.contains("\"prizeAmount\""));
        }
    }
}
