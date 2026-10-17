# Backend internet leverage — peace of mind (2026-08-31)

**Audience:** Nitro + next Grok bot. **Scope:** backend only.  
**Mega backend (2026-09-03) v1.25:** [`SPEC-BACKEND-MEGA-PLAN-2026-09-03.md`](SPEC-BACKEND-MEGA-PLAN-2026-09-03.md). Live-wire: [`SPEC-PRO-EXCHANGE-LIVE-AND-DEPTH-2026-09-02.md`](SPEC-PRO-EXCHANGE-LIVE-AND-DEPTH-2026-09-02.md).  
**Binding law:** [`INTERNET-LEVERAGE-LAW.md`](INTERNET-LEVERAGE-LAW.md). This file does not weaken it.  
**Question:** should we pull open-source instead of vibe-coding the remaining exchange backend?

**Verdict:** Maximize **the right** open-source — not maximize download count. Use battle-tested codecs, session engines, Greeks/calendar math, WebAuthn, and OpenAPI generators as **adapters**. Keep matching, money, MMP, and identity **law** in-repo. The previous two-library list was too thin; the catalog below is the peace map.

## Unspoken need

Two failure modes: (1) vibe-code a FIX parser, Greeks engine, or CLOB; (2) npm-install a second exchange. Grok bot must take **named, pinned, fact-checked** libraries and refuse everything else.

## Default (already decided)

| Need                               | Take this                                | Never this                                                           |
| ---------------------------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| Match / book / halt / collar / IFM | `services/svc-matching`                  | Java `exchange-core` as SoT; OpenDAX; Hummingbot; LMAX-clone as book |
| Money                              | `packages/ledger-client` + `svc-ledger`  | Formance, TigerBeetle, Java wallet tables, Hyperswitch               |
| Orders / convert / copy / RFQ wrap | `svc-trade`                              | New OMS product                                                      |
| Algos / kill / stage               | `svc-execution`                          | Third-party algo cloud                                               |
| MMP / mass quote                   | `packages/execution-mm`                  | Deribit-clone as a service                                           |
| Identity                           | `svc-identity`                           | Auth0 in the money path                                              |
| Depth / private stream             | `svc-ws` + `packages/market-data`        | Fake L3 from L2                                                      |
| UI                                 | vendored shell `:8090`                   | New SPA                                                              |
| Venue quotes                       | `packages/venue-adapter` decimal strings | **CCXT** (returns JS numbers — already banned)                       |

Greenfield only if Phase A **cannot** do the behavior, named in the PR, money law preserved. “I prefer a new stack” is not evidence.

## Already in the stack — keep, do not replace (verified `origin/main` package.json)

Fastify 5, Zod 3, Drizzle, `postgres` (porsager), Vitest, fast-check, OpenTelemetry API, `ws`, `@trpc/server`, TypeScript 5, Turbo, `@node-rs/argon2` (identity hashing — already chosen).  
Do **not** swap in Express, Prisma, Kafka, decimal.js, or CCXT.

## Take when that mountain is actually scheduled

Pin a **commit SHA**. Isolated install. Config/output outside the clone. Upgrade = new SHA. Decimal strings on the wire; never IEEE money.

| When we build                          | Take                                                                                                                                                            | Why (verified 2026-08-31)                                                                                                     | How                                                                                                                                           | Do not                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| FIX door (`PTX-M05-R02/R10`)           | **QuickFIX/J** `quickfix-j/quickfixj`                                                                                                                           | FIX 4.0–5.0 SP2 / FIXLatest; 100% Java; **3.0.2** 2026-08-04; ~400 dependents. License QuickFIX 1.0 (BSD-style, keep notice). | FIX gateway adapter. Session/dictionary/resend. Fills still matching → ledger-client.                                                         | `node-quickfix`, AGPL jPOS, hand-rolled FIX                     |
| Binary/SBE (`PTX-M05-R04`)             | **Real Logic SBE** `aeron-io/simple-binary-encoding`                                                                                                            | FIX SBE reference; Apache-2.0; **1.39.0**; Binance tells integrators to generate stubs here.                                  | Codec + **our** schema. Not a matching engine.                                                                                                | Protobuf-as-SBE                                                 |
| Options Greeks / calendars (`PTX-M11`) | **QuantLib** C++ `lballabio/QuantLib` **1.43** (2026-07-14), modified BSD                                                                                       | 20+ year industry library for vanilla Greeks, day-count, TARGET/NYSE calendars.                                               | **Research/valuation adapter.** NPV/Greeks cross the adapter as decimal strings. Ledger clock is ours. Not the money book. Not live mark SoT. | QuantLib-Python in the hot path; trusting float NPV on the wire |
| WebAuthn (`PTX-M17`)                   | `@simplewebauthn/server` (MIT)                                                                                                                                  | Standard WebAuthn ceremony helper.                                                                                            | Identity only. No withdrawal in the credential.                                                                                               | Rolling our own attestation parser                              |
| OpenAPI from Zod (`PTX-M05-R08`)       | **Zod 3 in-repo:** pin `@asteasolutions/zod-to-openapi@7.3.4` (upstream: v7.3.4 for Zod 3; v9.x is Zod 4). Do not upgrade the monorepo to Zod 4 in the same PR. | Generate from `packages/contracts`.                                                                                           | Silent Zod 4 / generator 9.x; a second schema language                                                                                        |
| FIX dictionaries                       | FIX Trading Community official XML (public spec, not a product)                                                                                                 | Canonical tags.                                                                                                               | Load into QuickFIX/J DataDictionary.                                                                                                          | Inventing tag numbers                                           |
| Isolated test Postgres                 | Testcontainers for Node (or existing per-branch DB script)                                                                                                      | Law: no shared `intafaced_test` across worktrees.                                                                             | CI/dev only.                                                                                                                                  | One global test DB                                              |
| ReDoS engineer parsers                 | `@intafaced/safe-regex`                                                                                                                                         | Law §3.2                                                                                                                      | Keep                                                                                                                                          | Native `node-re2`                                               |
| P2P operator patterns                  | in-tree `linear-pattern.ts`                                                                                                                                     | Law §3.2                                                                                                                      | Keep                                                                                                                                          | Swap onto re2js                                                 |

## Defer (good OSS, wrong time / would replace a chosen bus)

| Library                             | Why later, not now                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Aeron** (Apache-2.0, Real Logic)  | Superb IPC/multicast. We already have **NATS**. Do not replace the bus to look like CME. Revisit only for colocated SBE multicast.   |
| **ORE** (Open Source Risk Engine)   | QuantLib-based scenarios. Take only when portfolio-margin math is on. Not the money book.                                            |
| **Artio** (Real Logic FIX on Aeron) | Faster tails in some benches; coupled to Aeron. First FIX door is **QuickFIX/J**. Revisit Artio only with Aeron, not instead of QFJ. |
| ClickHouse / Kafka                  | Historical TCA warehouse / log bus. `connect-data-lake` + Postgres first.                                                            |
| Agrona                              | Comes along with SBE/Aeron Java. Fine as a transitive. Not a matching SoT.                                                           |

**Rust matching (`svc-matching-rust-stage1`):** study / dual-target with Shehzad later. **Fiat SoT stays `svc-matching`.** Do not cut over because OSS-adjacent Rust exists.

## Never take (looks like leverage, is a second product or a float)

| Temptation                                    | Why it is wrong here                                   |
| --------------------------------------------- | ------------------------------------------------------ |
| CCXT in the money / quote path                | JS `number` books — banned in `svc-dex` and Phase A E6 |
| Formance / TigerBeetle as SoT                 | Second money book                                      |
| Hyperswitch / PSP orchestrators               | D-S-10                                                 |
| Java `MemberWallet` / vendor wallet tables    | Dual book                                              |
| OpenDAX / full exchange kits                  | Second SPA + second book                               |
| Hummingbot / MM bots as the venue             | Clients, not matching law                              |
| npm `orderbook` / random CLOB packages        | Not our journaled, decimal, refuse-closed engine       |
| QuantConnect LEAN / Freqtrade as the exchange | Research/bots, not the venue                           |
| decimal.js / big.js on the wire               | Money is decimal strings + scaled bigint               |
| Unmaintained FIX GUIs (FIXimulator ~2012)     | Dead                                                   |
| “Clone Binance/Deribit matching”              | Shape-study vendor Java at most; SoT is `svc-matching` |

## Remaining v1.20 work — leverage map

| Spec item                     | Path                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Collar on FileJournal         | **IN** `svc-matching` journal encode                                                                             |
| Kill-parent unknown ≠ killed  | **IN** `svc-execution`                                                                                           |
| RFQ expire / copy drift       | **IN** `svc-trade`                                                                                               |
| Bank cooling                  | **IN** `svc-bank`                                                                                                |
| TradFi-linked perps class     | **IN** instrument master (`exchange-contract` / matching) — refuse unsupported class. Do not import a HIP-3 DEX. |
| Yield-bearing collateral      | **IN** ledger recipes — refuse until product exists. Do not import a yield protocol as the book.                 |
| IFM                           | **IN** `svc-matching` amend path                                                                                 |
| MMP two-sided / MQQ reserve   | **IN** `execution-mm` + matching; owner numbers unset-refuse                                                     |
| FIX versions                  | **EXT adapter** QuickFIX/J when that mountain is scheduled — not day-1 of leftover queue                         |
| SBE feed                      | **EXT codec** Real Logic SBE when that mountain is scheduled                                                     |
| Off-book RFQ credit cap       | **IN** `svc-p2p` / `svc-trade` refuse-closed                                                                     |
| L4 attribution                | **IN** refuse (already the honest door)                                                                          |
| Firm/session pre-trade credit | **IN** `svc-edge` / matching; unset refuse                                                                       |

FIX and SBE are **not** the leftover queue in issue #3446. Do not start them to look busy.

## How Grok bot proves it in a PR

Name the leverage line: `IN svc-matching` or `EXT QuickFIX/J @ <sha> adapter-only`. If neither, the session failed.

## Peace of mind

The right open-source is the **catalog above**: keep the TS stack you have; take QuickFIX/J, Real Logic SBE, QuantLib (Greeks/calendar adapter), WebAuthn, Zod-OpenAPI, official FIX dictionaries, Testcontainers — each at the named mountain, pinned SHA, no money in a float. Everything that can lose money stays in this repo. Taking a second book or a random CLOB is how the product gets broken.
