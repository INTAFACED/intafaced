//! The lobbies slice's parts: who may sit (`seat`), the 2D scene (`scene`), the stream provider (`stream`), the stake
//! and host-rights reads (`clients`), the session calendar (`calendar`), the curriculum summaries pins show (`spine`)
//! and every statement against the rooms, sessions, seats, invitations and pins (`store`). The calls are answered in
//! `slices/lobbies.rs`.

pub mod calendar;
pub mod clients;
pub mod scene;
pub mod seat;
pub mod spine;
pub mod store;
pub mod stream;
