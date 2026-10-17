# vendored exchange kit / vendored exchange — peace-of-mind map

**Type:** scope truth for agents + Nitro  
**Verified against:** `origin/main` @ `d768d7c` (2026-08-03 this session)  
**Upstream name:** vendored exchange / upstream package / vendored exchange kit lineage · Apache-2.0 · in-repo as `vendor/exchange-tree`  
**Product law:** adopt product UI + workflows; **our ledger only** (ADR Accepted 2026-08-02)

---

## One screen (read this first)

| Question                                   | Answer                                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What is “vendored exchange kit” here?      | The **vendored full exchange kit** under `vendor/exchange-tree` (~**1,787** files on main).                                                                                  |
| Is it on GitHub?                           | **Yes** — on `main`. Source of truth is the **repo**, not a laptop or random web copy.                                                                                       |
| What do we use as the product UI?          | **`05_Web_Front`** (trader web) → fleet port **:8090** (`vendor-shell` in compose).                                                                                          |
| Is the whole upstream promise in our tree? | **Almost.** Web front, web admin, Java engines, wallet RPC, docs = **present**. **Android, iOS, trading robot = stubs only** (upstream said not open-source / not included). |
| Is anything “missing” from our vision?     | **Yes, by design:** own L1/chain story, our TypeScript services, our ledger books, Protocol plane, spiritual/G-master — those are **ours**, not vendored exchange kit.       |
| Second app?                                | `apps/web` (Next, :3000) is **not** the product. Retire as product.                                                                                                          |
| Who owns FE?                               | **Nitro** (call 2026-08-03).                                                                                                                                                 |

---

## What’s in the kit (full folder map)

| Folder                 | On main?                                 | What it is                                                                           | FE care?                                      |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| **`05_Web_Front`**     | **Yes** (~262 files, **74** `.vue`)      | Trader website: trade, OTC, account, CMS, activity, + our `intafaced/*` stubs        | **Primary**                                   |
| **`04_Web_Admin`**     | **Yes** (~156 files, **~92** `.vue`)     | Operator / admin console                                                             | Later FE if Nitro takes admin look            |
| **`00_framework`**     | **Yes** (~912 files)                     | Java microservices: exchange, market, OTC, ucenter, admin, chat, wallet, cloud, jobs | Denon / adapters — not FE rewrite             |
| **`01_wallet_rpc`**    | **Yes** (~359 files)                     | Per-chain wallet RPC (btc, eth, usdt, eos, … + rpc-common)                           | **Not FE.** Security review before real money |
| **`09_DOC`**           | **Yes** (~74 files)                      | Upstream screenshots / nginx notes                                                   | Reference only                                |
| **`02_App_Android`**   | **Stub only** (README: not open-sourced) | No app source in repo                                                                | Out of scope until we decide mobile           |
| **`03_APP_IOS`**       | **Stub only**                            | Same                                                                                 | Same                                          |
| **`06_ExchangeRobot`** | **Stub only**                            | Same                                                                                 | Out of scope                                  |
| Root scripts           | Yes                                      | rebrand / CJK / seed helpers used in our waves                                       | Tooling                                       |

**Provenance (must stay):** `vendor/exchange-tree/NOTICE` — Apache-2.0 attribution; external brand stripped by `brand-scan`.

**Vendored into this monorepo:** PR **#73** (2026-07-28). Shell made **deployable** PR **#412** (+ follow-on container fixes).

---

## Trader shell (`05_Web_Front`) — screen inventory

**~43 page entry files** under `src/pages/` (plus shared components → **74** Vue files total).

| Area                                | Count (page files) | Examples                                                     |
| ----------------------------------- | -----------------: | ------------------------------------------------------------ |
| **uc** (account / auth)             |                  7 | Login, Register, MemberCenter, FindPwd, …                    |
| **otc** (C2C / P2P desk)            |                  6 | Main, Trade, Chat, AdPublish, …                              |
| **cms**                             |                  6 | Help, Notice, AboutUs, WhitePaper, …                         |
| **activity**                        |                  4 | Activity, Partner, Bzb, …                                    |
| **exchange**                        |                  1 | `Exchange.vue` (big trading terminal)                        |
| **index / invite / ctc / envelope** |             1 each | Home, invite, CTC, red envelope                              |
| **intafaced/** (our overlays)       |                 13 | Academy, Bank, Dex, Pay, Protocol, Chain, Token, NotBuilt, … |
| **NotFound**                        |                  1 |                                                              |

**Deploy on main (verified):**

- `Dockerfile` + `nginx.conf`
- Compose service **`vendor-shell`** → **`8090:80`**, proxies `/api` and `/ws` toward our edge stack

**Runnable ≠ finished:** many screens still need **rewire** to our edge (work in progress / open PRs). Catch-all routes can show home for bad URLs — verify by real navigation.

---

## What the law says (agent pack)

Load these for any FE / vendored exchange kit work (all **on main** except starred):

| Doc                                                             | Role                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------- |
| `AGENTS.md`                                                     | Repo agent rules, Nitro operator mode                 |
| `tooling/agent-protocol/AGENT_PROTOCOL.md`                      | Hard bans                                             |
| `INTAFACED_DEFINITIVE_BUILD.md`                                 | Engineering law                                       |
| `INTAFACED SOVEREIGN OS.pdf`                                    | Product vision (features)                             |
| `docs/adr/2026-08-02-adopt-vendored-product-keep-our-ledger.md` | **Accepted:** product yes, book no                    |
| `docs/adr/2026-07-28-vendored-exchange-integration.md`          | Option B ledger only                                  |
| `docs/adr/2026-07-28-vendored-exchange-ui.md`                   | UI assessment (historical)                            |
| `docs/NITRO-STREAM-A-CLAIM.md`                                  | FE territory map (vendor paths)                       |
| `docs/START-HERE.md`                                            | Nitro plain map                                       |
| `docs/VENDORED-KIT-PEACE-OF-MIND-MAP-2026-08-03.md`             | **This file**                                         |
| `docs/DENON-CALL-EXTRACT-2026-08-03.md` _local_                 | Call alignment                                        |
| `docs/NITRO-CALL-SAID-2026-08-03.md` _local_                    | Nitro’s own commitments                               |
| Branch `docs/vendored exchange kit-adoption-queue`              | Counted adopt/adapt/rewire queue (**not merged** yet) |

### Ownership freeze (2026-08-03)

| Lane                                   | Owner                                               |
| -------------------------------------- | --------------------------------------------------- |
| Trader / product **frontend** (shell)  | **Nitro**                                           |
| Pay / perps / checkout (claimed)       | **Shehzad** — agents do not implement               |
| Spine / Java / recipes / deploy wiring | **Denon** (move free; don’t dual-edit his open PRs) |
| Secrets / wallet-RPC real-value        | **Owner** + security review                         |

---

## Adoption buckets (so “use vendored exchange kit” is not vague)

From adoption queue (branch; counted, not vibes):

| Bucket              | Meaning                               | Scale (approx)                                  |
| ------------------- | ------------------------------------- | ----------------------------------------------- |
| **1 ADOPT AS-IS**   | No balance write — stop rebuilding    | **68** framework controllers                    |
| **2 ADOPT + ADAPT** | Keep logic; redirect balance → ledger | **25** money controllers                        |
| **3 REWIRE**        | Keep **screen**; point at our edge    | UI work — Nitro-relevant                        |
| **4 DELETE**        | Dead weight                           | Justified file-by-file                          |
| **5 REPLACE**       | Cannot run beside ours                | Balance book + named collisions                 |
| **Wallet RPC**      | Adopt after **security review**       | **14** controllers; 6 modules auth hole flagged |

**Money doors on Java side are largely shut** (no-ops + 410 interceptor) until opened behind ledger adapters — Denon queue.

---

## What’s _not_ vendored exchange kit (ours / later)

| Item                                        | Where it lives                         |
| ------------------------------------------- | -------------------------------------- |
| One real book                               | `packages/ledger-*`, our services      |
| Edge, identity, pay TS services             | `services/svc-*`                       |
| `apps/web` Next surface                     | Retire as product; optional port later |
| Own L1 / Hyperliquid-class chain story      | Not in vendor kit                      |
| G-master / spiritual / ancient intelligence | Explicitly **later** (call)            |
| Casino games provider API                   | Denon: mostly done elsewhere           |
| Full native mobile apps                     | **Not in repo** (stubs)                |
| Full trading robot source                   | **Not in repo** (stub)                 |

---

## “Is everything on GitHub?” checklist

| Check                                   | Result `[VERIFIED this session]`                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| Vendor tree on `origin/main`            | **Yes** · ~1787 files                                                            |
| Trader shell Dockerfile + :8090 compose | **Yes**                                                                          |
| Admin Vue app present                   | **Yes**                                                                          |
| Java framework modules present          | **Yes** (admin, exchange, market, otc, ucenter, …)                               |
| Wallet RPC tree present                 | **Yes**                                                                          |
| Android/iOS/robot full source           | **No** — stubs + “not open source” READMEs                                       |
| Adoption queue doc on main              | **No** — still branch `docs/vendored exchange kit-adoption-queue`                |
| Call extract docs on main               | **No** — local only until committed                                              |
| Open FE-related PR (at check)           | **#418** rewire OTC/identity/inbox (Denon) · **#346** Shehzad pay (not FE shell) |

**Nothing important for the trader web product is “only on Denon’s machine” for the kit itself.** Unmerged work lives as **PRs/branches** (normal). Re-fetch before every coding session.

---

## Agent cold-start (copy into FE chats)

```
Product UI = vendor/exchange-tree/05_Web_Front (:8090). apps/web is not product.
Law: adopt vendored product, ledger.* only book. Nitro owns frontend.
Read: docs/VENDORED-KIT-PEACE-OF-MIND-MAP-2026-08-03.md + AGENTS.md + ADR 2026-08-02.
Do not implement Shehzad pay/perps paths. Do not dual-edit Denon open vendor PRs without check.
git fetch && worktree off origin/main — never edit main checkout.
Near-horizon only. TradingView preferred for charts (Denon).
```

---

## Next after this map (Chat B / D)

- **B:** Redundant vs port (`apps/web` + past craft vs shell).
- **D:** FE task board + ship on shell.
- **C landscape:** only if a **named gap** appears; do not re-pick white-labels.

---

_Re-verify tip: `git fetch && git rev-parse --short origin/main` and re-list open PRs before claiming this map’s open-PR row still exact._
