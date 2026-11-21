//! `copyIntel.*`: not ported yet; every call answers "not ported".

use service_kit::json::Json;

use super::Cx;
use crate::runtime::RunError;

/// The factory's live port.
pub trait LeaderFixtures: Send + Sync {}

/// Answers one `copyIntel.*` call.
pub fn handle(cx: &Cx<'_>, _call: &str) -> Result<Json, RunError> {
    Err(RunError::Trpc(crate::door::not_ported(cx.ctx.call.slice)))
}
