//! svc-tax: the per-jurisdiction lot export and the profit and loss indicator over the caller's own ledger reads. It
//! holds no balance and posts nothing. The binary (`main.rs`) serves tRPC over HTTP (`server.rs`, `wire.rs`) and applies
//! the `tax` schema's migrations (`svc-tax migrate`); `service.rs` builds every port once at start-up. The generic server
//! parts (JSON, time, the edge and S2S checks, telemetry, the server, the env slices, the pool, the runner) are the
//! kit's, `crates/service-kit`.
//!
//! It replaced the TypeScript service (`services/svc-tax`, deleted in the change that made this one run; read it in git
//! history before that merge). A TypeScript file named in a comment here (`lot-book.ts`) was that service's. What the
//! TypeScript answered is kept as the reference this service is held to byte for byte: the wire replay
//! (`tests/wire_replay.rs`), the service parity corpus (`tests/service_parity.rs`), the I/O golden (`tests/io_golden.rs`),
//! the export (`tests/export_parity.rs`) and zod's input checks (`tests/input_parity.rs`).

pub mod basis;
pub mod choices;
pub mod clients;
pub mod env;
pub mod inputs;
pub mod lot_book;
pub mod lot_engine;
pub mod lots;
pub mod own_moves;
pub mod pnl_over_time;
pub mod ports;
pub mod ready;
pub mod server;
pub mod service;
pub mod stores;
pub mod tax;
pub mod venue_book;
pub mod wire;

// The generic parts are the kit's (`crates/service-kit`); their paths here stay as they were.
pub use service_kit::{access, edge, http, json, money, posture, s2s, telemetry, time, zod};

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
