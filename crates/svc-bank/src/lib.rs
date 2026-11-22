//! svc-bank in Rust (`PORT.md`). `services/svc-bank` stays the service that runs until the switch; nothing is served
//! from this crate in any stack yet.
//!
//! The door (`door`) holds every call of the TypeScript router and the REST doors `index.ts` mounts through an exported
//! register function: who may call each, and its input check, held to the TypeScript's recorded answers by
//! `tests/wire_replay.rs`. Past those checks a call is owed by its slice (`door::Slice`). `env` is the environment,
//! `errors` the refusals and how the router's guard answers them.

pub mod door;
pub mod env;
pub mod errors;
pub mod errors_table;
pub mod refines;
