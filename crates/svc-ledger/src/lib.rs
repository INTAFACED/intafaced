//! svc-ledger in Rust: its port from `services/svc-ledger`, which stays the service that runs until the switch. The
//! shell holds what every slice stands on: the environment (`env`), the refusals and how each door answers them
//! (`errors`, with the recorded user copy in `errors_table`), and the doors (`door`): every route `index.ts` serves,
//! who may call each, and each door's first input check (`refines` holds the ledger's own checks inside those
//! schemas). The `store` slice adds the book: one pool (`db`), the migrations and their runner (`migrate`), `/health`
//! and `/ready` (`status`), and what the binary does before it serves (`boot`). The `balances` slice answers the account and transaction
//! reads (`balances`). Past the door any other call is owed by its slice; `PORT.md` lists the slices and what each ports.

pub mod approval;
pub mod balances;
pub mod boot;
pub mod clock;
pub mod db;
pub mod door;
pub mod env;
pub mod errors;
pub mod errors_table;
pub mod freeze;
pub mod history;
pub mod migrate;
pub mod refines;
pub mod status;
