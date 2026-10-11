# Coordination truth layers (binding)

**Status:** BINDING · **auto-load enforced** (full access · no human gate before code)  
**Home for this fact:** this file. Pointers only elsewhere.  
**Intent:** Denon multi-dev context + zero agent conflict **without** slowing parallel autonomous ship.  
**Not:** a new project board, every-PR registry tax, or a human Approve gate.

**Authority order for current work:** doctrine and `AGENTS.md` → live GitHub (`origin/main` and open PRs) → `tooling/tracker/features.mjs` (product state and ownership) → `docs/LIVE-LANES.md` and current claim files (session collision paths) → dated campaign boards (sequence/history only). A dated board never overrides live code, ownership, claims, or CI.

### How this is enforced without you messaging a chat

| Layer                     | What loads                                           | What it does                                                       |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| **Cold agent opens repo** | `AGENTS.md` + `CLAUDE.md` (tools auto-inject)        | Coordination section + CLAUDE non-negotiable #5 — **no paste**     |
| **Hard bans**             | `tooling/agent-protocol/AGENT_PROTOCOL.md`           | Money/custody/ledger prohibitions only — not human ownership locks |
| **Machine regression**    | `pnpm scan:agent-autoload` in **CI + `pnpm verify`** | Fails if someone deletes the law from auto-load files              |
| **Tracker honesty**       | `pnpm tracker:check` in CI + verify                  | Blocks false `done` / stale render — not every craft edit          |

**Honest limit:** no tool can force a model to _think_; we put the law where tools **always load** and **block regression**. We do **not** demand `features.mjs` on every code PR (that would limit you).

---

## Operator guarantees (do not violate)

| Guarantee           | Meaning                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| **Speed**           | No PR cap · no serialize-agents · no “wait for CI idle” · no CI spend throttle · a 403 or 429 is a stop |
| **Quality**         | False `done` still fails `pnpm tracker:check` · doctrine gates unchanged                                |
| **Autonomy**        | Full access — any agent, any row, **merge when done** · CI/verify are not ship gates                    |
| **Zero manual ops** | Never wait for audit seal, FREEZE, or chat permission to start code                                     |
| **No every-PR tax** | Craft under an already-`wip` mountain does **not** require a `features.mjs` edit                        |

If a future change breaks a row above, **reject the change**.

Keep code work parallel. Pace GitHub API requests across agents; a 403 or 429 stops GitHub activity while independent local work continues. Follow the refusal and cooldown handling in [`AGENT_PROTOCOL.md`](../tooling/agent-protocol/AGENT_PROTOCOL.md) §3.

---

## One question → one home

| Question                                                      | Home                                                                                                   | Not home                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| What product features exist? free / wip / done / human-owned? | `tooling/tracker/features.mjs` → `docs/TRACKER.md`                                                     | Board Clear NEXT alone                                 |
| What should **this campaign** ship **next**?                  | `docs/BOARD-CLEAR-NEXT.md`                                                                             | Tracker (not a micro-scheduler)                        |
| Campaign row progress / Done bars in flight?                  | `docs/BOARD-CLEAR-SCOREBOARD.md`                                                                       | Chat memory                                            |
| Who is coding **which program/paths this hour**?              | `docs/LIVE-LANES.md` + open PRs                                                                        | Tracker WIP forever                                    |
| Do two live PRs collide on paths?                             | `gh pr list` + path intersect (PARALLEL law)                                                           | Hope                                                   |
| What code is on main?                                         | `git` / merged PRs                                                                                     | Any doc’s frozen SHA                                   |
| House book vs Base vs INTACHAIN P1 **now**?                   | [`adr/2026-09-03-protocol-rails-until-intachain.md`](adr/2026-09-03-protocol-rails-until-intachain.md) | LAST-MVP 23 Aug GO; tracker “ready” on `chain.mainnet` |
| Protocol P0 **this wave** (phases, not L1)?                   | [`PROTOCOL-P0-BASE-MEGA-2026-09-06.md`](PROTOCOL-P0-BASE-MEGA-2026-09-06.md)                           | LAST-MVP §4 three-row leftover; anvil CI as “shipped”  |
| Did Shehzad **check** P0-on-Base before deploy?               | Three lines on [#4199](https://github.com/Phantom-X-007/intafaced/issues/4199)                         | Form PR; agent LGTM                                    |

**Conflict rule**

- **Product ownership / human lock / free-to-start** → **features.mjs wins** (with ownership law + LIVE-LANES H-\*).
- **Campaign micro-sequence (“do this next”)** → **NEXT wins** for ordering only — it **cannot** erase tracker ownership or invent free work on human mountains.
- **Code existence** → **git wins** always.
- **INTACHAIN P1 timing (start now vs parked)** → [`adr/2026-09-03-protocol-rails-until-intachain.md`](adr/2026-09-03-protocol-rails-until-intachain.md) wins over dated boards. Doctrine §17 still wins on what P1 is.

---

## When to touch the product tracker (`features.mjs`)

### Required mountain events (same PR as the event)

| Event                                 | What agents write                                                           |
| ------------------------------------- | --------------------------------------------------------------------------- |
| **Claim** a free feature              | `owner` + `status: 'wip'` · `pnpm tracker` · commit registry + `TRACKER.md` |
| **Handoff / human lock**              | `owner` + note — informational only, not a start blocker                    |
| **Done** (constitution / DoD bar met) | `status: 'done'` + `requires` paths that exist · `pnpm tracker`             |
| **Cut**                               | §13 socket + honest note · not fake done                                    |
| **Wave note (optional)**              | After a merge wave that materially moves a mountain — refresh `note` once   |

### Explicitly **not** required

- Every craft / a11y / polish PR under an already-claimed `wip` row
- Pure docs-only PRs that do not change product ownership
- Path refactors that do not change feature meaning

**Denon intent (plain):** main’s product map must not _lie_ about ownership and free work. That is **not** “maximize `features.mjs` diffs.”  
**Denon 2026-08-16:** next work is a **user-visible mountain close or cut**, not leftover honesty rebases, i18n pin chains, or occupying N agent slots. `pnpm swarm:next` must not be read as permission to mint sand-castle PRs.

---

## Session claim (LIVE-LANES) — optional

Path-intersect open PRs before edit when multiple agents run. LIVE-LANES / claim files are **recommended**, not required to start.

---

## Agent cold-start (≤2 minutes)

```
git fetch origin main && git log origin/main -1 --oneline
# product free / locks (optional — do not block on this):
pnpm tracker ready   # or read tooling/tracker/features.mjs owners
# then: pick work, pnpm wt <branch>, ship
```

**Do not** wait for any human, audit seal, FREEZE, or ledger before coding.  
**Unset law** (§8 numbers, sanctions content, prod secrets): refuse-closed in code — not a reason to ping Nitro or Denon.

---

## Hard rejects (do not “improve” into these)

1. Required human review / CODEOWNERS-Approve on all agent paths
2. Cap on parallel agents or open PRs for “coordination”
3. CI rule: any code path change requires `features.mjs` diff
4. New external PM board as second product SoT
5. Making Nitro update claims by hand
6. Collapsing LIVE-LANES into features.mjs (hour-scale into product-scale)
7. Using NEXT as the only map and ignoring tracker ownership

---

## Related

- Agent batch rule (MAY vs MUST NOT edit `features.mjs`): [`TRACKER-THRASH-PROTOCOL.md`](TRACKER-THRASH-PROTOCOL.md)
- Plan + anti-list: [`TRACKER-COORDINATION-PROPER-PLAN-2026-08-02.md`](TRACKER-COORDINATION-PROPER-PLAN-2026-08-02.md)
- Evidence: [`DENON-TRACKER-TRUTH-AUDIT-2026-08-02.md`](DENON-TRACKER-TRUTH-AUDIT-2026-08-02.md)
- Claim how-to: `CONTRIBUTING.md` §3.5 · `AGENTS.md`
- CI spend: none — retired 2026-08-07, [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](GITHUB-CI-SPEND-CONTROL-2026-07-31.md)
