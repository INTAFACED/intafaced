//! svc-ledger in Rust: its port from `services/svc-ledger`, which stays the service that runs until the switch. The
//! shell holds what every slice stands on: the environment (`env`), the refusals and how each door answers them
//! (`errors`, with the recorded user copy in `errors_table`), and the doors (`door`): every route `index.ts` serves,
//! who may call each, and each door's first input check (`refines` holds the ledger's own checks inside those
//! schemas). The `store` slice adds the book: one pool (`db`), the migrations and their runner (`migrate`), `/health`
//! and `/ready` (`status`), and what the binary does before it serves (`boot`). The `freeze` slice adds the posting
//! switch (`freeze`, with `approval` and `clock`); the `history` slice the history reads (`history`); the `reconcile`
//! slice the proof of the book (`chain`, `reconcile`) and what runs and acts on it (`reconciler`); the `balances` slice
//! the account and transaction reads (`balances`); the `ops-reads` slice svc-ops' five reads (`ops_reads`). Past the
//! door a call is owed by its slice; `PORT.md` lists the slices and what each ports.

pub mod approval;
pub mod balances;
pub mod boot;
pub mod chain;
pub mod clock;
pub mod db;
pub mod door;
pub mod env;
pub mod errors;
pub mod errors_table;
pub mod freeze;
pub mod history;
pub mod migrate;
pub mod ops_reads;
pub mod reconcile;
pub mod reconciler;
pub mod refines;
pub mod reports;
pub mod status;
