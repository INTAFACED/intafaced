//! svc-matching in Rust: the shell of its port from `services/svc-matching`, which stays the service that runs until
//! the switch. The shell holds what every later slice stands on: the environment (`env`), the refusals and how each
//! door answers them (`errors`, with the recorded user copy in `errors_table`), and the doors (`door`): every route
//! `index.ts` and `router.ts` serve, who may call each, and each door's input checks before it reaches the engine
//! (`refines` holds the exchange contract's own checks inside those schemas). Past the door a call is owed by its
//! slice; `PORT.md` lists the slices and what each ports.
//!
//! The `journal` slice adds the engine journal (`journal`): records, how they are written and read back, the file's one
//! writer, named gaps, and replay's rules over the books. Nothing here holds a book, and nothing is served from it yet:
//! the `book` and `serve` slices add them and the binary.

pub mod book;
pub mod door;
pub mod engine;
pub mod env;
pub mod errors;
pub mod errors_table;
pub mod journal;
pub mod refines;
