//! svc-blueprint: the Identity Blueprint (onboarding profile, crew placement, mentor shortlist, share card, export and
//! erase). The Rust port of `services/svc-blueprint`, one slice at a time (`PORT.md`); nothing is served from it yet.
//!
//! The door (`door`) holds every call of svc-blueprint's records: who may call it and its input check, held to the
//! TypeScript's recorded answers by `tests/wire_replay.rs`. Past those checks a call is its slice's (`door::Slice`).
//! `env` is the environment, `errors` the refusals and how the router answers them, `refines` the input schemas' own
//! checks, `db` the pool and `migrate` the migrations. `profile` and `card` are the ported slices; `zero_pii` is the bar the card's surfaces pass.

pub mod card;
pub mod db;
pub mod door;
pub mod env;
pub mod errors;
pub mod migrate;
pub mod profile;
pub mod refines;
pub mod zero_pii;
