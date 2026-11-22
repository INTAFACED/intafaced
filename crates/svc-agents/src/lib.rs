//! svc-agents: the agent fleet runtime and model gateway, with exact per-user metering billed through the ledger.
//! It replaced the TypeScript service (`services/svc-agents`, ported one slice at a time and deleted in the change that
//! made this one serve; read it in git history; `README.md` holds the port notes).
//!
//! The door (`door`) holds every call the TypeScript router served: who may call it, the checks its middleware runs
//! before the input is read, its input check, and the person checks its handler runs first after it, held to the
//! TypeScript's recorded answers by `tests/wire_replay.rs`. Past those checks a call is its slice's (`door::Slice`). `env` is
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
pub mod navigator;
pub mod ops;
pub mod own;
pub mod refines;
pub mod runtime;
pub mod self_freeze;
pub mod team;
pub mod timers;
pub mod webhooks;
