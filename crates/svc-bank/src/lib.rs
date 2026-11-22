//! svc-bank in Rust (`PORT.md`). `services/svc-bank` stays the service that runs until the switch; nothing is served
//! from this crate in any stack yet.
//!
//! The door (`door`) holds every call of the TypeScript router and the REST doors `index.ts` mounts through an exported
//! register function: who may call each, and its input check, held to the TypeScript's recorded answers by
//! `tests/wire_replay.rs`. Past those checks a call is owed by its slice (`door::Slice`). `env` is the environment,
//! `errors` the refusals and how the router's guard answers them. Each ported slice is its own module
//! (`credit_previews`, `partner`, `spaces`, `transfers`, `earn`, `loans`, `activity`, `cards`, `ramps`; the TEST age door, `test_age`, is the partner slice's). The store: `db` (the pool and the schema check), `migrate` (the `bank` schema's migrations),
//! `ready` (`/ready`), `restore_watermark` (svc-ops' restore position), `recovery` (the recovery jobs' lock and pass)
//! and `timers` (what else `index.ts` runs on a period); the binary (`main.rs`) puts them together.

pub mod activity;
pub mod cards;
pub mod credit_previews;
pub mod db;
pub mod door;
pub mod earn;
pub mod env;
pub mod errors;
pub mod errors_table;
pub mod loans;
pub mod migrate;
pub mod ops_approval;
pub mod ops_desk;
pub mod partner;
pub mod ramps;
pub mod ready;
pub mod recovery;
pub mod refines;
pub mod restore_watermark;
pub mod spaces;
pub mod test_age;
pub mod timers;
pub mod transfers;
