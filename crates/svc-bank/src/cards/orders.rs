//! Slice `cards`' orders calls: not ported yet in this commit.

use service_kit::json::Json;

use super::Deps;
use crate::door::Ctx;
use crate::errors::Refusal;

/// This part's calls, or `None` for a call it does not hold.
pub fn answer(_d: &Deps<'_>, _ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    None
}

/// `cardOrders.afterReplace`: a replaced physical card's delivery follows it.
pub fn after_replace(_d: &Deps<'_>, _card: &super::Card) -> Result<(), Refusal> {
    Ok(())
}
