# ADR: platform-pages information architecture — the pages are thin because they are read-only

**Status:** accepted  
**Status note:** **Accepted — 2026-08-04.** Owner decision, stated and confirmed.
**Decision owner:** repo owner. **Written by:** Denon.
**Spec id:** D-S-15. **Law only — craft stays Nitro.**
**Binding:** [`adr/2026-08-03-retire-apps-web-port-to-vue-shell.md`](2026-08-03-retire-apps-web-port-to-vue-shell.md). There is no third surface. The product is the Vue shell at `vendor/upstream-exchange/05_Web_Front`.

---

## The measurement

The owner's report was "very slim… should be like entering a whole app." That is correct, and the cause is specific:

- The eleven Platform pages total **1,270 lines** including chrome. Nine are under 140. `Exchange.vue` alone is **4,293**.
- **Ten of the eleven contain zero mutations.** The only write action behind the entire Platform dropdown is `auth.login` on the hub itself.
- `/bank` renders **five read-only cards** over a service exposing **thirty procedures**.

**They are not thin because the backend is missing. They are thin because nobody wired the verbs.**

---

## The decision

> **A module page that renders only reads, over a service that exposes writes, is an unfinished page — not a socket, not an honest empty, and not Done.**
>
> Every module surface states, in its tracker row, which of its service's procedures it exposes and which it does not. A page may be partial. It may not be silently partial.

This is settled. Agents and engineers implement it; they do not re-litigate it.

---

## The three-way classification every surface must carry

The shell already has excellent machinery for this — `IxState`, `IxSocketPage`, `IxNoSurface`, and a twelve-value failure taxonomy in `config/intafaced.js:58-136` that correctly distinguishes `no_surface` ("the capability has never been built, so no call is issued at all") from `unreachable` and from `invalid_response`. **Nothing new is needed. What is missing is that a fourth state has no name.**

| State                | Meaning                                                   | Furniture                                   |
| -------------------- | --------------------------------------------------------- | ------------------------------------------- |
| **Works**            | Real data from a live service                             | Normal rendering                            |
| **Honest empty**     | The service answered and there is nothing                 | `IxState` empty — "unknown ≠ empty"         |
| **Socket**           | Never built, with a written reason                        | `IxSocketPage` / `IxNoSurface`, orange rule |
| **UNFINISHED** ← new | The service has the procedure; the page does not call it. | **Must be declared. Currently invisible.**  |

The fourth is the entire subject of this ADR. It presents identically to "works" — a page that shows five true cards looks finished — and there is no gate, badge or tracker field that distinguishes it. That is why `/bank` has sat at five-of-thirty without anyone noticing.

---

## What is already built and simply has no page

This is the decision-relevant list, because each item is **craft, not backend work** — the procedure exists, the edge routes it, and no service change is required.

**Fully built, zero UI:**

- **Convert / swap desk** — `trade.convert.quote`, `trade.convert.execute`. No page, no route, no menu entry.
- **API keys** — `identity.apiKeys.create` / `.list` / `.revoke`. `/uc/safe` manages passkeys and TOTP but not these.
- **Notification centre** — nine procedures (`unreadCount`, `markRead`, `channels`, `targets`, `registerTarget`, `verifyTarget`, `deliveries`…). `/notice` calls exactly one of them, and there is no unread badge anywhere.
- **On-chain explorer views** — `indexer.markets/.book/.fills/.accountFills/.position/.positions`, all **public, no session required**. `/chain` shows one status card.

**Built, page exists but exposes a fraction:**

- **Bank** — 30 procedures; 5 read-only cards. No create-space, no transfer, no deposit, no borrow, no repay.
- **Token** — stake, unstake, listStakes, createProposal, castVote, listProposals, burnedSupply. The page is 94 lines showing one stake tier.
- **Pay** — merchant (6), payment (6), settlement (3), checkout, resolveLink. The page shows three cards and no withdraw button, while `withdraw-math.js` sits written and golden-tested **with no consumer component**.

**Terminal gaps with the service already there:**

- **Positions blotter** — `GET/POST /api/v1/positions`, `DELETE /positions/:id`, and the entire `futures/` engine.
- **Funding rate** — `GET /api/v1/funding-rate/:symbol` plus a settlement engine. Zero shell references.
- **Fee tier** — `GET /api/v1/account/fees` exists and is never called.

**Consume-only (Shehzad owns the service — a page is fine, a procedure is not):** DEX swap, pools/liquidity, smart accounts, launchpad.

---

## Three defects this ADR names as bugs, not gaps

**1 · Three sites still POST into the dead Java backend.** `components/uc/Account.vue:488,490,504` — the bank / Alipay / WeChat **bind forms are live** and post to `/uc/approve/account/setting`, which nothing serves. Also `App.vue:565,579` (logout and session check, on every page) and `Index.vue:820`.

This is precisely what the shell's own doctrine forbids, in `CustodyNotBuilt.vue:57-62`:

> "A greyed-out deposit form reads as 'temporarily unavailable, try later'. A form that submits into a dead host reads as 'something went wrong on your end'. Both invite a user to keep trying, and one of them invites them to wait for money that will never arrive."

`config/api.js:6-12` still declares seven live-looking dead paths, after sixteen others were deleted rather than commented, with a comment explaining why. **The remaining seven are the same trap.**

**2 · The Positions tab is stale, not honest.** It renders prose saying "Spot has no perps positions. Futures would stream here later" while `GET /api/v1/positions` is implemented and the futures engine exists. An honest empty describes the data; this describes the platform, and it is wrong.

**3 · The good P2P desk is unreachable from the menu.** `/otc` — the real desk, with trade flow, chat and dispute surfaces — is hidden from the header by `display:none`, while the Platform dropdown points at `/p2p`, a two-card read-only page. The dropdown is actively steering users away from the working product.

---

## Mobile

**One responsive app. No mobile build, no device-class rendering, and that is correct** — do not introduce a second surface.

The state of it: **14 of ~74 files carry a media query**, and there is no shared breakpoint scale. The full set in the codebase is `520 / 768 / 860 / 1100 / 1180 / 1499 / 1500`, all ad hoc.

The rules:

1. **A breakpoint scale is defined once and used everywhere.** Seven ad-hoc values across fourteen files is not responsive design, it is fourteen local fixes.
2. **`.ix-table` is `white-space: nowrap` and is only safe inside `.ix-scroll`.** That pairing is a rule, not a convention. `Record.vue`, `EntrustCurrent.vue` and `EntrustHistory.vue` — **the money blotters** — have zero media queries and fixed-width iView tables. They overflow the viewport today.
3. **Navigation must not diverge by width.** The CEX/DEX plane toggle vanishes below 1100px and the mobile drawer compensates with a separate item. Two navigations that disagree is one navigation too many.
4. **The terminal below 860px is "monitor and panic", and that is a decision, not a failure** — prior planning states it and this ADR keeps it. What must work at every width: read positions, read balances, **cancel an order**, and close a position. Placing complex orders may degrade; getting out may not.
5. **Two honesty idioms exist for one job** — `IxState` (platform pages) and `IxHonestState` (uc money pages). **`IxState` wins.** `IxHonestState` is not to be extended to new surfaces.

---

## Non-goals

- **This is not a redesign.** The `.ix-*` system stays; no second visual idiom, no `packages/ui`, no design-token dependency. The retire ADR settled that.
- **This does not specify layouts.** Craft is Nitro's. This says which surfaces exist, what they must expose, and what they may never claim.
- **This does not add a page for anything unbuilt.** Alerts, PnL, statements, leverage, deposit addresses and remove-liquidity have no service. They stay absent, or they become sockets with written reasons.

---

## Refuse cases

| Situation                               | Correct answer                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| Service answered with nothing           | **Honest empty.** "Unknown ≠ empty" — the terminal's existing copy is the model.  |
| Service unreachable                     | **Say so.** Never a zero, never a dash, never a 0% bar.                           |
| Capability never built                  | **Socket**, with `missing` + `needs` from the registry, never from the component. |
| Procedure exists, page does not call it | **Unfinished.** Declare it on the tracker row. Never let it read as complete.     |
| Form whose endpoint does not exist      | **Remove the form.** Never leave it submitting into a dead host.                  |
| Page claims a platform fact             | It must be **true today** — check it against the service before writing prose.    |
| A surface owned by another lane         | **Consume, never extend.** A UI page over `svc-dex` is fine; a procedure is not.  |

---

## Done bar

1. Every module surface's tracker row names which procedures it exposes and which it does not.
2. No form posts to an endpoint that does not exist. The three dead-Java sites are gone and `config/api.js`'s seven dead paths follow the sixteen already deleted.
3. No page asserts a platform fact that is false — the Positions tab specifically.
4. Navigation reaches every surface that works. `/otc` is reachable or `/p2p` becomes the real desk; the dropdown does not point at the weaker of two.
5. One breakpoint scale, defined once. Every money blotter scrolls rather than overflows.
6. At every width: read positions, read balances, cancel an order, close a position.
7. `IxState` is the only honesty idiom on new surfaces.
8. Empty renders empty, unavailable is stated, unfinished is declared, nothing is invented.

---

## What agents may implement without asking again

- Any Tier-A page above — the procedure exists and the edge routes it.
- Wiring the verbs on `/bank`, `/token`, `/pay` to their existing procedures.
- Deleting the three dead-Java call sites and the seven dead paths.
- Correcting the Positions tab, the breakpoint scale, and the blotter scroll containers.
- UI over `svc-dex` / `svc-protocol` procedures — **consume only**.

## What still needs the owner

- Whether `/otc` is promoted or `/p2p` is rebuilt as the real desk. Product, not craft.
- Anything in Tier C — alerts, PnL, statements, tax export, user→user transfer, deposit addresses. Each needs a service first.
- `dex.quote-router`: the code is finished and cannot serve a quote until someone decides which venue this platform quotes.

---

## Two board corrections this ADR notes

- **The live depth feed has landed on tip** (`ix-depth-feed.js`, WS `/ws/stream`, gap→resnapshot, golden-tested). The retire ADR and `features.mjs` both still read as though it is open blocker #1. Two of the three named `web.terminal` blockers are now closed.
- **`web.shell` is `status: 'done'` with `requires: ['apps/web']`** — a Done claim on an app an accepted ADR retires. It must move before the deletion lands.
