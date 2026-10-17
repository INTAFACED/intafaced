# Decision: P0-3 purpose-keyed holds

**For Nitro.** One page.

**Status:** **Decided — A** · **Not a live production bug today** (nothing is mounted / deployed). Build is **approved**, not started.

---

## What the bug is (one breath)

When money is “held” for a user, the books put **order reservations** and **withdrawal holds** in the **same bucket** (`userHold` per user + asset). The system cannot tell which hold belongs to which order or withdrawal. In theory a withdrawal could eat funds that were reserved for an open order (or the reverse).

Trade already tracks per-order hold amounts inside its own store and tests that those sum to the ledger hold balance — so **inside trade** it’s careful. The hole is **across modules** (e.g. withdrawal settle vs open orders).

---

## Why it was not fixed before the decision

1. The fix changes the **ledger account model** (how accounts are named and indexed) — not a one-line patch.
2. **Many services** build against that model (~8+). A rushed change while services were still landing would make a real bug into a worse one.
3. **Nothing is live** — routers are not mounted (P0-1). There is no production user path exercising this today. That is intentional room to do it properly.

---

## Denon’s proposal (approved)

- Add a **`purpose`** field on the account reference (`AccountRef`): e.g. `order:<id>`, `withdraw:<id>`, or empty/null for ordinary balances.
- One **database migration** (unique index on accounts includes purpose).
- Update **ledger-client** recipes so `tradeFill` / `orderHoldRelease` take the **order id** and post against the right purpose-keyed hold.
- Touch **svc-trade** and **svc-ledger** (and any path that opens/settles holds).

Rough effort: about a day of focused work after design is locked.

---

## Options considered

| Option                           | Meaning                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **A — Approve Denon’s proposal** | Build purpose-keyed holds as described. Timing: after P0-1 mount design is known, **before any deployment**. |
| **B — Change the proposal**      | Different shape (e.g. separate account kinds instead of `purpose`).                                          |
| **C — Keep deferring**           | Leave as-is until after routers are mounted.                                                                 |

---

## Decision

- [x] **A** — Approve Denon’s proposal; build after P0-1 design is known, before deploy
- [ ] **B** — Change the proposal
- [ ] **C** — Keep deferring until after mount; no hold work yet

**Date decided:** 2026-07-27  
**Decided by:** Nitro (via operator session)  
**Notes:**

```
Shape locked to Denon’s proposal. Implementation is not started.
Sequence unchanged: P0-1 mount design/work first, then build P0-3 before any real deploy.
```

---

## Links

- Floor status: [`docs/STATUS-2026-07-27.md`](../STATUS-2026-07-27.md)
- Fill SoT (related, already accepted): [`docs/adr/2026-07-27-trade-order-store-source-of-truth.md`](../adr/2026-07-27-trade-order-store-source-of-truth.md)
