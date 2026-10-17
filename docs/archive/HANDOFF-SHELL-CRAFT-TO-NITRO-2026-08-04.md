# Handoff — Vue shell craft, Denon → Nitro swarm

**Written by:** Denon, 2026-08-04. **Owner of the work:** Nitro agents.
**Why this exists:** I wrote the law ([D-S-15](adr/2026-08-04-platform-pages-ia.md)) and then started doing the craft, which is not my lane. This hands over what I found, with nothing half-built left behind.

---

## What happened, plainly

`docs/THREE-WAY-DISTRIBUTION-2026-08-04.md` puts vendor-shell craft with the Nitro swarm. My own ADR says **"law only — craft stays Nitro"** in its header. I then sent an agent to implement it anyway, and it had touched twelve files under `05_Web_Front` before it was stopped.

**That work was discarded, not committed.** Nothing is half-landed, no branch is waiting, and there is no worktree to inherit. Everything below is a finding, verified against `origin/main`, for whoever picks it up.

The reason it matters beyond tidiness: the swarm was landing PRs into that same directory at the time. A dual-edit in `05_Web_Front` is exactly what the coordination law exists to prevent.

---

## 1 · Three live forms post into a dead host — highest priority

Nothing serves the retired Java ucenter. nginx proxies only `/api/` and `/ws`.

| Site                                          | Call                               | What the user experiences                                            |
| --------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `components/uc/Account.vue` ~:488, :490, :504 | `POST /uc/approve/account/setting` | **Bank / Alipay / WeChat bind forms are live** and can never succeed |
| `App.vue` ~:565, :579                         | `/uc/loginout`, `/uc/check/login`  | logout + session check, **on every page**                            |
| `pages/index/Index.vue` ~:820                 | `/uc/ancillary/system/advertise`   | home banner slot                                                     |

The shell's own doctrine already says what to do, in `components/uc/CustodyNotBuilt.vue:57-62`:

> "A greyed-out deposit form reads as 'temporarily unavailable, try later'. A form that submits into a dead host reads as 'something went wrong on your end'. Both invite a user to keep trying, and one of them invites them to wait for money that will never arrive."

**Remove the form. Do not disable it.** Replace with `IxSocketPage` / `IxNoSurface` plus a registry entry in `src/config/sockets.js` carrying `missing`, `needed` and a tracker id. Content comes from the registry, never the component — `IxNoSurface.vue:63-66` explains why. Best exemplar to copy: `pages/ctc/Ctc.vue`, 60 lines of which 25 are the reasoning.

**Care needed on `App.vue`.** Logout and session check run on every page, and the shell now authenticates against **svc-identity, not the Java `member` table**. Work out the identity-backed replacement — start at `config/store.js` and how `isLogin` derives — rather than deleting a session check and leaving the app unable to log out.

---

## 2 · `src/config/api.js` — seven dead paths still declared

Lines ~:6-12 still declare `login`, `register`, `wallet`, `captcha` and three more. Sixteen others were already **deleted rather than commented**, with a 16-line comment at ~:13-29 explaining why. The remaining seven are the same trap. Find every caller, migrate or remove it, then delete the declaration. If one has a live caller you cannot remove, say which — do not leave it silently.

---

## 3 · The Positions tab is stale, not honest

`pages/exchange/Exchange.vue` ~:399-406 renders prose: _"Spot has no perps positions. Futures would stream here later."_

But `GET /api/v1/positions` **is implemented** (`services/svc-trade/src/private-rest.ts:614`), along with `POST /positions` and `DELETE /positions/:id`, and the whole `services/svc-trade/src/futures/` engine exists.

An honest empty describes the **data**. This describes the **platform**, and it is wrong. Wire it to the real endpoint via the shell's existing `rest()` client (`config/intafaced.js:335`) — the terminal already uses it for twelve calls. Render honest-empty when there are no positions; the model is right there at `Exchange.vue:1217-1224`, `accountTabEmpty()`: _"Only claim empty when the service answered — unknown ≠ empty."_

---

## 4 · Everything else already built with no page

Each is craft, not backend work — the procedure exists and the edge routes it. Full list in [D-S-15](adr/2026-08-04-platform-pages-ia.md); the headline items:

- **Convert / swap desk** — `trade.convert.quote`, `trade.convert.execute`. Fully built, no page, no route, no menu entry.
- **API keys** — `identity.apiKeys.create` / `.list` / `.revoke`. `/uc/safe` manages passkeys and TOTP but not these.
- **Notification centre** — nine procedures; `/notice` calls exactly one, and there is no unread badge anywhere.
- **On-chain explorer views** — `indexer.markets/.book/.fills/.accountFills/.position/.positions`, all **public, no session required**. `/chain` shows one status card.
- **`/bank` exposes 5 read-only cards over 30 procedures** — no create-space, transfer, deposit, borrow or repay.
- **Funding rate** and **fee tier** — both endpoints exist, neither is called.

---

## 5 · Two navigation facts

**`/otc` is `display:none` in the header** while the Platform dropdown points at `/p2p` — a two-card read-only page. `/otc` is the real desk: trade flow, chat, disputes. The menu is steering users away from the working product. **Which one is promoted is a product call and belongs to the owner**, not to craft.

**The CEX/DEX plane toggle vanishes below 1100px** (`App.vue:677`), and the mobile drawer compensates with a separate item. Two navigations that disagree is one too many.

---

## 6 · Mobile — the floor, not a redesign

14 of ~74 files carry a media query and there is no shared scale: `520 / 768 / 860 / 1100 / 1180 / 1499 / 1500`, all ad hoc.

`.ix-table` is `white-space: nowrap` and is **only safe inside `.ix-scroll`**. That pairing is a rule. `Record.vue`, `EntrustCurrent.vue` and `EntrustHistory.vue` — **the money blotters** — have zero media queries and fixed-width iView tables. They overflow the viewport today.

The terminal below 860px stays "monitor and panic", which prior planning decided and D-S-15 keeps. The floor: **at every width a user can read positions, read balances, cancel an order, and close a position.** Placing complex orders may degrade; getting out may not.

---

## Constraints that are not negotiable

- **`IxState` is the honesty idiom for new surfaces.** Do not extend `IxHonestState` — two idioms for one job already exist and D-S-15 picks the winner.
- No second visual idiom. The `.ix-*` system stays; no `packages/ui`, no design tokens, no Tailwind. Settled by the retire ADR.
- Money is decimal strings, never a `number`. `assets/js/ix-money.js` exists and is golden-tested.
- Never invent data. Empty renders empty, unavailable is stated, **unfinished is declared**.
- `brand-scan` forbids vendor package and directory names in some contexts. Check before writing a comment that names the upstream project.
- **Do not touch `apps/web`.** It is being retired under its own ADR.

---

## One board correction to make alongside

**The live depth feed has landed** (`ix-depth-feed.js`, WS `/ws/stream`, gap→resnapshot, golden-tested, #748). The retire ADR and `features.mjs` both still read as though it is open blocker #1 for `web.terminal`. Two of the three named blockers are now closed.

And `web.shell` is `status: 'done'` with `requires: ['apps/web']` — a Done claim on an app an accepted ADR retires. It must move before the deletion lands.
