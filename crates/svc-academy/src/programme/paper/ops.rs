//! The paper drills' ops switch (`paper/ops-gate.ts`): ops can stop drills without touching live trade. No prices,
//! fills, balances or postings here.

use service_kit::json::Json;

use crate::errors::{AcademyError, Refusal};
use crate::settings::Settings;

/// `PAPER_OPS_ENV_KEY`.
pub const PAPER_OPS_ENV_KEY: &str = "ACADEMY_PAPER_TRADING_ENABLED";
/// `PAPER_OPS_FLAG_ID`.
pub const PAPER_OPS_FLAG_ID: &str = "academy.paper-trading";

/// The `paperTradingEnabled` option as the service was given it (`env.ACADEMY_PAPER_TRADING_ENABLED`): `None` when
/// unset (the replay's `{}` options).
pub fn enabled_option(settings: &Settings) -> Option<bool> {
    match settings.0.get(PAPER_OPS_ENV_KEY) {
        Some(Json::Bool(b)) => Some(*b),
        _ => None,
    }
}

/// `isPaperOpsEnabled`: on unless set to `false`.
pub fn is_paper_ops_enabled(enabled: Option<bool>) -> bool {
    enabled != Some(false)
}

/// `PaperOpsStatus`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaperOpsStatus {
    pub enabled: bool,
    pub flag_id: &'static str,
    pub env_key: &'static str,
    pub live_trade_unaffected: bool,
    pub simulated: bool,
    pub venue: &'static str,
    pub real_money: bool,
}

/// `paperOpsStatus(enabled)`.
pub fn paper_ops_status(enabled: Option<bool>) -> PaperOpsStatus {
    PaperOpsStatus {
        enabled: is_paper_ops_enabled(enabled),
        flag_id: PAPER_OPS_FLAG_ID,
        env_key: PAPER_OPS_ENV_KEY,
        live_trade_unaffected: true,
        simulated: true,
        venue: "paper",
        real_money: false,
    }
}

impl PaperOpsStatus {
    /// The object as `paperOpsStatus` returns it, keys in its order.
    pub fn json(&self) -> Json {
        Json::obj([
            ("enabled", Json::Bool(self.enabled)),
            ("flagId", Json::str(self.flag_id)),
            ("envKey", Json::str(self.env_key)),
            (
                "liveTradeUnaffected",
                Json::Bool(self.live_trade_unaffected),
            ),
            ("simulated", Json::Bool(self.simulated)),
            ("venue", Json::str(self.venue)),
            ("realMoney", Json::Bool(self.real_money)),
        ])
    }
}

/// `paperOpsDisabledMessage()`.
pub fn paper_ops_disabled_message() -> &'static str {
    "Paper trading drills are disabled by ops — live trade unchanged."
}

/// `AcademyService.assertPaperTradingEnabled`.
pub fn assert_paper_trading_enabled(enabled: Option<bool>) -> Result<(), Refusal> {
    if is_paper_ops_enabled(enabled) {
        Ok(())
    } else {
        Err(AcademyError::new(
            paper_ops_disabled_message(),
            "academy.paper_trading_disabled",
        )
        .into())
    }
}
