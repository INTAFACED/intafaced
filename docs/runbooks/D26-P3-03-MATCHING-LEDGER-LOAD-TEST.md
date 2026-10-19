# D26-P3-03 — Matching + ledger load-test harness

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Board:** D26-P3-03 (Denon hard parallel P3 — run / ship / security).  
**Done bar (this file):** fail-closed harness; numbers live here; **not** a live soak against prod.  
**Class:** Eng. Host / staging fleet remains **Class X** residual.  
**Leverage (Phase A IN):** `S-MATCH` (`services/svc-matching` public HTTP) and `S-LEDGER` (`services/svc-ledger` health + internal `post`) as **target descriptions only**. This PR does not edit those services.  
**Not used:** k6 (AGPL), artillery, autocannon — not added as a money-path dependency. Phase C listed them as a **MID EXT** option after a host exists ([`INTERNET-LEVERAGE-PHASE-C-GATEWAY-SOCKETS-2026-08-06.md`](../INTERNET-LEVERAGE-PHASE-C-GATEWAY-SOCKETS-2026-08-06.md) §3).

---

## 0 · Honest bit first

There is **no host**. AXIS already said load testing cannot be built against a laptop ([`AXIS-IMPROVEMENT-PLAN-2026-08-08.md`](../AXIS-IMPROVEMENT-PLAN-2026-08-08.md)). This mountain’s closable slice is the **refuse-closed stub + a place to write numbers**, not a p99 that pretends a soak happened.

Doctrine **§20** already names a Fiat matching target (`< 5ms p99` internal match, Rust-port trigger `>10k/s` sustained) in [`INTAFACED_DEFINITIVE_BUILD.md`](../../INTAFACED_DEFINITIVE_BUILD.md). **That line is existing doctrine, not a measurement from this harness.** This document does not invent a new p99, does not promote an empty table into product law, and does not treat “the stub exited 0” as latency proof.

---

## 1 · Fail-closed stub

```bash
node tooling/scripts/matching-ledger-load-test.mjs
# exit 2 unless LOAD_TEST_ACK=1

LOAD_TEST_ACK=1 node tooling/scripts/matching-ledger-load-test.mjs
# prints loopback targets; sends no HTTP

node tooling/scripts/matching-ledger-load-test.mjs --self-test
```

| Condition                                                                                        | Result                                       |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `LOAD_TEST_ACK` unset or not `1`                                                                 | **exit 2** — default                         |
| `APP_ENV` / `NODE_ENV` is production                                                             | **exit 2**                                   |
| `MATCHING_HTTP_URL` / `LEDGER_HTTP_URL` not `http://` loopback (`127.0.0.1`, `localhost`, `::1`) | **exit 2**                                   |
| `LOAD_TEST_SOAK=1`                                                                               | **exit 2** — soak is not implemented         |
| `LOAD_TEST_ACK=1` + loopback + no soak                                                           | **exit 0** — plan printed, **zero requests** |

Defaults (compose / README, not prod): matching `http://127.0.0.1:4005`, ledger `http://127.0.0.1:4001`.

---

## 2 · Target description (Phase A doors — do not hit from this stub)

From the service READMEs on tip. Agents must not edit `services/svc-matching` (P2-01d) or `services/svc-ledger` for this mountain.

### Matching (`svc-matching`)

HTTP + JSON. Amounts are **decimal strings**. The engine holds **no balances**.

| Door                                        | Why it would be on a future local soak (not this stub)  |
| ------------------------------------------- | ------------------------------------------------------- |
| `POST /markets/:marketId/orders`            | Admission + match loop (the §20 internal-match surface) |
| `DELETE /markets/:marketId/orders/:orderId` | Cancel path                                             |
| `GET /markets/:marketId/depth`              | Read path (not a money move)                            |
| `GET /health` · `GET /ready`                | Liveness / disabled engine                              |

A rejection is `200` + `accepted: false`, not a 4xx. Counting 4xx as “errors” on this door would lie.

Matching **posts no ledger transactions**. A matching-only flood is not a ledger load test.

### Ledger (`svc-ledger`)

There is **no user-facing write path**. Value moves when another module calls `post` with a `ledger-client` recipe. Operator HTTP (`/operator/freeze`, `/operator/reconcile`) is **not** a load-test target.

| Door                                   | Why it would be on a future local soak (not this stub)          |
| -------------------------------------- | --------------------------------------------------------------- |
| Internal `post` (service credentials)  | The only write; decimal strings; balanced + funded + idempotent |
| `GET /health` · `GET /ready`           | Liveness; `/ready` is **503 when frozen**                       |
| `balance` / `balances` (`ledger:read`) | Read path — not a substitute for `post`                         |

A soak that hammers `/health` and calls it “ledger load” is out of scope.

---

## 3 · Numbers

**Recorded measurements:** none. No host, no soak, stub generates no traffic.

| Surface                        | Door                             | Doctrine (existing law — not invented here)                           | Measured here    |
| ------------------------------ | -------------------------------- | --------------------------------------------------------------------- | ---------------- |
| Fiat matching (internal match) | `POST /markets/:marketId/orders` | §20: `< 5ms p99` internal match; Rust-port trigger `>10k/s` sustained | **not measured** |
| Ledger `post`                  | internal `post`                  | §20 does **not** name a ledger-post p99; do not invent one            | **not measured** |
| Matching cancel                | `DELETE …/orders/:orderId`       | none in §20                                                           | **not measured** |
| Health                         | `GET /health`                    | not an SLO                                                            | **not measured** |

When a **local** fleet exists and someone runs a real generator **outside** this repo’s money-path dependencies, paste rows below. Until then the table stays empty on purpose.

| When (UTC) | Target (loopback only) | Tool (out of tree) | n   | Notes   | p50 | p99 | Claim as product law? |
| ---------- | ---------------------- | ------------------ | --- | ------- | --- | --- | --------------------- |
| —          | —                      | —                  | —   | no host | —   | —   | **no**                |

A filled p99 in that table is an **observation**, not a doctrine amendment. Changing §20 is a Denon law edit, not an ops paste.

---

## 4 · Residual (no host)

| Residual                          | Why it stays open                                                            |
| --------------------------------- | ---------------------------------------------------------------------------- |
| Staging / prod soak               | No host; Class X to buy and wire one                                         |
| In-repo HTTP generator            | Intentionally omitted so k6/artillery do not enter the money path            |
| Grafana SLO panel                 | Doctrine §14 sign-off still unchecked; needs a running Tempo/Grafana (P3-08) |
| Matching dual-target / Rust port  | Shehzad / LAW (`socket.rust-matching`); not this mountain                    |
| Promise-falsify matching (P2-01d) | Separate lane; do not dual-edit `services/svc-matching`                      |

**This mountain’s agent-closable bar:** harness refuses without `LOAD_TEST_ACK=1`; numbers table exists and is empty for cause.
