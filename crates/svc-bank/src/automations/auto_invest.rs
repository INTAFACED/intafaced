//! Part `auto_invest` of the automations slice: not ported yet.

use service_kit::json::Json;
#[allow(unused_imports, reason = "the stub the part replaces")]
use service_kit::schema::Value;
#[allow(unused_imports, reason = "the stub the part replaces")]
use service_kit::server::Response;

use super::Deps;
use crate::door::Ctx;
use crate::errors::Refusal;

/// What the binary hands this part.
#[derive(Default)]
pub struct Wiring {}

impl Wiring {
    pub fn none() -> Wiring {
        Wiring::default()
    }
}

/// This part's calls; `None` for any other call, or one not ported.
pub fn answer(_d: &Deps<'_>, _ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    None
}

/// This part's job doors past the signature; `None` for any other path.
pub fn job(_d: &Deps<'_>, _path: &str, _body: &Value) -> Option<Response> {
    None
}
