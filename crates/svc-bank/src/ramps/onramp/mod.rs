//! The on-ramp and add money (`PORT.md`, slice `ramps`). Being ported.

use service_kit::json::Json;
use service_kit::trpc::TrpcError;

use crate::door::Ctx;

use super::Deps;

/// What the door holds for the on-ramp, built once at start-up.
pub struct Wiring {}

impl Wiring {
    pub fn none() -> Wiring {
        Wiring {}
    }
}

/// The on-ramp's calls; `None` for any other path.
pub fn answer(_d: &Deps<'_>, _ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    None
}

/// `POST /internal/jobs/payin-sim/{paid,returned}`, past the job door's signature: the pay-in stand-in's word.
pub fn job(
    door: &crate::door::BankDoor,
    path: &str,
    _body: &service_kit::schema::Value,
) -> service_kit::server::Response {
    let _ = (door, path);
    service_kit::server::Response {
        status: 500,
        body: Json::obj([(
            "error",
            Json::str("svc-bank in Rust: the ramps slice is not ported"),
        )])
        .compact(),
    }
}

/// The pay-in stand-in's TEST page (`/test/payin-sim/pay/:onrampId`, `.../approve`) and the loopback TEST ramp
/// partner's record doors (`/test-ramp-partner/{venue,report,age}`); `None` for any other request.
pub fn doors(
    door: &crate::door::BankDoor,
    req: &service_kit::server::Request<'_>,
    peer: &str,
) -> Option<service_kit::server::Response> {
    let _ = (door, req, peer);
    None
}
