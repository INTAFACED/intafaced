# tiny_http 0.12.0, vendored with one fix

The HTTP server under svc-academy, svc-agents, svc-tax and svc-ledger (each names this copy by path) (`crates/service-kit/src/server.rs`). 0.12.0 is the latest
release (2022). Licence: MIT OR Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`).

- **Source:** the crates.io package `tiny_http-0.12.0.crate`, sha256
  `389915df6413a2e74fb181895f933386023c71110878cd0825588928e64cdc82` (the checksum `Cargo.lock` held for it): its
  `Cargo.toml`, `README.md`, the two licences and `src/`, unchanged except the one line below.
- **The fix (#9432):** `src/util/task_pool.rs`, `TaskPool::spawn`. Each open connection holds a pool thread until it
  closes. `spawn` queued a new connection whenever any thread was counted as waiting, but a woken thread stays counted
  until it holds the lock again. So connections that arrived together were queued behind threads already promised
  another, and each waited until some other connection closed. The edge keeps an idle connection open for 4 s, so the
  console's parallel reads reached svc-academy one every 4 s, and its 8 s limit gave up on the third (J-academy-12 #6
  and #1). Now `spawn` starts a thread unless a waiting thread has no queued task to take
  (`waiting_tasks <= queue.len()`).
- **Its test:** `crates/service-kit/tests/server_connections.rs`. 100 connections are queued before the server
  starts, and none closes until all are answered. Without the fix some never get an answer.

To compare with the package: `diff -r <(unpacked tiny_http-0.12.0)/src crates/vendor/tiny_http/src`.
