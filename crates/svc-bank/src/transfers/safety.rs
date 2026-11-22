//! The slice's the region notice and the person's extra checks (`safety/`). Not ported yet.

use service_kit::json::Json;

use super::Deps;
use crate::door::Ctx;
use crate::errors::Refusal;

/// The answer of one of this part's calls, by its path; `None` for a path outside it.
pub fn answer(_d: &Deps<'_>, _ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    None
}
