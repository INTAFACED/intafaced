//! `bankAccount.*` (`onboarding/`).
//! Not ported yet: every function answers `None`, so the door answers "not ported".

use std::collections::BTreeMap;

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::server::Response;

use super::Deps;
use crate::door::Ctx;
use crate::errors::Refusal;

/// What this part holds, built once from the environment.
pub struct Wiring {}

impl Wiring {
    pub fn from_env(_env: &BTreeMap<String, String>) -> Result<Wiring, String> {
        Ok(Wiring {})
    }
}

/// The answer of one of this part's calls, by its path; `None` for a path outside it.
pub fn answer(_d: &Deps<'_>, _ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    None
}

/// The answer of one of this part's job doors past its signature, by its path; `None` for a path outside it.
pub fn job(_d: &Deps<'_>, _path: &str, _body: &Value) -> Option<Response> {
    None
}
