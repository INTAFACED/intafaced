# Nitro Stream A claim — app surface

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** CLAIMED by Nitro (`@ZenYoda3`) — **Phase 1 agent floor closed** (2026-07-29)  
**Date:** 2026-07-29  
**GitHub:** issue [#83](https://github.com/Phantom-X-007/intafaced/issues/83)  
**Source of law:** Denon board on `feat/rebrand-english-black-orange (LANDS AS #86 on main — treat as done)` → `docs/SPLIT-BOARD.md` + message 2026-07-29

> **Supersession (2026-07-31):** This file is the **trader-shell territory map** when the job is Stream A UI only.  
> For **residual board / full-program execution**, [`NITRO-OWNERSHIP-AND-DENON-DIRECTION-2026-07-31.md`](NITRO-OWNERSHIP-AND-DENON-DIRECTION-2026-07-31.md) + residual campaign win: agents **may** edit services/packages under a claimed LIVE-LANE.  
> Still never force-push `feat/spine-*` / multi-asset crash WIP; still never invent engine product law; still doctrine money bans.

**Partner stream (UI-only jobs):** Denon-designed spine — open `[cross-stream]` if you are **only** on Stream A shell work and need a spine change.

**Claim tags:** `[VERIFIED 2026-07-29]` Phase 1 UI slices S0–S1 + S3–S7 on main via #98/#103/#108 + follow-ups. Open: **S2 seed** [#109](https://github.com/Phantom-X-007/intafaced/issues/109) · **S8 look tour** (Nitro only).

---

## One-sentence mission

Make the **product look and behave right in a real browser** — charts, prices, DEX/CEX switch, account panes, mobile, empty/error states — without touching Denon’s backend wiring.

---

## Territory (hard rule for every agent)

### YOU MAY edit (Stream A)

| Area          | Path pattern                                 |
| ------------- | -------------------------------------------- |
| Screens       | `vendor/*/05_Web_Front/src/pages/`           |
| Components    | `vendor/*/05_Web_Front/src/components/`      |
| Images        | `vendor/*/05_Web_Front/src/assets/images/`   |
| App shell     | `vendor/*/05_Web_Front/src/App.vue`          |
| Client routes | `vendor/*/05_Web_Front/src/config/routes.js` |

Branch prefix: **`feat/app-*`** only.

### YOU MUST NOT edit (Stream B — post a request instead)

| Area                                               | Why                                   |
| -------------------------------------------------- | ------------------------------------- |
| `services/`, `packages/`, `tooling/`               | Spine                                 |
| Java under `vendor/*/00_framework/`                | Spine                                 |
| `docker-compose*`, Dockerfile                      | Deploy                                |
| Dev proxy `05_Web_Front/config/index.js`           | Collision risk (`/exchange` incident) |
| `main.js`                                          | Spine                                 |
| Edge route table `services/svc-edge/src/routes.ts` | Spine                                 |
| Ledger / multi-asset money branches                | Denon merges personally               |

**Cross-stream request:** open issue titled `[cross-stream] <file> — <what>` with the exact change. Do not “just quickly” edit.

Append-only shared files (if present): `en.js`, `intafaced.css` — only inside Stream A marked regions; never full-file prettier sweep.

---

## Full ordered scope (what Denon told Nitro to do)

Highest visible value first. This is the **complete** Stream A list from the board.

| #   | Work                                          | Done when (plain)                                                                                                                |
| --- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Look at the trading terminal in a browser** | Human (or agent with screenshot) has seen layout, chart skin, depth graph; list of real UI bugs filed/fixed                      |
| 2   | **Prices are not all zero / chart has bars**  | Demo shows real-looking prices or seeded candles — not empty zeros forever                                                       |
| 3   | **DEX / CEX toggle in the UI**                | User can switch plane; protocol side drops KYC/member gates, CEX keeps them; backend plane logic already exists — UI was missing |
| 4   | **Order entry polish**                        | Validation, precision, fee preview, confirm states feel intentional                                                              |
| 5   | **Account panes wired**                       | Balances / Positions / Open Orders / History show real endpoint data                                                             |
| 6   | **Mobile**                                    | Drawer/shell checked after retheme; usable on small screen                                                                       |
| 7   | **Empty + error states**                      | Backend down never blank-screens; honest messages                                                                                |

### Also on Nitro (owner-only, not “code all day”)

| Item                           | Meaning                                                                 |
| ------------------------------ | ----------------------------------------------------------------------- |
| **Visual sign-off on rebrand** | After English + black/orange is live: “this is the product look” yes/no |

### Explicitly **not** Nitro’s job (Denon / counsel)

| Item                                                          | Owner                               |
| ------------------------------------------------------------- | ----------------------------------- |
| Redeploy fleet so protocol/indexer stop 404’ing               | Denon                               |
| Merge `feat/multi-asset-instruments`                          | Denon                               |
| Land rebrand first, rebase onto main w/ #80                   | Denon (he was asked)                |
| Bank / blueprint who gets permission scopes                   | Denon policy                        |
| P2P needs KYC tier `basic` (403 reason)                       | Denon / product honesty in UI later |
| Empty sanctions blocklist before public DEX                   | Counsel + Nitro product call later  |
| Java custody hardening, hot-reload poll, workspace-sync widen | Denon                               |
| Trading hours on order path                                   | Denon (with multi-asset)            |

### Blocked on Denon — post request, keep moving

Any new `/api/*` proxy prefix · any new edge route · anything in `main.js`.

### Preconditions before serious Stream A coding

1. Rebrand branch merged (or explicit work on a **copy** of rebrand after rebase onto main — never rewrite his remote without ask).
2. Prefer his fleet **redeployed** so protocol/chain aren’t false 404s while building UI.
3. Shell reachable: board says container `intafaced-shell-web` on **:8090** (may be Denon’s machine; confirm where the live shell runs for _this_ Mac).

---

## How agents must work this claim

1. Read this file + `AGENTS.md` Nitro operator mode.
2. Worktree only: `pnpm wt feat/app-<short-name>`.
3. One concern per PR.
4. Verify in **browser** when the shell is available — compile-only is not enough for Stream A.
5. If need spine change → GitHub issue `[cross-stream]…`, stop editing.
6. After Denon merges a wave → optional `docs/WAVE-AUDIT.md` for money; Stream A stays UI.
7. Do **not** rebase or force-push Denon’s `feat/rebrand-*` or `feat/multi-asset-*`.
8. Do **not** restart full monorepo security archaeology for Stream A work.

---

## Tracker note

Feature registry (`tooling/tracker/features.mjs`) is module/phase oriented; Stream A is a **collab board**, not one tracker id.  
When a UI slice maps to a tracker feature (e.g. `web.terminal`), set `owner: 'nitro'` / `wip` in the same PR.  
Until then, **this file + the GitHub “Stream A” issue are the claim.**

---

## Phase 1 execution (audited plan)

Decision-grade plan (honesty bar, slices S0–S8, demo vs pretty, anti-collision):  
[`docs/STREAM-A-PHASE1-PLAN.md`](STREAM-A-PHASE1-PLAN.md)

---

## Links

| Doc                                                         | Role                                       |
| ----------------------------------------------------------- | ------------------------------------------ |
| `docs/STREAM-A-PHASE1-PLAN.md`                              | Phase 1 slices + methodology audit         |
| Denon `docs/SPLIT-BOARD.md` (on rebrand branch until merge) | Full two-stream law                        |
| Denon `docs/HANDOVER-2026-07-29.md`                         | Live “what’s serving” probes               |
| `docs/DENON-MESSAGE-VS-AUDIT-2026-07-29.md`                 | How this relates to the audit              |
| `docs/PEACE-OF-MIND-AUDIT-CURRENT.md`                       | Money/trust floor (not Stream A checklist) |
| `docs/WAVE-AUDIT.md`                                        | After Denon merges money/spine waves       |
