//! svc-tax in Rust, behind the replay of what the TypeScript service (`services/svc-tax`) answers: every request in
//! `services/svc-tax/src/wire-replay.golden.json` gets the same status and the same body, byte for byte
//! (`tests/wire_replay.rs`), and every input check gives zod's own verdict (`tests/input_parity.rs`).
//!
//! The TypeScript service is still the one that runs. What is here: the door (tRPC over HTTP, the edge principal, the
//! scope and jurisdiction guards, zod's input checks and error texts), the year export, and each call's named refusals.
//! What is not yet: the ledger fill reader the lot book and the result over time are built from, and the Postgres
//! stores for a customer's basis and cost-basis choices. Those calls refuse by name here, as the TypeScript service does
//! when they are not attached (`tax.ledger_unwired`, `tax.basis_store_unwired`).

pub mod access;
pub mod basis;
pub mod choices;
pub mod edge;
pub mod inputs;
pub mod json;
pub mod lot_book;
pub mod lot_engine;
pub mod lots;
pub mod money;
pub mod own_moves;
pub mod pnl_over_time;
pub mod ports;
pub mod tax;
pub mod time;
pub mod venue_book;
pub mod wire;
pub mod zod;

/// The service this crate becomes.
pub const SERVICE: &str = "svc-tax";

#[cfg(test)]
mod tests {
    use super::SERVICE;

    #[test]
    fn names_the_service_it_replaces() {
        assert_eq!(SERVICE, "svc-tax");
    }
}
