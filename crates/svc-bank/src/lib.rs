//! svc-bank: multi-currency accounts over the ledger, with earn, loans, cards, ramps, transfers and the business bank.
//! It replaced the TypeScript service (`services/svc-bank`, ported one slice at a time and deleted in the change that
//! made this one serve; read it in git history; `README.md` holds the port notes).
//!
//! The door (`door`) holds every call the TypeScript router served and the REST doors its `index.ts` mounted: who may
//! call each, and its input check, held to the TypeScript's recorded answers by `tests/wire_replay.rs`. Past those
//! checks a call is its slice's (`door::Slice`). `env` is the environment,
//! `errors` the refusals and how the router's guard answers them. Each ported slice is its own module
//! (`credit_previews`, `partner`, `spaces`, `transfers`, `earn`, `loans`, `activity`, `cards`, `card_programme`, `ramps`, `automations`, `bills`, `global`, `bank_api`, `business`, `business_team`, `business_spend`; the TEST age door, `test_age`, is the partner slice's). The store: `db` (the pool and the schema check), `migrate` (the `bank` schema's migrations),
//! `ready` (`/ready`), `restore_watermark` (svc-ops' restore position), `recovery` (the recovery jobs' lock and pass)
//! and `timers` (what else `index.ts` runs on a period); the binary (`main.rs`) puts them together.

pub mod activity;
pub mod automations;
pub mod bank_api;
pub mod bills;
pub mod business;
pub mod business_spend;
pub mod business_team;
pub mod card_ops_desk;
pub mod card_programme;
pub mod cards;
pub mod credit_previews;
pub mod db;
pub mod door;
pub mod earn;
pub mod env;
pub mod errors;
pub mod errors_table;
pub mod global;
pub mod loans;
pub mod migrate;
pub mod ops_approval;
pub mod ops_desk;
pub mod partner;
pub mod partner_account;
pub mod ramps;
pub mod ready;
pub mod recovery;
pub mod refines;
pub mod restore_watermark;
pub mod spaces;
pub mod test_age;
pub mod test_seed;
pub mod timers;
pub mod transfers;
