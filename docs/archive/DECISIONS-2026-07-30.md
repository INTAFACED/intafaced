# Decisions — 30 July 2026 (Denon / Stream B)

Board: `docs/DENON-NITRO-PARALLEL-BOARD-2026-07-30.md`. Items A1.1–A1.3, plus
A1.7 which turned out to gate everything else.

Every claim below was checked against the live repo and the running database, not
recalled. Where I am uncertain I say so.

---

## A1.7 — CI is dead, and it blocks the merge protocol. **DECIDED: merge on local gate + self-audit.**

**Evidence:** 100 consecutive runs, **zero successes**, spanning 00:32–05:24 today.
Every job fails with **zero steps executed** and no retrievable logs
(`BlobNotFound`). Actions are enabled (`{"enabled":true,"allowed_actions":"all"}`).
Runner labels are plain `ubuntu-latest`. Workflows last changed in #99, well
before the window — so this is not a workflow bug and not a code failure.

A job that fails with zero steps never reached a runner. That leaves **quota or
spending limit**.

**Local `pnpm verify` on `main` right now: 86/86 tasks, DoD gate PASSED**, with
`workspace-sync` (16 services), `brand-scan` (575 files), `custody-scan` (67
files) and `migration-check` (23 migrations, all reversible) clean. So the tree
is healthy; only the runner is not.

**Consequence for the split:** my merge authority is "green CI + self-audit", and
green CI is currently unobtainable. Rather than stall the spine, the substitute
gate is: **full local `pnpm verify` green, gates clean, plus a written money
self-audit on the PR.** Every PR I merge under this regime says so explicitly, so
the exception is auditable and reversible once CI is back.

**Needs the owner** — I cannot check billing without adding a `user` scope to
your GitHub token, which is a change to your account and not mine to make:
→ **github.com/settings/billing** (Actions minutes / spending limit).

---

## A1.1 — Chart licence. **DECIDED: pursue the grant, ship Apache in the meantime.**

Three products get conflated under "TradingView charts":

| product                                      | licence                                                               | what it is                                                              |
| -------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Lightweight Charts**                       | Apache-2.0, open source                                               | rendering only — candles, crosshair, scales                             |
| **Advanced Charts** (was "Charting Library") | free of charge, **not** open source; you apply and are granted access | drawing tools, indicator library, saved layouts — what Hyperliquid uses |
| **Trading Platform**                         | same gating                                                           | Advanced Charts plus order-entry integration                            |

**What actually went wrong was never cost.** The vendored copy was **Advanced
Charts v1.11 (2017) with no licence, NOTICE, EULA or copyright anywhere across
its 85 files** — a redistributed copy inherited in the fork. Purging it (#106)
was correct on those grounds alone.

**Current state, verified:** the library is gone from disk and blocked in
`.gitignore` with the condition written into the rule. The terminal runs
lightweight-charts vendored as a standalone bundle — no npm dependency, no CDN.
`docs/TERMINAL.md` already names lightweight-charts.

**The gap is real.** The current wrapper is 255 lines: candlesticks, crosshair,
time scale. **Zero indicators, zero drawing tools.** That is not a pro terminal.

**Decision:**

1. **Apply to TradingView for Advanced Charts** — free, days not minutes, so it
   is the long-lead item and starting it costs nothing. **Owner action.**
2. **Ship lightweight-charts as the default** until a grant is on file.
3. **Close the interim gap without a licence** — SMA, EMA, MACD, RSI and
   Bollinger are all computable and renderable as additional series. Volume
   already works. That buys most of the visible gap; drawing tools are the part
   the grant actually pays for.
4. **Do not restore v1.11 even with a grant** — it is eight years old. Take a
   current release, which means rebuilding the datafeed adapter. That is known
   work, not research: the contract is documented and our market endpoints
   already serve it.

**Uncertainty stated:** TradingView's exact terms and application process may
have changed since my knowledge cutoff. Verify on tradingview.com before relying
on my summary of anything contractual.

---

## A1.2 — MySQL Connector/J. **DECIDED: the swap already on main is a valid path.**

**Verified on main:** `vendor/…/00_framework/pom.xml` now declares
`org.mariadb.jdbc:mariadb-java-client:2.7.12`, with the comment
`LGPL-2.1 — replaces GPL mysql-connector-java:8.0.11`.

The original problem: `mysql-connector-java:8.0.11` is **GPL v2 with the FOSS
exception**, and a proprietary product is not on that exception's list.

**MariaDB Connector/J is LGPL-2.1, and that is acceptable here** on the standard
analysis: a JDBC driver is loaded dynamically as a separate, unmodified jar, which
is exactly the linking case LGPL permits inside proprietary software. **The
conditions we must keep true:**

- the driver stays an **unmodified** upstream jar — do not patch it and ship it
- it stays **separately replaceable** (a normal Maven dependency, not shaded or
  vendored into our own artefact)
- it is **attributed** in `NOTICE` with its licence

If any of those three stop being true, the analysis stops holding. Shading it
into a fat jar is the realistic way that happens by accident.

**This is an engineering record, not legal advice.** LGPL linking is settled
enough in practice that I am comfortable recording it as decided; if you want it
counsel-confirmed, it is a cheap question to ask.

---

## A1.3 — `feat/multi-asset-instruments`. **ALREADY MERGED. The branch is superseded.**

The board reserves this as "Denon-only money-enum merge". **It has already
landed** — both halves. Verified against the running database, not the diff:

| evidence                                                      | state                                       |
| ------------------------------------------------------------- | ------------------------------------------- |
| `services/svc-trade/drizzle/0001_multi_asset_instruments.sql` | on `main`                                   |
| `trade.markets.asset_class` distinct values                   | `crypto`, `commodity`, `forex`              |
| `services/svc-ledger/drizzle/0003_commodity_asset_kind.sql`   | on `main`                                   |
| `ledger.asset_kind` enum                                      | `crypto`, `fiat`, `native`, **`commodity`** |
| `ledger.assets` by kind                                       | crypto 4, fiat 7, native 1, **commodity 5** |
| `/api/v1/markets` through the edge                            | returns `AUD/USD` in CCXT shape             |

**So the money-enum call reserved for the owner was taken by whoever merged it.**
I am flagging that rather than quietly accepting it, because the rule existed for
a reason and the rule was bypassed.

**Decision: accept it, do not revert.** The work was verified 76/76, both
migrations are reversible, `custody-scan` and `migration-check` are clean, and it
is live with real rows. Reverting a live, tested schema change to satisfy a
process rule after the fact would create risk rather than remove it.

**Actions:**

- Close `feat/multi-asset-instruments` and `feat/spine-trading-hours` as
  superseded — keeping stale duplicates of merged work invites someone
  re-merging them.

### Correction — trading-hours enforcement DID land

An earlier version of this section claimed `assertMarketOpen` was missing and
that "a weekend EUR/USD order is accepted today". **That was wrong.** It landed
in **#102 `feat(trade): refuse orders into a closed venue`** (`5110166`), roughly
two hours before this document was first written, and #102 squashed _both_ halves
— the instrument model and the enforcement — into one commit, which is why the
schedule columns being present did not imply the check was absent.

Verified on `main`, not inferred: `services/svc-trade/src/spot/trade-service.ts`
calls `assertMarketOpen` at **line 387**; `holdFor` is not reached until **line
430**. So the refusal happens before any hold, which is the property that
matters — a closed venue cannot fill, and funding an order into one locks the
balance behind a book nobody is matching.

I claimed a live money bug that did not exist. Caught by an agent that checked
the running code instead of taking the brief at face value. The lesson is the one
this repo keeps relearning: **schema present ≠ enforcement present, and neither
can be inferred from the other — read the call site.**

**What was genuinely missing was the coverage, not the code**, and that is now on
`feat/spine-venue-hours`:

- the unknown-schedule fail-safe existed but had **zero tests** — removing the
  guard broke nothing, while `rows.ts` casts the schedule straight out of the
  Postgres enum with no runtime parse, so a migration adding an enum value
  without a matching schedule entry puts an unknown key on the order path
- **`cme-globex` had no coverage at all** — commodities close _daily_, so the
  60-minute settlement break was an hour-wide hole every weekday, not just at
  weekends
- "refused before any hold" was asserted only by a comment; it is now an
  end-to-end test proving the balance stays spendable and nothing reaches the
  engine

---

## Not decided here

- **Sanctions blocklist contents** — the mechanism exists and refuses to boot
  without a list in staging or prod. What goes in it is counsel's, with Nitro.
- **CORS origins** for the Java modules — needs the real origin list.
- **Wallet keystore re-encryption** (A1.4) — existing ETH deposit keystores were
  created with an empty password; once a real one is set they stop decrypting.
  Sequencing that is a live-custody operation and belongs in A2, deliberately not
  bundled into a licence note.
