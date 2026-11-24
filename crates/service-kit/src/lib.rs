//! service-kit: the generic server-side parts every Rust service shares, so each service ported from TypeScript
//! reuses them instead of copying them. It is a library, never a service: it owns no table, no setting and no money, and
//! it depends on no service crate (a service crate depending on another would cross the service boundary,
//! `docs/agents/shape.md` rule 3).
//!
//! Each part is held byte for byte to the TypeScript package it replaces, which stays its reference:
//! `@intafaced/contracts` (the edge trust boundary `edge`, service-to-service signing `s2s`, zod's input checks `zod`,
//! identity's action approvals `approvals`,
//! the Fastify server `server`), `@intafaced/auth` (access tokens a service verifies itself, `tokens`), `@intafaced/config` (the environment slices `env`, the production posture
//! `posture`), `@intafaced/telemetry` (tracing and pino logs `telemetry`, Prometheus `metrics`) and `@intafaced/ledger-client`'s money
//! (`money`: format, parse and divide amounts; it never posts). `json` and `time` are JavaScript's `JSON` and `Date`;
//! `http` is the outgoing `fetch` seam; `pg` and `migrate` are a service's own Postgres pool and migration runner.
//!
//! The tests that hold these bytes run in the services that use them (svc-tax: `tests/wire_replay.rs`,
//! `tests/io_golden.rs`, `tests/service_parity.rs`, `tests/input_parity.rs`), beside each module's own tests here.

pub mod access;
pub mod approvals;
pub mod edge;
pub mod env;
pub mod http;
pub mod json;
pub mod jsregex;
pub mod metrics;
pub mod migrate;
pub mod money;
pub mod nats;
pub mod outbox;
pub mod pg;
pub mod posture;
pub mod s2s;
pub mod s2s_verify;
pub mod schema;
pub mod server;
pub mod telemetry;
pub mod time;
pub mod tokens;
pub mod trpc;
pub mod zod;
