# LANE STOP — L15 EVENTS · wave 9 topup · 2026-08-09

```
LANE: L15 EVENTS wave 9 topup
shipped: #1547 throw no longer eats the retry · #1555 wrong subject refused + every catalog event has a fixture + bus defaults named
in flight: none
parked: crewMemberCreated Class B (owner / ADR D-S-13) · bank planned subjects (events-first needs bank payload law, not invent) · multi-replica bus product · notify adopting ACK_WAIT_MS export (L14 wall)
Nitro must decide: none for residual craft · owner still owns crewMemberCreated Class B (not new this wave)
SAFE TO CLOSE: yes
tip: a2d76f05 (events #1555) — re-derive; stop worktree may sit later
```

## Wall

`packages/events/**` — one writer this wave.

## Tip ritual (this seat)

| Check                         | Result                                 |
| ----------------------------- | -------------------------------------- |
| Paste tip                     | `e0126fbb` — tip won                   |
| Open events PRs at start      | none (only #1177 Shehzad + dependabot) |
| claim-check `packages/events` | clear of open PRs                      |

## Engine A — what shipped vs sealed

| Unit                            | Outcome                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A0 open events PR merge         | none open at start                                                                                                                 |
| A1 wiring sockets               | **SEALED** — gate green: 16 wired, 16 sockets (15 A · 1 B · 0 C); reasons ≥40 chars; sockets name real events                      |
| A1 orphan / void publisher      | **SEALED** — event-wiring fails undeclared ends; no silent void                                                                    |
| A1 cannot claim wired if socket | **SEALED** — mounted ≠ wired (crew half-wire still recorded B)                                                                     |
| A2 subject/envelope             | **SHIPPED #1555** — `EventSubjectMismatchError` on wrong subject                                                                   |
| A2 jetstream bus                | **SEALED prior** (#1042 nak backoff · #1059 abandon announce · #1066 maxDeliver reconcile) + **#1547** idempotent release on throw |
| A2 catalog growth / untested    | **SHIPPED #1555** — fixtures for all 32 catalog keys; money fields refuse numbers on high-traffic subjects                         |
| A2 bus defaults export          | **SHIPPED #1555** — `DEFAULT_MAX_DELIVER` · `ACK_WAIT_MS` · `ACK_WAIT_NS` derived                                                  |
| A3 Engine B                     | **PASS** this wave (below)                                                                                                         |
| A3 invent multi-replica bus     | **PARK** — no law                                                                                                                  |
| A3 path-intersect notify/trade  | no dual-write; consumers stay in their walls                                                                                       |

## Engine B — promise falsification (this pass)

| Surface              | Verdict                                                                  |
| -------------------- | ------------------------------------------------------------------------ |
| catalog              | 32 events; every fixture validates; money-as-number refused where tested |
| WIRING_SOCKETS       | 16 entries, class A/B/C, reason length + gate dual-reader                |
| bus `idempotent`     | was at-most-once on throw → **#1547** release on failure                 |
| bus `acceptEnvelope` | was silent on wrong subject → **#1555** refuse                           |
| jetstream            | redelivery / backoff / abandon / consumer reconcile already on tip       |
| envelope             | codec + drift + version unchanged and still green                        |
| subjects             | RE2 entity tokens; closed VERBS list                                     |
| tests                | package suite 83 pass / 9 skip (NATS) on ship trees; CI green both PRs   |

## Engine C — attack surface

| Attack              | Status                                  |
| ------------------- | --------------------------------------- |
| orphan event        | gate red unless socket                  |
| fake wired          | existence ≠ mounted (crew pinned)       |
| socket outlives gap | gate red when wire appears              |
| silent catalog rot  | fixtures close the untested-schema hole |

## Parked (honest — not agent free craft)

1. **`crewMemberCreated` Class B** — ADR D-S-13 owner decision. Academy/agents mount is out of wall and reserved. Do not soft-class to A.
2. **Bank planned subjects** (svc-bank README: space.created, transfer.settled/rejected, position opened/closed, interest.posted) — real events-PR-first backlog, but **payload law not specified** for this wall. Inventing six shapes without bank L1 is pad/invent. Park until bank asks for the catalog PR with fields.
3. **Multi-replica / product bus** — no law; park.
4. **L14 notify** adopting `ACK_WAIT_MS` / `DEFAULT_MAX_DELIVER` instead of local `30_000` / `5` — export exists on tip; wire is notify wall.
5. **Shehzad #1177** — babysit only.

## Sealed re-verify (no re-ship)

- wiring sockets + event-wiring gate green after both merges
- catalog rules + declared sockets tests hold
- JetStream at-least-once suite still present (skips without NATS; CI runs NATS)

## SAFE TO CLOSE

**yes** — residual for `packages/events` agent craft is empty after tip re-derive. Remaining items are owner Class B, other-wall, or invent-risk parks. No Nitro money decision on this seat.
