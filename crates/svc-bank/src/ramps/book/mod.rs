//! The address book (`PORT.md`, slice `ramps`). Being ported.
//!
//! - `store`: the legacy slot and the saved entries (`withdraw-destination.ts`).
//! - `fraud`: the owner's destination fraud list and the desk's calls on it (`ramps/fraud-list.ts`).
//! - `ports`: identity's approval mail and trusted devices.

pub mod fraud;
pub mod ports;
pub mod store;

use service_kit::json::Json;
use service_kit::trpc::TrpcError;

use crate::door::Ctx;

use super::Deps;

/// What the door holds for the address book, built once at start-up: identity's mail door and trusted devices.
pub struct Wiring {
    pub mail: Box<dyn ports::ApprovalMail>,
    pub devices: Box<dyn ports::TrustedDevices>,
}

impl Wiring {
    /// No `IDENTITY_URL`: every approval mail and every device read refuses.
    pub fn none() -> Wiring {
        Wiring {
            mail: Box::new(ports::NoIdentity),
            devices: Box::new(ports::NoIdentity),
        }
    }
}

/// The address book's calls; `None` for any other path.
pub fn answer(_d: &Deps<'_>, _ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    None
}
