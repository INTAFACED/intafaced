//! svc-academy: the Academy's live lobbies, curriculum, courses, assessments, certificates, community and programmes,
//! behind a door that answers every call as the TypeScript router did. It replaced the TypeScript service
//! (`services/svc-academy`, ported one slice at a time and deleted in the change that made this one serve; read it in
//! git history before that merge); what the TypeScript answered is kept as the reference this service is held to.
//!
//! The door (`door`) holds every call: who may call it, its input check and how its refusals become answers, held to
//! the TypeScript's recorded answers by `tests/wire_replay.rs`. Each slice (`slices`) answers its own calls; a call not
//! ported yet refuses as not ported. `ports` names what the service asks outside itself, `db` its database, `errors`
//! its refusals, `env` its environment and `settings` the owner settings register.

pub mod access;
pub mod assessment;
pub mod authoring;
pub mod certs;
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
