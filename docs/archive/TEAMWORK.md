# TEAMWORK

How Nitro and Denon build this together. One page. If it grows past one page it has become the thing it replaced.

## Aim — what agents build next

**Fix what is built before building more.** Futures already has a large merged surface (`services/svc-trade/src/futures/`) and Denon's `docs/adr/2026-08-05-futures-risk-and-mark-law.md` is **Accepted**. Much of that law has since landed (mark/caller prices, funding idempotency, profit-source bound, order path behind a flag that ships **off**). The remaining job is residual law vs code — not a greenfield product — and it still beats inventing new phase-5 volume. Re-derive the open gaps on tip before coding; do not treat a day-old gap list as truth.

Then, in **Denon's stated order** (`docs/DIRECTION-2026-07-31.md` §1 — _"futures are NOT first, and this is the decision I most want respected"_):

| #   | His order               | State today (re-derived 2026-08-08)  | Needs                                                         |
| --- | ----------------------- | ------------------------------------ | ------------------------------------------------------------- |
| 1   | Seed books / mm-bot     | `ready`, owner Nitro                 | Denon ADR: how seeded depth is disclosed in the orderbook API |
| 2   | Multi-asset instruments | **no tracker row exists**            | a row, then resume `feat/multi-asset-instruments`             |
| 3   | Perpetual futures       | `ready`, large surface, ADR residual | residual law implementation on tip, flag stays off until safe |
| 4   | OTC desk                | `ready`, unowned                     | claim before dual-build                                       |
| 5   | Algo (TWAP only)        | `wip`, owner Nitro                   | a spec                                                        |

Buildable today but **not** on his list, so not first: `trade.forex` (cannot list until fiat rails exist), `trade.ccxt-api`, `venue.aggregation` (market-data half only).

**The one change that makes the board follow this:** his order is not in the data, so nothing can sort by it. Add one field to `tooling/tracker/features.mjs` — `released: <n>`, set only by Denon — and in `tooling/scripts/swarm.mjs` treat an unreleased money row as not-free and sort the rest by `released` ascending. One field carries both permission and order.

## The money boundary

Replaces `MONEY_TRACKER_RE`, which blocks the product and protects nothing — agents made 79 commits into `svc-trade`/`svc-pay`/`svc-bank` in fourteen days while "money was gated."

> **A money feature opens to agents when it has an accepted ADR and Denon has put a release number on its row. The machine checks both. Nobody approves a pull request.**

Accepted ADRs exist for futures, algo, forex and venue-connect. Missing for options, mm-bot and copy — those cannot open until he writes them.

**Not** required human review. Money paths list both of us as owners, so required review means either Denon waits on a non-coder's rubber stamp, or agents wait on him four times a day. Required _status checks_, always. Required _humans_, never.

## Who owns what

|                    | Owns                                                                                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Denon**          | Product law — what may exist and on what terms. Anything moving value to an outside party, granting or widening a permission, adding or changing a ledger recipe, or touching a kill-switch, posture gate or custody scan. Repo admin. |
| **Nitro**          | Direction and taste. Which programme runs. Release-order priorities he and Denon agree.                                                                                                                                                |
| **Nitro's agents** | Implementation of released rows, the whole git loop, verification, merge on green.                                                                                                                                                     |
| **Shehzad**        | Protocol Plane + INTACHAIN only. Agents never implement his rows.                                                                                                                                                                      |

**Three places record ownership, and no others:** `features.mjs` (does this feature have an owner), open PRs (is anyone in these files right now), `residual-register.json` (was this non-tracker item already finished).

## What genuinely waits for a human

1. An accepted ADR before a money feature opens — Denon.
2. A release number on the row — Denon.
3. Repo settings: branch protection, required checks, auto-merge — Denon, sole admin.
4. Class X: secrets, production go-live, licences, sanctions content — Nitro.
5. Taste and visual direction — Nitro.

Everything else merges on green without a human.

## The two numbers

```
node tooling/scripts/teamwork.mjs
```

1. **Places recording who owns what** — target **3**.
2. **Words before an agent's first edit** — target **under 1,000**.

The counting rule is the two lists inside that script, so changing what counts is a reviewable diff. Run it from a checkout level with `origin/main`; it warns if you are behind. As of 2026-08-08 the answers are **14** and **42,847** — re-run the command; do not quote these.

If either number rises, the bureaucracy is regrowing. A new coordination mechanism must delete an existing one.
