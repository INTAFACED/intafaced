//! Who answers a global send (`personal-pay/ports.ts` `GlobalPorts`): the corridor catalogue, the BIC directory, the
//! rate source, the payout rail and the owner's travel-rule decision. An empty port is not a catalogue, not a rate and
//! not a rail: its status is unset and the service refuses by name before it asks it anything (`EmptyPorts`). The
//! only other answer today is the TEST stand-in (`sim`).

/// `PortStatus`: `live`, or unset.
pub type Live = bool;

/// `SWIFT_CHARGES`.
pub const SWIFT_CHARGES: [&str; 3] = ["SHA", "OUR", "BEN"];

/// `Corridor`: a destination the catalogue publishes, as the partner answers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Corridor {
    pub country: String,
    pub currency: String,
    pub delivery_methods: Vec<String>,
    pub min_amount: Option<String>,
    pub max_amount: Option<String>,
    pub cut_off_time: Option<String>,
    pub swift_charges: Option<String>,
}

/// `BicHit`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BicHit {
    pub bic: String,
    pub bank_name: String,
}

/// `FxQuote`: the provider's strings, never recomputed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FxQuote {
    pub rate: String,
    pub fee: String,
    pub fee_asset: String,
    pub receive_amount: String,
    pub valid_until: String,
    pub eta: String,
}

/// What the payout rail is asked to pay (`PayoutRailPort.submit`'s input).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Payout {
    pub send_id: String,
    pub idempotency_key: String,
    pub amount: String,
    pub asset_id: String,
    pub to_currency: String,
    pub recipient_id: String,
    pub quote_id: String,
    pub rate: String,
    pub receive_amount: String,
}

/// `PayoutAnswer`: refused, or accepted with the provider's reference and status (checked by the service).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PayoutAnswer {
    Refused,
    Accepted {
        provider_ref: String,
        status: String,
    },
}

/// `StandInPayout`: the TEST stand-in's own record of one send it paid out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StandInPayout {
    pub send_id: String,
    pub quote_id: String,
    pub asset_id: String,
    pub amount: String,
    pub to_currency: String,
    pub rate: String,
    pub receive_amount: String,
    pub conversions: i64,
    pub calls: i64,
}

/// `TravelRuleDecision`: who decided and the fields a send must carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TravelRuleDecision {
    pub decided_by: String,
    pub required_fields: Vec<String>,
}

/// `GlobalPorts`. A method that fails is the provider failing (a thrown error in the TypeScript); its words are for the
/// log only.
pub trait GlobalPorts: Send + Sync {
    /// `standIn.label`: set only by the TEST stand-in.
    fn stand_in(&self) -> Option<String> {
        None
    }
    /// `standIn.payout(sendId)`.
    fn stand_in_payout(&self, _send_id: &str) -> Option<StandInPayout> {
        None
    }
    /// `review.waits(send)`: `None` when there is no review port (only the stand-in has one).
    fn review_waits(&self, _asset_id: &str, _amount: &str) -> Option<bool> {
        None
    }
    fn corridors_live(&self) -> Live;
    fn corridors(&self) -> Result<Vec<Corridor>, String>;
    fn bic_live(&self) -> Live;
    fn bic_lookup(&self, bic: &str) -> Result<Option<BicHit>, String>;
    fn fx_live(&self) -> Live;
    fn fx_quote(&self, asset: &str, amount: &str, to_currency: &str) -> Result<FxQuote, String>;
    fn payout_live(&self) -> Live;
    /// `payout.covers(corridor)`: `None` when the partner names no coverage, so it covers every corridor; `Err` is an
    /// answer the service cannot read.
    fn payout_covers(
        &self,
        _country: &str,
        _currency: &str,
        _delivery_method: &str,
    ) -> Option<Result<bool, String>> {
        None
    }
    /// `payout.railId()`: an unset rail fails.
    fn payout_rail_id(&self) -> Result<String, String>;
    fn payout_submit(&self, payout: &Payout) -> Result<PayoutAnswer, String>;
    /// `travelRule.decision()`: none while it has not been decided.
    fn travel_rule(&self) -> Option<TravelRuleDecision>;
}

/// `emptyGlobalPorts`: every port unset, and every ask of one fails by its own name.
pub struct EmptyPorts;

impl GlobalPorts for EmptyPorts {
    fn corridors_live(&self) -> Live {
        false
    }
    fn corridors(&self) -> Result<Vec<Corridor>, String> {
        Err("corridor catalogue is unset".to_owned())
    }
    fn bic_live(&self) -> Live {
        false
    }
    fn bic_lookup(&self, _bic: &str) -> Result<Option<BicHit>, String> {
        Err("BIC directory is unset".to_owned())
    }
    fn fx_live(&self) -> Live {
        false
    }
    fn fx_quote(&self, _: &str, _: &str, _: &str) -> Result<FxQuote, String> {
        Err("FX source is unset".to_owned())
    }
    fn payout_live(&self) -> Live {
        false
    }
    fn payout_rail_id(&self) -> Result<String, String> {
        Err("payout rail is unset".to_owned())
    }
    fn payout_submit(&self, _: &Payout) -> Result<PayoutAnswer, String> {
        Err("payout rail is unset".to_owned())
    }
    fn travel_rule(&self) -> Option<TravelRuleDecision> {
        None
    }
}
