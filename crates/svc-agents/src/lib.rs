//! svc-agents in Rust: the shell every slice of the port builds on (`PORT.md`). `services/svc-agents` stays the service
//! that runs until the switch; nothing is served from this crate yet.
//!
//! The door (`door`) holds every call of the TypeScript router: who may call it, the checks its middleware runs before
//! the input is read, its input check, and the person checks its handler runs first after it, held to the TypeScript's
//! recorded answers by `tests/wire_replay.rs`. Past those checks a call is owed by its slice (`door::Slice`). `env` is
//! the environment, `errors` the refusals and how the router's guard answers them.

pub mod door;
pub mod env;
pub mod errors;
pub mod errors_table;
pub mod refines;
