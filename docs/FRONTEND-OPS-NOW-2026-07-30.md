# Frontend ops NOW — peace-of-mind board

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** LOCKED · 2026-07-30 (post Orca-browser proof)  
**Audience:** Nitro (plain) + agents (binding)

---

## What changed (prior audit was right)

| Old Day-0 story                                        | New truth                                                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Nitro must launch Chrome + install chrome-devtools-mcp | **Not required for normal Stream A proof**                                                                     |
| Browser blocked by macOS / Playwright                  | the agent shell shell sandbox blocks loopback; **Orca embedded browser bypasses that** (app does the browsing) |
| Orca browser written off as dead                       | Was **stale_bootstrap** earlier; when `orca status` → app running + runtime ready, browser works               |

**Verified this turn [disk]:**

- `orca status`: app **running**, runtime **ready**, capability `browser.screencast.v1` present
- Skill surface: `goto`, `snapshot`, `screenshot`, `full-screenshot`, `click`, `fill`, `type`, `scroll`, `eval`, `console`, `network`, `tab create/list`, wait helpers, a11y-style snapshot refs
- Safety: Orca browser is its **own partition** (`persist:orca-browser`), not personal Chrome/Brave
- Catch: **Orca desktop app must be running** — if agents say browser dead, `orca status` then `orca open`
- **Product shell is NOT up** right now: nothing on :8090 / :8094

**Fallback (not Day-0):** Chrome debug port + chrome-devtools-mcp for Lighthouse, deep network forensics, headless CI — only if Orca cannot cover the job.

---

## What Nitro must install

**Nothing.** Day-0 install list = **zero**.

### What Nitro must keep true (habits, not installs)

1. **Orca app stays open** when agents are doing frontend proof.
2. **Do not** log into personal banks/email inside Orca’s agent browser tabs (isolated, but treat as agent-visible).
3. **You are not the test runner** — agents boot the shell and take screenshots.
4. **You still decide:** brand (lime vs orange), apps/web spike vs freeze, RSI/MACD panes, admin users, go-live.

If Orca ever looks dead: open the Orca app (or tell an agent `orca open`). That is the whole “fix.”

---

## How we move forward (right leverage)

### System of record (read order for agents)

1. **This file** — ops NOW
2. `FRONTEND-INTERNET-LEVERAGE-PACK-2026-07-30.md` — decisions + harvest (Orca eyes supersede its §2 Chrome-first wording where they conflict)
3. `FRONTEND-LEVERAGE-ENHANCED-GROK-2026-07-30.md` — errata + two-week board
4. `FRONTEND-LEVERAGE-CATALOG-REPOS.md` — ~70 verified assets
5. `FRONTEND-FINAL-BLUEPRINT-2026-07-30.md` — full UI map
6. `NITRO-AGENT-PACKAGES-2026-07-30.md` — live endpoints

### Proof loop (primary)

```
orca status --json          # must be ready
# agent boots shell → :8090 (or ui:boot port)
orca tab create --url http://127.0.0.1:8090 --json
orca snapshot --json        # element refs
orca screenshot --json      # visual proof
# click/fill as needed; re-snapshot after navigation
```

**Never:** foreground `npm run dev` inside agent tools (hangs sessions). Background boot / docker / existing `ui:boot` only.

### Build loop (product)

| Order | Work                                                                | Why                                   |
| ----- | ------------------------------------------------------------------- | ------------------------------------- |
| **0** | Boot shell + first Orca screenshots of terminal + one uc page       | Eyes on                               |
| **1** | Port **IxState** / module-mixin to **money** screens (uc)           | In-repo honesty system already exists |
| **2** | bignumber for withdraw display math (after vet)                     | Trust figure                          |
| **3** | Chart attribution link (manual tradingview.com)                     | Licence                               |
| **4** | Order ticket precision from `/api/v1/markets`                       | Live endpoint                         |
| **5** | Overlay indicators only (stay LWC v3.8 unless Nitro wants v5 panes) | Catalog                               |
| **6** | Density/polish                                                      | **After** brand decision              |

**Reuse before harvest.** Catalog is for patterns when in-repo is insufficient — not for vibe inventing.

### Agent orchestra

| Role                                      | Tool              |
| ----------------------------------------- | ----------------- |
| Plan / audit / money certify              | strong agent tier |
| Implement / bulk / PR                     | Grok              |
| Worktrees + **browser proof** + terminals | **Orca first**    |
| Personal Chrome MCP                       | Fallback only     |

One agent per worktree. LIVE-LANES claim. Tip of `origin/main` only.

---

## Cognitive-depth translation (what this means for you)

You do **not** need to understand webpack, MCP, or Vue.

You need to know four facts:

1. **Research is done enough to build** — path, full screen map, internet catalog, licence traps, in-repo systems.
2. **Agents can see the UI through Orca** — no Chrome homework for you.
3. **Your job is keep Orca open + answer rare product questions** (look, brand, go-live).
4. **Peace of mind check:** agents show screenshots in PRs; if they claim “done” without a picture of :8090, reject the claim in one sentence.

---

## Peace-of-mind checklist

| Question                         | Answer                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| Do I install something tonight?  | **No**                                                                                   |
| Is Orca the right eyes?          | **Yes — primary** (when app running)                                                     |
| Is the product server running?   | **No — agents must boot it**                                                             |
| Are we still lazy on repos?      | **No** if agents follow leverage pack + reuse IxState first                              |
| What’s the first real ship work? | Boot shell → Orca proof → IxState on uc money screens                                    |
| What can still block us?         | Orca closed; shell not booted; working on stale main; inventing instead of catalog/reuse |

---

_Update when first :8090 Orca screenshots land or tip SHA moves._
