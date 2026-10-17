# Board Clear — Decision Authority

**Binding.** Removes Nitro from tech multi-choice. Agents act like senior staff engineers.

---

## 1 · Default rule

> **If doctrine + constitution + scoreboard answer it → agent decides, executes, logs.**  
> Nitro is asked **only** when §3 applies (tiny set).

Every non-trivial plan interpretation change → one row in `docs/BOARD-CLEAR-DECISION-LOG.md` same turn.

---

## 2 · Agent decides (no ask)

| Class                      | Examples                                                                         | Action                                                         |
| -------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Implementation**         | File layout, test shape, adapter name, env flag default OFF                      | Ship                                                           |
| **Ship order**             | Which agent residual first                                                       | Priority table in agent backlog                                |
| **Thin vs deeper polish**  | A11y pass now vs next PR                                                         | Prefer ship smallest Done-linked slice                         |
| **§13 on agent-owned row** | Sub-accounts UI if identity API incomplete                                       | §13 + tracker honesty; never invent routing                    |
| **CI flake**               | Protocol anvil nonce flake                                                       | Re-run; fix only if deterministic                              |
| **Merge agent Class N/P**  | Docs, UI shell, WS harden                                                        | Green CI + evidence → squash-merge                             |
| **Merge agent Class M**    | Trade light money-adjacent                                                       | Green CI + self-audit + L8 → squash-merge                      |
| **Shehzad PR babysit**     | Comment Class M gates; re-run flake                                              | No branch steal                                                |
| **Shehzad PR merge**       | Only if body has Class M self-audit **and** CI green **and** paths are H-\* only | May squash-merge; else leave open with comment                 |
| **Conflict with Denon**    | Overlap on open PR                                                               | Don’t force-push; rebase agent work; coordinate via PR comment |

---

## 3 · Nitro only (hard set — do not expand casually)

Ask Nitro **only** if all of these are true:

1. No sandbox / §13 / thin honest path exists, **and**
2. The decision is one of:

| ID     | Trigger                                                                                    |
| ------ | ------------------------------------------------------------------------------------------ |
| **X1** | Class X **production go-live** / real mainnet money                                        |
| **X2** | **Secrets** truly absent and no sandbox path can prove Done                                |
| **X3** | **Jurisdiction / custody product law** not covered by doctrine (not “which env flag”)      |
| **X4** | **Explicit brand taste** for a new user-facing product name (not adapter internals)        |
| **X5** | **Re-open locked B** decisions (protocol audit bar, card required, etc.) — normally refuse |

When asking: **one** high-level question, default recommended, risk one line. Never a tech menu.

---

## 4 · Forbidden “fake blockers”

Agents must **not** stop or ask for:

- “Should I do MM mid or UI next?”
- “Approve this architecture?”
- “Merge when green?” (yes if gates met)
- “Wait for shehzad?” (no — cook agent lanes)
- “Continue?” (NEXT is continue)

---

## 5 · Uncertainty protocol

```
uncertain → research (R1) → pick safest doctrine-aligned default → DECISION-LOG → ship
if invent would be required → §13 Cut or thinner Done bar → never invent
if X1–X5 appears while agent residual remains:
    append docs/BOARD-CLEAR-HUMAN-BLOCKERS.md — do NOT stop agent ships; do NOT ping Nitro yet
if agent residual exhausted (AGENT-COMPLETE) and X1–X5 or human rows remain:
    finalize HUMAN-BLOCKERS → report Nitro once (PHASE C)
```

---

## 6 · Product posture (default for all agent UI/trade-light ships)

**Audience:** professional / serious traders (desk density, trust, calm).  
**Law:** `docs/STREAM-A-DESIGN-BAR.md` + FRONTEND SoT + no fake numbers.  
**Not:** retail confetti, apps/web spike, second design system.

Taste calls that don’t hit X4 → follow design bar + existing tokens (P21 provisional). No Nitro poll.
