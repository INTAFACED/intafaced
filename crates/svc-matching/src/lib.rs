//! svc-matching in Rust: the shell of its port from `services/svc-matching`, which stays the service that runs until
//! the switch. The shell holds what every later slice stands on: the environment (`env`), the refusals and how each
//! door answers them (`errors`, with the recorded user copy in `errors_table`), and the doors (`door`): every route
//! `index.ts` and `router.ts` serve, who may call each, and each door's input checks before it reaches the engine
//! (`refines` holds the exchange contract's own checks inside those schemas). Past the door a call is owed by its
//! slice; `PORT.md` lists the slices and what each ports.
//!
//! The `journal` slice adds the engine journal (`journal`): records, how they are written and read back, the file's one
//! writer, named gaps, and replay's rules over the books.
//!
//! The `book` slice adds the order book (`book`), the engine over it (`engine`: the journal before every move, the
//! order events, the cold start, reconcile), and the doors that reach it (`door::book`). The `serve` slice adds the
//! binary that serves them.

pub mod approval;
pub mod book;
pub mod door;
pub mod engine;
pub mod env;
pub mod errors;
pub mod errors_table;
pub mod journal;
pub mod refines;
pub mod rulebook;
