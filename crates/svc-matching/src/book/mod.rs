//! The `book` slice: one market's order book (`engine/book.ts`), its types (`engine/types.ts`) and the small rules it
//! applies. Pure: no I/O and no clock; the engine hands time in.

pub mod order_book;
pub mod rules;
pub mod spread;
pub mod types;
pub mod wire;

pub use order_book::{
    AmendTarget, Ladder, LiveOrder, OrderBook, QueueLevel, QueueOrder, StateError,
};
