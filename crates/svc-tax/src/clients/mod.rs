//! svc-tax's HTTP clients: one per service it reads, each implementing its port (`ports.rs`).

pub mod bank;
pub mod ledger;
pub mod prices;
pub mod venue;
