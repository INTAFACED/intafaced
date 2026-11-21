//! This factory's port double for the parity cases.

use service_kit::json::Json;
use svc_agents::factories::Factories;

/// The factory's port built from a case's `port`.
pub fn ports(_port: &Json) -> Factories {
    Factories::unwired()
}
