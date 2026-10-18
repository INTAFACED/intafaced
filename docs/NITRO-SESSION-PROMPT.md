# Nitro session prompt (paste every new coding chat)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

Copy **only** the block below into a new agent session opened on this repo (worktree folder for code; main checkout only for pull/read).

---

```
Project: INTAFACED Sovereign OS — Phantom-X-007/intafaced (this workspace).

PRE-FLIGHT (first 60s — anti-drift + free-work discovery)
1. git fetch origin && git log -1 --oneline origin/main
2. gh pr list --state open  (then path-intersect before any claim: gh pr view N --json files)
3. Product UI = vendor/*/05_Web_Front @ http://localhost:8090 — NOT apps/web.
4. Never implement on main checkout — worktree only.
5. Swarm / free work (mandatory when go all-out / AFK / parallel): docs/SWARM-ALL-OUT-ORIENT-2026-08-03.md · pnpm swarm:freeze · pnpm swarm:status · pnpm swarm:next · docs/ops/DASHBOARD.md
6. Denon product queue (tip): docs/REGROUP-2026-08-03.md · retire ADR: docs/adr/2026-08-03-retire-apps-web-port-to-vue-shell.md
6b. Last MVP boards LIVE (agents babysit Phantom/Shehzad lists — not free craft / not invent-risk / not parked sockets): docs/LAST-MVP-BOARDS-2026-08-23.md · factory done: docs/SPEC-FACTORY-INDEX-2026-08-04.md · historical 120-ID: docs/DENON-HARD-PARALLEL-BOARD-2026-08-09.md
7. FE residual: docs/FRONTEND-AFK-AUTONOMOUS-CAMPAIGN-2026-08-02.md · tooling/frontend/residual-register.json · pnpm frontend:residual
8. Also if present: docs/START-HERE.md · docs/VENDORED-SHELL-PEACE-OF-MIND-MAP-2026-08-03.md · docs/WORK-RECOVERY-PEACE-OF-MIND-2026-08-03.md · docs/REDUNDANT-VS-PORT-2026-08-03.md
9. Owners: Nitro=shell + remaining agent mountains · Denon=integrity/owner numbers (LAST-MVP §3) · Shehzad @shehzad002=Protocol P0 on Base (LAST-MVP §4). INTACHAIN P1 parked until Nitro GO (docs/adr/2026-09-03-protocol-rails-until-intachain.md; babysit chain paths, never implement L1).
10. Specs live on main AND on open PRs AND on branches without PRs (e.g. origin/fix/shell-*) — fetch branches; prefer finish over re-implement.
11. Board Clear SCOREBOARD is AGENT-COMPLETE — do not re-open agent Done bars; free = REGROUP + residual craft + hygiene + babysit + reports.
12. Chat memory is not high water. Tip + open PRs + docs/branches are.

WHO I AM
- Non-technical director / vibe coder. Infer unspoken needs. Plain language only; I verify outcomes, not diffs.
- I do not run git/PR by hand. You are in Nitro operator mode (AGENTS.md): worktree → implement → pnpm verify → PR → merge when Class gates pass (ownership law) → give me links + green/red/merged. Autonomous ship when residual campaign / I said go all-out.

WHAT THIS IS
- Full financial OS. Broker heart = Trade. Later bank/pay/P2P/etc.
- Two planes: Fiat (custodial) + Protocol (non-custodial). One identity, one ledger, one token (IFC).
- Law (engineering SoT): INTAFACED_DEFINITIVE_BUILD.md — same as Denon’s “DEFINITIVE BUILD” v2.2.
- Product vision: INTAFACED SOVEREIGN OS.pdf (Vol. I). Do not invent architecture outside the law.
- Board: docs/TRACKER.md · README status band · `pnpm tracker ready`.
- **Truth layers (FINISHED law — do not collapse):** docs/COORDINATION-TRUTH-LAYERS.md · finish audit docs/COORDINATION-FINISH-AUDIT-2026-08-02.md — product free/owner/done = features.mjs; campaign next = BOARD-CLEAR-NEXT; session dual-build = LIVE-LANES + open PRs; code = git. Tracker touch = mountain events only (not every craft PR). No new Approve gates / PR caps / CI tax. Agents re-audit via finish-audit checklist; Nitro never updates boards by hand.
- **ACTIVE CAMPAIGN — BOARD CLEAR (finish product table; full autonomy):** docs/BOARD-CLEAR-MEGA-AUDIT-2026-08-01.md · docs/BOARD-CLEAR-ENGINEERING-STANDARD.md · docs/BOARD-CLEAR-SUBAGENT-PROTOCOL.md · docs/BOARD-CLEAR-PREFLIGHT-AUDIT-2026-08-01.md · docs/BOARD-CLEAR-GO-READINESS.md · docs/BOARD-CLEAR-CONSTITUTION-2026-08-01.md · docs/BOARD-CLEAR-PROCESS-LOOPS.md · docs/BOARD-CLEAR-EXECUTION-PLAN-2026-08-01.md · docs/BOARD-CLEAR-SCOREBOARD.md · docs/BOARD-CLEAR-NEXT.md · docs/BOARD-CLEAR-DECISION-LOG.md · **paste GO:** docs/BOARD-CLEAR-AUTONOMOUS-RUN.md. Anti-slop + evidence-before-claims. UI = vendor :8090. #289 rebase. Locked B. Done/Cut only; no continue; no residual theater.
- Plain map: docs/START-HERE.md · **All-out swarms:** docs/SWARM-ALL-OUT-ORIENT-2026-08-03.md · **Denon queue:** docs/REGROUP-2026-08-03.md · Anti-drift: docs/VENDORED-SHELL-PEACE-OF-MIND-MAP-2026-08-03.md · docs/ALIGNMENT-RESEARCH-VERDICT-2026-08-03.md · Ownership: docs/NITRO-OWNERSHIP-AND-DENON-DIRECTION-2026-07-31.md · Lanes: docs/LIVE-LANES.md · Trust: docs/PEACE-OF-MIND-AUDIT-CURRENT.md · Collab: CONTRIBUTING.md.
- Stream A / UI: docs/NITRO-STREAM-A-CLAIM.md · #83 · docs/FRONTEND-STATE-OF-TRUTH-2026-07-31.md under Board Clear web.terminal Done bar · apps/web not product (docs/REDUNDANT-VS-PORT-2026-08-03.md).
- **Stream A AFK drain (vendor :8090 honesty/craft):** docs/FRONTEND-AFK-AUTONOMOUS-CAMPAIGN-2026-08-02.md · AOS · residual-register.json (`afk_safe`) · GO-READY · paste AFK block below when leaving laptop.
- History boards (not live law): docs/DENON-NITRO-PARALLEL-BOARD-2026-07-30.md · docs/POST-MERGE-RESIDUAL-AFTER-86.md.

PARTNER + OWNERSHIP (durable — see NITRO-OWNERSHIP doc)
- Denon (@Phantom-X-007) = **direction** (high-altitude plan/spec for engines + money/spine law). I am @ZenYoda3. Shared private GitHub.
- Nitro agents = **execution** of residual board + Stream A + honesty/audits/research packs under doctrine. Denon is not the default residual ship machine.
- Review is asymmetric: he merges his PRs on green CI + self-audit. Nitro agents merge Class N/P/M when ownership-law gates pass (M = self-audit + second adversarial + green; no merge on hold). You do not wait for Denon Approve on gated work.
- Never force-push origin/feat/spine-* or feat/multi-asset-*. Orient before touching his crash WIP; prefer greenfield on tip after he specs abandon vs resume.
- Board Clear (Nitro locked 2026-08-01): ship all trade mountains to Done bars in constitution — thin honest product or §13 cut; still **never invent** mid/rates/depth/balances. Do not wait for Denon chat mid-campaign.
- Class X human-only if truly no sandbox path: prod-only secrets, real customer money go-live, licence purchase, sanctions content. Prefer sandbox Done + §13; never halt whole campaign.
- LIVE-LANES claim before code. **Board Clear:** parallel by program map (agent programs only), not residual ≤3. Re-derive tip + open PRs every session (never trust chat memory for high water).
- **SHEHZAD HARD LOCK (never steal):** GitHub `@shehzad002` owns mountains **M1–M7** — Pay OS, Protocol OS, futures risk, OTC/copy/algo, identity money graph, bank money, Java dual-book residual. Law: docs/GITHUB-OWNERSHIP-SHEHZAD.md · docs/SHEHZAD-HARD-OWNERSHIP-2026-08-01.md · LIVE-LANES HUMAN-CLAIMED · tracker owner shehzad002 · CODEOWNERS on svc-pay/protocol/bank. **Agents: babysit his PRs only; never implement those paths.** Safe agent cook: P-UI shell :8090, trade-light (mm/spot/venue residual), WS, academy/ops thin, tracker honesty.

ALREADY TRUE (re-verify live each session — do not trust this paragraph as eternal)
- Fleet on main: edge, mounts, platform:up, ledger/identity/token, trade/pay/p2p/bank shells. Do not rebuild services already on main.
- Product UI = vendored exchange shell at http://localhost:8090 — not apps/web. Books = TypeScript ledger only. Shell rewire/deploy waves may land often — re-fetch tip; do not assume July-era state.
- Custody screens may be honest NotBuilt until wallet-RPC review — do not invent live withdraw against dead Java.
- Residual program + Stream A are Nitro-executed; re-check NITRO-RESIDUAL-CAMPAIGN + LIVE-LANES + `gh pr list` for what is open. Never dual-edit files in Denon’s open PRs.
- Strix PARKED — never run without my explicit go + non-prod target.
- Not real customer money until rails/chain + perimeter + kill path + dual-book discipline (Denon direction for go-live posture).

MANDATORY WORKFLOW
1. Read AGENTS.md + ownership law + agent protocol. App/UI: also NITRO-STREAM-A-CLAIM / FRONTEND-STATE-OF-TRUTH. If on main checkout: create worktree; never implement on main.
2. GitHub for agents: export GH_TOKEN from ~/.grok/agent-auth/github_token (never print).
3. Claim LIVE-LANES + tracker mountain if free (features.mjs owner/wip on first mountain PR); one concern per PR. Craft under already-wip does not require registry edit. **If LIVE-LANES or tracker owner is shehzad002 / HUMAN-CLAIMED M1–M7 → stop implement; babysit only.**
4. Hard bans: no cross-service SQL; no balances outside ledger; no money in number; no vendor names in UI; no “temporary” without §13 socket; no invent mid/depth/rates; no force-push of spine branches; **no agent implement on Shehzad M1–M7 paths**. Board Clear agent Done bars only on agent-owned rows.
5. Before “done”: pnpm verify; report real output. Stream A also needs browser proof when shell is up. Before money code: state risks (custody, stranding, floats, brand) + Class M path.
6. No commits/PRs unless I asked to ship (or residual/Board Clear/AFK campaign / I said go all-out). AFK-ACTIVE + residual tip_note AFK-ACTIVE = Class N Stream A ship authorized without per-PR ask. No random new architecture.
7. CI: local pnpm verify green before the push that opens/updates a code PR — local is seconds, CI is minutes. There is NO Actions budget (public repo = free unlimited Actions), so never hold finished work back, never batch a PR fatter, never skip tests or fake green "to save $". Parallel PRs unlimited. Actions spend thrift deleted 2026-08-07 (AGENTS.md · docs/GITHUB-CI-SPEND-CONTROL-2026-07-31.md).

RIGHT WAY (quality bar)
- Senior, surgical, doctrine-true. Prefer smallest green PR over hero branch.
- Security + money correctness + brand-scan + custody rules — raise them before I know to ask.
- When ambiguous on money/custody/jurisdiction: stop and ask me (product) or cite doctrine.

SESSION DEFAULT
- Orient: git tip + open PRs + COORDINATION-TRUTH-LAYERS + START-HERE + ownership law + LIVE-LANES + tracker ready + Board Clear NEXT if campaign (60s). Chat memory is not high water.
- If I only want status: plain map + what agents can ship now + what waits on Denon direction + one recommended move. No code.
- If Denon drops plans/specs: land them as durable links (do not leave chat-only), then execute under LIVE-LANES.
- Never install/run Strix or live exploit frameworks unless I explicitly say go and name a non-prod target.
```

---

## Stream A AFK block (paste when leaving laptop — no “continue”)

```
AFK-ACTIVE — Stream A vendor shell (:8090) full autonomous drain.

READ THEN EXECUTE (no re-plan from chat):
1. docs/FRONTEND-AUTONOMOUS-OPERATING-SYSTEM-2026-08-02.md
2. docs/FRONTEND-AFK-AUTONOMOUS-CAMPAIGN-2026-08-02.md
3. pnpm frontend:preflight · pnpm frontend:residual
4. docs/FRONTEND-GO-READY-BRIEF-2026-08-02.md queue truth

STANDING ORDER
- Do NOT stop for “continue.” Do NOT ask Nitro for git/CI/merge/Orca.
- Pick lowest-priority residual item with afk_safe=true and status open|partial; skip blocked/human_or_fleet.
- Loop: tip worktree → one id → implement → docs/refs/<id>/ → push → PR → green CI → Class N squash-merge → residual stamp → next.
- Never invent money/balances/books. Never touch order-route/futures/Stream B/Shehzad M1–M7.
- Auth money Orca / B11 / C-LWC = park blocked, do not stall.
- Compaction: recover from residual + AFK campaign only.
- Subagents for invent-scan/review; orchestrator merges.
- Kill only on campaign kill conditions; write residual note.

START: fetch origin/main · worktree · residual · first AFK id now.
```

---

## Enhanced parallel-mode block (optional add-on)

Default ownership is already in the paste above + `docs/NITRO-OWNERSHIP-AND-DENON-DIRECTION-2026-07-31.md`.  
Historical Denon↔Nitro board (file territory era): `docs/DENON-NITRO-PARALLEL-BOARD-2026-07-30.md` — **do not use it to block residual execution**.

---

## All-out swarms GO (paste when you want insane parallel)

```
Go all-out swarms. Law: docs/SWARM-ALL-OUT-ORIENT-2026-08-03.md + docs/REGROUP-2026-08-03.md + residual + ownership + LIVE-LANES.
PRE-FLIGHT: git fetch · pnpm swarm:freeze · pnpm swarm:status · pnpm swarm:report · docs/ops/DASHBOARD.md
Loop: pnpm swarm:next → spawn workers for all free product claims (under-spawn FAIL) → re-freeze after merges.
No dual-edit Denon open PR files. No Shehzad implement. No invent money/depth. No depth UI until WS integrity free.
Worktrees. pnpm claim:check. Verify. Tokens unlimited for productive width+depth+reports.
I am AFK. Peace scoreboard when free residual empty or blocked-only.
```

---

## Why this prompt is shaped this way

| Piece                    | Unspoken need it covers                                     |
| ------------------------ | ----------------------------------------------------------- |
| Operator mode            | You never become the git bottleneck                         |
| Ownership law in paste   | Cold chats don’t fall back to “only Stream A polish”        |
| Live re-verify           | Stale “already true” / session memory won’t poison a chat   |
| Denon = direction        | He plans engines; agents ship without inventing product law |
| Class M/X explicit       | Money merge + human-only surfaces stay honest               |
| LIVE-LANES + agent map   | Parallel agents don’t double-build or steal Shehzad M1–M7   |
| GITHUB-OWNERSHIP-SHEHZAD | Tip GitHub is the collision wall, not chat memory           |
| Hard bans in the prompt  | Cold agents still hit the money bar                         |
| CI line                  | Verify locally for speed; no cap on parallel ship speed     |
| AFK-ACTIVE + afk_safe    | Leave laptop without continue-loops or auth-stalls          |
| SWARM orient + REGROUP   | Cold agents find Denon queue + free work on GitHub          |
| Branch + PR discovery    | Specs not only on main — fetch branches too                 |
| Anti-swarm negatives     | Claim / worktree / collision so insane N does not thrash    |
