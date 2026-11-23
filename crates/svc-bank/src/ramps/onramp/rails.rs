//! The ramp programme and the fiat leg's pay adapters (`ramps/rails.ts`, `ramps/pay-fiat-adapter.ts`).
//!
//! The setting chooses the CRYPTO ledger half only (`BANK_RAMP_MODE`: `none` or `crypto-ledger`); no value turns on a
//! fiat rail or claims a live chain send, so `simulated` is always true. Fiat is `socket.psp-partners`: kind fiat
//! refuses `bank.fiat_ramp_socket` before any row or ledger post. A pay adapter's live rail is named, never stored as a
//! fiat ramp and never posted.

use service_kit::json::Json;

use crate::errors::Refusal;
use crate::partner::refuse;

/// One ramp programme (`RampProgramme`): `simulated` is always true, `fiatLeg` and `fiatVia` always the socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Programme {
    pub id: &'static str,
    pub display_name: &'static str,
    /// The ledger rail of the crypto half, or none.
    pub crypto_rail: Option<&'static str>,
}

/// `BANK_CRYPTO_LEDGER_RAIL`: not svc-pay's `crypto-native` boundary.
pub const BANK_CRYPTO_LEDGER_RAIL: &str = "bank-crypto-ledger";

/// `NO_RAMP_PROGRAMME`.
pub const NONE: Programme = Programme {
    id: "none",
    display_name: "No bank ramp programme",
    crypto_rail: None,
};

/// `CRYPTO_LEDGER_PROGRAMME`.
pub const CRYPTO_LEDGER: Programme = Programme {
    id: "crypto-ledger",
    display_name: "Crypto ledger half (no chain broadcast; fiat via pay adapters / socket)",
    crypto_rail: Some(BANK_CRYPTO_LEDGER_RAIL),
};

/// `RAMP_SETTINGS`.
pub const SETTINGS: [&str; 2] = ["none", "crypto-ledger"];

/// `rampProgrammeFor`: silence (and anything the environment check let through but `crypto-ledger`) is `none`.
pub fn programme_for(setting: Option<&str>) -> Programme {
    if setting == Some("crypto-ledger") {
        CRYPTO_LEDGER
    } else {
        NONE
    }
}

impl Programme {
    /// The programme as `ramps.programme` answers it.
    pub fn json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id)),
            ("simulated", Json::Bool(true)),
            ("displayName", Json::str(self.display_name)),
            ("cryptoRail", self.crypto_rail.map_or(Json::Null, Json::str)),
            ("fiatLeg", Json::str("socket.psp-partners")),
            ("fiatVia", Json::str("svc-pay.RailAdapter")),
        ])
    }
}

/// `rampRails`: the rails the programme can name, each with its provider or `unset`.
pub fn rails(p: &Programme) -> [(&'static str, &'static str); 2] {
    [
        (
            p.crypto_rail.unwrap_or("crypto"),
            p.crypto_rail.unwrap_or("unset"),
        ),
        ("fiat", "unset"),
    ]
}

/// `assertCryptoRamp`: the ledger rail of the crypto half, or `bank.no_ramp_rail`.
pub fn assert_crypto(p: &Programme) -> Result<&'static str, Refusal> {
    p.crypto_rail.ok_or_else(|| {
        refuse(
            "bank.no_ramp_rail",
            "No bank ramp programme is configured — set BANK_RAMP_MODE=crypto-ledger for the crypto ledger half, or leave none and do not call ramps",
        )
    })
}

/// `refuseFiatRamp`.
pub fn refuse_fiat() -> Refusal {
    refuse(
        "bank.fiat_ramp_socket",
        "Fiat on/off ramp is socket.psp-partners — a bank/PSP partner and money-transmission permission, not inventable code. \
         Reuse a live svc-pay RailAdapter via PayFiatRampPort; do not invent APY, card BIN, or a bank-local PSP.",
    )
}

/// `assertFiatSocketWhenNone`.
pub fn assert_fiat_socket_when_none(p: &Programme) -> Result<(), Refusal> {
    if p.id == "none" || p.crypto_rail.is_none() {
        return Err(refuse_fiat());
    }
    Ok(())
}

/// `liveRamp`: a live cash ramp is refused.
pub fn live_ramp_unset() -> Refusal {
    refuse(
        "bank.live_ramp_unset",
        "A live cash ramp is refused. The missing piece is an outside company, the cash rail.",
    )
}

/// One pay rail as svc-pay names it (`PayFiatRailSnapshot`): `mode` is `live`, `sandbox` or `absent`; capabilities are
/// `onramp` and `offramp`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RailSnapshot {
    pub rail_id: String,
    pub mode: String,
    pub capabilities: Vec<String>,
}

impl RailSnapshot {
    pub fn new(rail_id: &str, mode: &str, capabilities: &[&str]) -> RailSnapshot {
        RailSnapshot {
            rail_id: rail_id.to_owned(),
            mode: mode.to_owned(),
            capabilities: capabilities.iter().map(|c| (*c).to_owned()).collect(),
        }
    }
}

/// `PayFiatRampPort`: svc-pay's fiat rails, as the process edge hands them in.
pub trait PayFiat: Send + Sync {
    fn list(&self) -> Result<Vec<RailSnapshot>, Refusal>;
}

/// `emptyPayFiatRampPort`: the boot default.
pub struct EmptyPayFiat;

impl PayFiat for EmptyPayFiat {
    fn list(&self) -> Result<Vec<RailSnapshot>, Refusal> {
        Ok(Vec::new())
    }
}

/// A fixed list of rails (`{ listFiatRails: () => rails }`).
pub struct FixedPayFiat(pub Vec<RailSnapshot>);

impl PayFiat for FixedPayFiat {
    fn list(&self) -> Result<Vec<RailSnapshot>, Refusal> {
        Ok(self.0.clone())
    }
}

/// `IN_REPO_PAY_FIAT_RAILS`: none of these can honestly move fiat.
pub fn in_repo_rails() -> Vec<RailSnapshot> {
    vec![
        RailSnapshot::new("crypto-native", "sandbox", &[]),
        RailSnapshot::new("card-sandbox", "sandbox", &["onramp"]),
        RailSnapshot::new("bank-payout", "absent", &["offramp"]),
    ]
}

/// `selectLivePayFiatRail`: the first live rail with the capability and a name.
pub fn select_live<'r>(rails: &'r [RailSnapshot], capability: &str) -> Option<&'r RailSnapshot> {
    rails.iter().find(|r| {
        r.mode == "live"
            && r.capabilities.iter().any(|c| c == capability)
            && !service_kit::money::js_trim(&r.rail_id).is_empty()
    })
}

/// `assertEmptyRailsCannotLookLive`.
pub fn assert_empty_rails_cannot_look_live(
    rails: &[RailSnapshot],
    simulated: bool,
    looks_live: bool,
) -> Result<(), Refusal> {
    let can_settle =
        select_live(rails, "onramp").is_some() || select_live(rails, "offramp").is_some();
    if (!simulated || looks_live) && !can_settle {
        return Err(refuse(
            "bank.fiat_ramp_no_pay_adapter",
            "A fiat ramp cannot look live when no svc-pay adapter can settle fiat — rails empty, sandbox, or absent. \
             No invented FX. Socket remains socket.psp-partners.",
        ));
    }
    Ok(())
}

/// `resolvePayFiatRailId`: the live rail's id, or a refusal naming the socket and what was considered.
pub fn resolve_rail_id(port: &dyn PayFiat, capability: &str) -> Result<String, Refusal> {
    let rails = port.list()?;
    if let Some(live) = select_live(&rails, capability) {
        return Ok(live.rail_id.clone());
    }
    let summary = if rails.is_empty() {
        "no pay fiat rails registered (empty PayFiatRampPort / unset edge wire)".to_owned()
    } else {
        rails
            .iter()
            .map(|r| {
                let caps = if r.capabilities.is_empty() {
                    "∅".to_owned()
                } else {
                    r.capabilities.join("|")
                };
                format!("{}:{}[{caps}]", r.rail_id, r.mode)
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    if rails.is_empty() {
        return Err(refuse(
            "bank.fiat_ramp_no_pay_adapter",
            format!(
                "Fiat {capability} is socket.psp-partners — a bank/PSP partner and money-transmission permission, not inventable code. \
                 PayFiatRampPort is empty (unset edge wire / emptyPayFiatRampPort). No invented FX rate. Considered: {summary}."
            ),
        ));
    }
    Err(refuse(
        "bank.no_fiat_rail",
        format!(
            "Fiat {capability} has no live fiat rail on the injected svc-pay adapter. \
             Sandbox/absent/capability-miss rails cannot host bank fiat; do not invent a PSP. \
             No invented FX rate. Socket remains socket.psp-partners. Considered: {summary}."
        ),
    ))
}
