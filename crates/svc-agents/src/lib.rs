//! svc-agents in Rust (`PORT.md`). `services/svc-agents` stays the service that runs until the switch; nothing is
//! served from this crate in any stack yet.
//!
//! The door (`door`) holds every call of the TypeScript router: who may call it, the checks its middleware runs before
//! the input is read, its input check, and the person checks its handler runs first after it, held to the TypeScript's
//! recorded answers by `tests/wire_replay.rs`. Past those checks a call is owed by its slice (`door::Slice`). `env` is
//! the environment, `errors` the refusals and how the router's guard answers them. The store: `db` (the pool),
//! `migrate` (the `agents` schema's migrations), `boot` (the schema check and the agents' guardrails upserted at boot)
//! and `timers` (what `index.ts` runs on a period); the binary (`main.rs`) puts them together.

pub mod advisors;
pub mod audit;
pub mod background;
pub mod boot;
pub mod db;
pub mod door;
pub mod env;
pub mod errors;
pub mod errors_table;
pub mod factories;
pub mod gateway;
pub mod metering;
pub mod migrate;
pub mod refines;
pub mod runtime;
pub mod self_freeze;
pub mod timers;
