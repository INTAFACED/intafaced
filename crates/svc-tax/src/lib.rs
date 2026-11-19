//! svc-tax: the per-jurisdiction lot export and the profit and loss indicator over the caller's own ledger reads. It
//! holds no balance and posts nothing. The binary (`main.rs`) serves tRPC over HTTP (`server.rs`, `wire.rs`) and applies
//! the `tax` schema's migrations (`svc-tax migrate`); `service.rs` builds every port once at start-up.
//!
//! It replaced the TypeScript service (`services/svc-tax`, deleted in the change that made this one run; read it in git
//! history before that merge). A TypeScript file named in a comment here (`lot-book.ts`) was that service's. What the
//! TypeScript answered is kept as the reference this service is held to byte for byte: the wire replay
//! (`tests/wire_replay.rs`), the service parity corpus (`tests/service_parity.rs`), the I/O golden (`tests/io_golden.rs`),
//! the export (`tests/export_parity.rs`) and zod's input checks (`tests/input_parity.rs`).

pub mod access;
pub mod basis;
pub mod choices;
pub mod clients;
pub mod edge;
pub mod env;
pub mod http;
pub mod inputs;
pub mod json;
pub mod lot_book;
pub mod lot_engine;
pub mod lots;
pub mod money;
pub mod own_moves;
pub mod pnl_over_time;
pub mod ports;
pub mod posture;
pub mod ready;
pub mod s2s;
pub mod server;
pub mod service;
pub mod stores;
pub mod tax;
pub mod telemetry;
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
