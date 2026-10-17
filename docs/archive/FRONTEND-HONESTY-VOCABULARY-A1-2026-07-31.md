# Honesty vocabulary (Wave A1′ · dialect 2)

**Status:** CANONICAL for trader shell uc/exchange · not IxState rewrite  
**Component:** `components/uc/IxHonestState.vue`

| Kind        | Meaning                                       | UI                                               |
| ----------- | --------------------------------------------- | ------------------------------------------------ |
| **loading** | Request in flight                             | `Loading…` — never invent totals                 |
| **error**   | Endpoint failed / unreachable                 | Explicit reason; **not** empty table; **not** $0 |
| **empty**   | Endpoint answered OK with zero rows           | “No X yet”                                       |
| **unknown** | Value not available (no answer yet / partial) | `— unknown`                                      |
| **note**    | Dual-book / plane / book labeling             | Always say which book                            |

## Forbidden

- Failed fetch rendered as empty list
- Failed fetch rendered as $0.00 / 1000 seed
- Confirm without receipt on irreversible money
- Double-submit on irreversible actions

## Books

| Label           | Book                                                              |
| --------------- | ----------------------------------------------------------------- |
| venue wallet    | Exchange shell / uc wallet endpoints                              |
| platform ledger | TypeScript ledger via identity session — **not** the same numbers |
