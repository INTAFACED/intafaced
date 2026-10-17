# Branch handover — Nitro takes over

Everything is pushed. Nothing is lost. **Read the status column before you trust
a branch** — most of these are unverified work-in-progress, committed so it
survived a crash, not because it is finished.

## Merge this first

**PR from `release/2026-07-29-verified`** — three verified branches merged
together, `pnpm verify` **83/83**, all four gates clean, **DoD gate passes**.

| what                       | why it matters                                                        |
| -------------------------- | --------------------------------------------------------------------- |
| market seeder              | every price was `0`; BTC/USDT now ~118,450 with real volume           |
| `dex.quote` venue sourcing | it was a calculator with no inputs; now refuses rather than invents   |
| screening guard            | a service can no longer boot unable to screen and report itself clear |

---

## Branch status — the honest table

**VERIFIED** means an agent ran `pnpm verify` and reported the real output.
**WIP** means the process crashed mid-task and I committed whatever was on disk.
A WIP branch may not compile. Read it before trusting any of it.

| branch                         | status       | notes                                                                                                                      |
| ------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `feat/spine-market-seeder`     | **VERIFIED** | merged into the release branch                                                                                             |
| `feat/spine-dex-quotes`        | **VERIFIED** | merged; 87 tests                                                                                                           |
| `feat/spine-screening-guard`   | **VERIFIED** | merged; 28 new tests                                                                                                       |
| `feat/spine-trading-hours`     | **VERIFIED** | 76/76. **Money — owner merges.** Adds the instrument model (asset class, schedules) and refuses orders into a closed venue |
| `feat/multi-asset-instruments` | **VERIFIED** | same work, older ref. **Money — owner merges**                                                                             |
| `feat/spine-dod-gate`          | WIP          | e2e harness, kill-switch client, Grafana dashboards, edge metrics                                                          |
| `feat/spine-academy-launch`    | WIP          | two new services **plus a new ledger recipe — money, needs real scrutiny**                                                 |
| `feat/spine-market-stability`  | WIP          | 7 money-through-`double` bugs in the Java FX rates                                                                         |
| `feat/spine-java-rename`       | WIP          | **do not run blind** — see the hazards below                                                                               |
| `feat/app-i18n-keys`           | WIP          | 38+ files mid-sweep; re-verify compile and the CJK scan                                                                    |
| `feat/spine-amm-reserves`      | WIP          | the prerequisite the DEX agent refused to fake                                                                             |
| `feat/spine-bank-card`         | WIP          | Genesis-style no-KYC card research                                                                                         |
| `feat/app-admin-rebrand`       | WIP          | 59 files; admin console still had 2,668 lines of Chinese                                                                   |
| `feat/spine-otc-desk`          | WIP          | two OTC implementations, ownership question open                                                                           |
| `feat/spine-derivatives`       | WIP          | barely started                                                                                                             |
| `feat/spine-venue-fabric`      | WIP          | barely started                                                                                                             |
| `feat/spine-agent-fleet`       | WIP          | barely started                                                                                                             |

---

## Three things that will bite you

**1. The Java rename is armed.** `feat/spine-java-rename` renames the package
root. **1,420 MongoDB documents across 60 collections carry the vendor package
name in a `_class` discriminator** — including the K-line history behind the
chart that currently shows real prices. Renaming without the `_class` migration
in the _same_ change orphans all of it. The vendor names are also the live MySQL
schema and Mongo database names, so a blanket replace points every app at a
schema that does not exist and `ddl-auto=update` builds 64 empty tables beside
the real ones. Full analysis in `docs/SPLIT-BOARD.md` §5 item 7.

**2. Never point a test at the shared `intafaced` database on 5433.** A test that
applies migrations mutates the schema for every other checkout. That is how a
branch broke `main`'s tests from a different worktree earlier. Dedicated
databases exist (`intafaced_test`). Nine suites still default to the shared one —
`turbo.json` already passes `TEST_DATABASE_URL_*` through and `.env` is a global
dependency, so setting them there fixes it for everyone without touching a
service file.

**3. `pnpm verify` can fail on a stale install.** Twice today it failed on a
missing workspace symlink after a dependency was added in an earlier PR. Run
`pnpm install` before believing a red verify.

---

## Still needs the owner, not an engineer

- **The TradingView licence.** The vendored Charting Library carries **no
  licence, NOTICE, EULA or copyright anywhere across its 85 files**, while
  `docs/TERMINAL.md` already specifies lightweight-charts (Apache-2.0) for the
  same job. Two coherent paths, different work. See `docs/LICENCE-POSITION.md`.
- **`mysql-connector-java:8.0.11`** is GPL v2 with a FOSS exception a proprietary
  product is not on. **DONE (#106):** swapped to MariaDB Connector/J 2.7.12.
- **What goes in the sanctions blocklist.** The mechanism now exists and refuses
  to boot without a list in staging or prod. The list itself is counsel's.
- **CORS origins** for the Java modules.
