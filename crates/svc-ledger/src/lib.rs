//! svc-ledger in Rust: the shell of its port from `services/svc-ledger`, which stays the service that runs until the
//! switch. The shell holds what every later slice stands on: the environment (`env`), the refusals and how each door
//! answers them (`errors`, with the recorded user copy in `errors_table`), and the doors (`door`): every route
//! `index.ts` serves, who may call each, and each door's first input check (`refines` holds the ledger's own checks
//! inside those schemas). Past the door a call is owed by its slice; `PORT.md` lists the slices and what each ports.
//!
//! Nothing here reads or writes the book, and nothing is served from it yet: the `store` slice adds the binary.

pub mod door;
pub mod env;
pub mod errors;
pub mod errors_table;
pub mod refines;
