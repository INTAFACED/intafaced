# Lane stop — L03 BANK wave 11 product-velocity · 2026-08-09

**Tip at writing:** re-derive (`git fetch && git log -1 --oneline origin/main`). Was `a1416803` after #1613.

---

## Operator block

```
LANE: L03 BANK wave 11 product-velocity
shipped: #1588 already on tip (auto-invest threshold + rate refuse) · #1602 business maker/checker partial (found open → CI green → on tip) · #1613 auto-invest HTTP job kill parity + pause/resume
in flight: none on services/svc-bank
parked: earn day-boundary product law (Nitro) · fiat partner Class X · card issuer Class X · invent auto-invest rates §8 · ConvertPort→trade.convert wire · card round-ups (capture hook) · commercial crypto ramp allowlist · FLAG_REGISTRY bank.* module wire · business KYB/payroll/invoicing/expense cards · P-plane session-key allowance (Shehzad)
Nitro must decide: earn day-boundary · fiat · issuer · ramp pair allowlist · module flags · or none
SAFE TO CLOSE: yes — open bank code PRs none after #1613; L1–L4 residual empty or named parks; Engine B pass done; no pad
tip: re-derive (was a1416803)
```

---

## A0 open-PR bank

| Item                         | Result                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| #1588 auto-invest            | **Already MERGED** on tip at orient (`b99d03c1`) — no merge action                     |
| #1602 business maker/checker | **Found open → CI green → MERGED** `ad9cd25a` (sibling L08 craft, wall-owned residual) |
| claim-check at orient        | #1602 intersected `services/svc-bank`; after #1613 wall clear of open bank code PRs    |
| Shehzad #1177                | babysit only — no bank paths                                                           |
| Denon invent-risk engines    | not taken                                                                              |

---

## Shipped this wave (proof)

| PR                | Unit                                        | Class | Notes                            |
| ----------------- | ------------------------------------------- | ----- | -------------------------------- |
| **#1588** (prior) | Auto-invest F-plane partial                 | M     | On tip before L03 started        |
| **#1602**         | Business maker/checker partial              | M     | Squash `ad9cd25a`                |
| **#1613**         | Auto-invest HTTP kill parity + pause/resume | M     | Squash `a1416803` · CI all green |

### Unit card — #1613

1. **Promise:** #1526 kill-parity shape + README “HTTP job when mounted” + dead `paused` status residual.
2. **Break:** runner was tRPC-only; external scheduler could not fire; `paused` enum never written.
3. **Done bar:** `POST /internal/jobs/run-auto-invest` + shared `bank.auto_invest_disabled`; pause stops fires; resume allows normal due rules.
4. **Class M**
5. **Paths:** `services/svc-bank/**` only
6. **RED first:** mount kill tests + pause suite
7. **Collision:** rebased onto #1602 before push

---

## Engine A scorecard (wave 11)

| Unit                                 | Result                                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| A0 Merge #1588                       | Already on tip — re-verified                                                                                                           |
| A0 Open bank PR bank                 | **#1602** merged                                                                                                                       |
| A1 auto-invest residual              | **#1613** job kill + pause; rates still refuse unset (#1588)                                                                           |
| A1 ramps residual                    | **Sealed** crypto half + fiat socket; commercial allowlist **park**                                                                    |
| A1 cards residual                    | **Sealed** ledger half; live issuer **X**                                                                                              |
| A2 business residual                 | **#1602** honest partial; KYB/payroll **park** invent-risk                                                                             |
| A2 standing-order residual           | **Sealed** #1526 re-verified (ancestor)                                                                                                |
| A2 spaces ledger proofs              | **Sealed** doctrine suite                                                                                                              |
| A3 earn day-boundary / fiat / issuer | **Park** Nitro                                                                                                                         |
| A3 mountain-event tracker            | owners still `nitro-w10-l08` on auto-invest/business wip — clear only with next mountain event PR (avoided #1614 features.mjs collide) |
| A3 Engine B pass                     | Below                                                                                                                                  |

---

## Sealed re-verify (do not re-ship)

| Seal                                     | Tip proof                        |
| ---------------------------------------- | -------------------------------- |
| #1588 auto-invest                        | ancestor `b99d03c1`              |
| #1602 business                           | ancestor `ad9cd25a`              |
| #1613 job/pause                          | tip `a1416803`                   |
| #1526 standing-order fairness + ops kill | ancestor `ce46c947`              |
| #1491 job isolation                      | on tip                           |
| #1439 loan collateral / B-02             | on tip                           |
| #1442 blank ramp asset refuse            | on tip                           |
| Spaces = ledger doctrine suite           | on tip                           |
| Cards no-issuer / ramps fiat socket      | named codes in errors + services |

---

## Engine B — chapter pass (tip after #1613)

| Chapter             | Verdict                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Where balance lives | **HONEST** — ledger only; auto-invest/business rules hold no balance                                                        |
| Auto-invest         | **HONEST** F-plane: threshold + DCA refuse rates + HTTP kill + pause; round-ups / convert wire / P-plane **named residual** |
| Business            | **PARTIAL honest** — maker/checker dual control; KYB/payroll/invoicing **not invented**                                     |
| Ramps               | **HONEST** crypto half + blank refuse + fiat socket; allowlist **park**                                                     |
| Cards               | **HONEST** ledger half; live rail **X**                                                                                     |
| Earn                | **HONEST** recipes; day-boundary **park** Nitro                                                                             |
| Standing orders     | **HONEST** — fairness + kill + pause/lock seals                                                                             |
| Spaces              | **HONEST** ledger views                                                                                                     |
| Kill-switches       | **HONEST** — env jobs HTTP+tRPC including `AUTO_INVEST_ENABLED`; FLAG_REGISTRY named-not-enforced                           |
| Sockets §13         | **HONEST** — fiat / issuer / history; no invent                                                                             |
| Attack surface      | rate invent → refuse; local balance → sealed; ramp invent → refuse                                                          |

---

## Engine C — attack surface (W11)

| Attack                       | State                                       |
| ---------------------------- | ------------------------------------------- |
| rate invent (DCA)            | sealed refuse `bank.auto_invest_rate_unset` |
| local balance in bank tables | sealed schema guard                         |
| ramp invent credit           | sealed refuse                               |
| auto-invest kill back door   | sealed #1613 HTTP+tRPC                      |
| business self-approve        | sealed #1602                                |

---

## Named parks (not agent craft)

1. Earn day-boundary product law (proration vs min full day) — **Nitro**
2. Fiat ramp partner — **Class X** / `socket.psp-partners`
3. Live card issuer — **Class X** / `socket.live-issuer`
4. Invent auto-invest convert rates — **banned §8**
5. ConvertPort → trade.convert production wire
6. Card round-ups (needs capture hook)
7. Commercial crypto ramp allowlist — product law
8. FLAG_REGISTRY `bank.*` true module kills — product go
9. Business KYB / multi-recipient payroll / invoicing / expense cards — invent-risk or blocked deps
10. P-plane session-key allowance — Shehzad / protocol

---

## Next for a fresh agent

1. Do **not** invent rates, fiat, issuer, or payroll atomicity without law.
2. Clear `owner` on `bank.auto-invest` / `bank.business` only via mountain-event PR when picking up residual (claim-check currently fences wall while owner set).
3. ConvertPort wire only with real trade.convert counterparty — refuse-closed stays until then.

**SAFE TO CLOSE:** yes for wave-11 L1–L4 residual craft on `services/svc-bank/**`.
