//! svc-academy in Rust: the Academy's live lobbies, curriculum, courses, assessments, certificates, community and
//! programmes, ported from `services/svc-academy` one slice at a time behind a door that answers every call as the
//! TypeScript router does.
//!
//! The door (`door`) holds every call: who may call it, its input check and how its refusals become answers, held to
//! the TypeScript's recorded answers by `tests/wire_replay.rs`. Each slice (`slices`) answers its own calls; a call not
//! ported yet refuses as not ported. `ports` names what the service asks outside itself, `db` its database, `errors`
//! its refusals, `env` its environment and `settings` the owner settings register.

pub mod access;
pub mod community;
pub mod curriculum;
pub mod db;
pub mod door;
pub mod env;
pub mod errors;
pub mod identity_approvals;
pub mod learner;
pub mod lobbies;
pub mod migrate;
pub mod ports;
pub mod programme;
pub mod refines;
pub mod settings;
pub mod slices;
