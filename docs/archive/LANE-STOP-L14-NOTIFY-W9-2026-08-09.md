# LANE STOP — L14 NOTIFY · wave 9 topup · 2026-08-09

**Lane wall:** `services/svc-notify/**`  
**Tip at write:** `06138ed2` (re-derived after L10 #1544; notify tip craft still `0acbdbeb` / #1521).  
**SAFE TO CLOSE:** **yes** — L1–L4 residual craft empty after tip re-derive; only Nitro Class X / product-law parks remain.

---

## Packet (plain)

```
LANE: L14 wave 9 topup
shipped:
  · A0 open notify PR merge — none on wall (claim-check clear)
  · #1504 price-watch sweep HOLD (sweep mount, dark mark, canFire, /ready lastAt)
  · #1521 HOLD — fire-before-notify under kill; gateway timeout max = lease ceiling
  · W6–W8 seals re-verified HOLD — multi-replica rates · reaper/stuck · fan-out
    kill · claim lease · refusal matrix · event-wiring Class B · credentials refuse
  · Engine B README chapter pass — all HOLD on tip (no new craft needed)
  · RAN-IT: svc-notify 38 suites / 297 tests pass · 35 doctrine gates green
in flight: none
parked:
  · live MarkSource inject — product pick of trade public mark vs owner feed
  · gateway credentials Class X — docs/OWNER-ACTIONS-NOTIFY-GATEWAYS.md
  · 429 not-before — only if ops measures thrash (retryable + attempt budget hold)
  · non-EN alert i18n — OS EN catalog only
  · alert/reaper /ready lastAt on error ticks — ops polish, not user-facing lie
  · settle-if-still-owner — only if a real gateway ignores idempotency-key
  · operator fleet delivery list — tracker residual; user has notify.deliveries;
    needs admin scope product law (not invent)
Nitro must decide: gateway credentials Class X if out-of-app must go live
SAFE TO CLOSE: yes
tip: 06138ed2
```

---

## Engine A — units this wave (re-verify only)

| Unit                       | Done bar                  | Status           | Proof                                                                   |
| -------------------------- | ------------------------- | ---------------- | ----------------------------------------------------------------------- |
| A0 open notify PR merge    | green or none             | **none open**    | claim-check clear on `services/svc-notify/**`                           |
| A1 price watch / #1504     | holds under tip           | **SEALED**       | sweep-mounted-pin · dark refuse · evaluation disclosure · activeMarkets |
| A1 multi-replica SMS       | no N× free codes          | **SEALED**       | PostgresTargetRateLimiter FOR UPDATE + concurrent last-slot             |
| A1 reaper stuck            | no fake delivered forever | **SEALED**       | reapExhausted arm1/arm2 · stuck-grace pin · reaper interval pin         |
| A2 fan-out kill            | kill honest               | **SEALED**       | fanout-off-pin + **#1521** alert path (no markFired under kill)         |
| A2 claim lease             | no double free SMS        | **SEALED**       | lease clamp + **#1521** env max = `MAX_GATEWAY_TIMEOUT_MS` (25s)        |
| A2 gateway budget vs lease | budget cannot beat lease  | **SEALED**       | `env.ts` max 25_000; pin ∀ legal t: lease ≥ t                           |
| A2 refusal matrix          | complete                  | **SEALED**       | readme-refusal-matrix-pin · refusal-write-catalog-pin                   |
| A3 v22.alerts residual     | core + dark refuse        | **SEALED core**  | types · dark port · sweep · canFire; live mark = park                   |
| A3 event-wiring            | no orphan growth          | **SEALED**       | matrix 10 durables Class B pin                                          |
| A3 gateway credentials     | park Class X              | **PARK Class X** | owner action doc only                                                   |
| A3 Engine B full pass      | stop note                 | **this file**    | below                                                                   |

**Anti-pad:** zero craft PRs this wave. W8 already closed the wall after #1521. Explore agents that flagged “30s timeout beats lease” / “markFired before notify” were reading a **stale main checkout** behind #1521 — re-derived on tip and **refuted**.

---

## Engine B — chapter pass (README → code on tip)

| Chapter                            | Verdict                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| The one thing (attempt ≠ accepted) | **hold** — CHECK + settle; no `delivered` overclaim                              |
| Channels                           | **hold** — four adapters; unconfigured refuse; required fatal staging/prod       |
| Addresses                          | **hold** — own targets; verify-through-channel; shared fixed-window rates        |
| API                                | **hold** — full tRPC; self-only; deliveries user-facing; mount.reachable         |
| Events                             | **hold** — 10 consumers = matrix; nak only retryable; critical records no-target |
| Reaper                             | **hold** — arm1 attempts_exhausted · arm2 delivery_stuck                         |
| Price alerts                       | **hold** — sweep mounted; dark refuse; fire-before-notify after #1521            |
| Kill-switches                      | **hold** — fanout no-write; OOA named refuse; alert path no burn under kill      |
| Environment                        | **hold** — gateway timeout max 25s = lease ceiling                               |
| §13 sockets                        | **hold** — adapters real; waiting credentials only (Class X)                     |

No new §8 invented. Digest stays unwired (pin).

---

## Engine C — attack surface

| Surface             | State                                                                              |
| ------------------- | ---------------------------------------------------------------------------------- |
| Replica free SMS    | **mitigated** — FOR UPDATE rates + lease covers attempt (#1521)                    |
| Fake delivered      | **mitigated** — accepted only on transport receipt + DB CHECK + reaper             |
| Kill lie            | **mitigated** — bus no-write; OOA named refuse; alert fire no markFired under kill |
| Orphan events       | **mitigated** — Class B growth pin + pending consumer report                       |
| Dark gateway / mark | **mitigated** — typed refuse; zero invent                                          |
| 429 thrash          | **parked** — retryable + attempt budget; no not-before without thrash              |

---

## RAN-IT this wave

Worktree `feat/w9-l14-notify-residual` at tip:

```
pnpm exec turbo run build --filter=@intafaced/svc-notify...
cd services/svc-notify && pnpm exec vitest run
→ Test Files  38 passed | 4 skipped
→ Tests       297 passed | 46 skipped  (PG suites skip without TEST DB)

pnpm gates → 35 doctrine gates green
```

Open PRs path-intersect: **clear** on `services/svc-notify/**` (Shehzad #1177 babysit only; dependabot elsewhere).

---

## Parked pick-up (unchanged from W8)

1. Inject real `MarkSource` (trade public mark) — **product pick of source**.
2. Owner gateway URL/token (Class X) — [`docs/OWNER-ACTIONS-NOTIFY-GATEWAYS.md`](./OWNER-ACTIONS-NOTIFY-GATEWAYS.md).
3. Optional 429 not-before if gateway thrash appears in ops.
4. Non-EN alert key translations when non-EN catalogs land in `packages/i18n`.
5. Optional: stamp alert-sweep / reaper `/ready.lastAt` on error ticks (ops polish).
6. Optional: settle-if-still-owner if a real gateway ignores idempotency-key.
7. Optional: operator fleet delivery list — needs admin scope product law.

---

## Wall

`services/svc-notify/**` only. No dual-write. Class X credentials never invented.  
No packages/** craft this wave. No invent-risk product-complete engines.
