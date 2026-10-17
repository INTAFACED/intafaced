# Overnight grind-loop plan + current-state truth

**Date:** 2026-07-30 ~14:00 UTC · **Live tip:** `da329d3` (**#216**) · **Open PRs:** none  
**This is a plan + state check, not an execution run.** No product code changed here.

Related: `docs/GRIND-LOOP-WHAT-IT-DOES-AND-PROMPT-FIX-2026-07-30.md` · `docs/GRIND-LOOP-SAFETY-AUDIT-2026-07-30.md`

---

## Verdict (read this first)

| Question                                                            | Answer                                                                                                                                                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can we leave **the current loop as-is** overnight?                  | **Weak yes for babysit-only** if a session is still DRAINED — low activity, main green, no open PRs. **Not** a “go ham build everything” overnight.                                                 |
| Did the cook already finish “everything planned”?                   | **No.** It finished the **agent micro-queue** and babysat Denon’s wave. **Most of the product mountain list is still open** and is **Denon’s design work**, not agent free-for-all.                 |
| Is there new Denon work we hadn’t seen?                             | **Yes — active right now**, not only “planned in a doc.” Two hot branches + many older spine WIP branches.                                                                                          |
| Should agents “go all out parallel autonomous” on tracker 🟢 ready? | **No — that would invent Denon product.** Tracker “ready” ≠ “Nitro agents may ship without judgment.”                                                                                               |
| Best overnight posture                                              | **Babysit + optional Stream A / hygiene wave** under **hard merge rules** (money / review-hold = no Nitro merge). Re-open product cook only after an explicit **un-drain** with a named NEXT QUEUE. |

---

## 1. What’s actually the case (myth vs live)

### Myth you might be carrying

> “The cook planned a huge backlog, drained only because it paused, so overnight agents can go ham and build everything already designed.”

### Live truth

| Claim                                                   | Live                                                                                                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent product micro-queue empty                         | **Yes** — `GRIND-LOOP-ACTIVE.md` **Status: DRAINED** · NEXT QUEUE rows all DONE/SKIP                                                                |
| Loop still _designed_ to wake every 45m                 | **Yes** — babysit open PRs / honesty only; **must not invent product to un-drain**                                                                  |
| Loop still _actively_ shipping under your name          | **No right now** — last ZenYoda3 ship **#215** docs; no open PRs                                                                                    |
| “Planning left a free buffet for agents”                | **Partly wrong** — board has **Denon mountains** + **Nitro agent-safe** + **human-only**. Cook cleared the **micro** buffet, not Denon’s mountains. |
| Tracker “32 ready to claim” means free autonomous ships | **Mostly false** — those IDs route to **Denon** (futures, OTC, copy, algo, MM, smart-accounts, bank.earn, …) or need product forks                  |
| Mega-audit = product complete                           | **False** — verdict was **PASS-WITH-RESIDUALS**, not go-live, not product bug-free                                                                  |
| Parallel workflows “already going all out properly”     | **Mixed** — cook used parallel waves earlier; **current DRAINED mode is serial babysit**, not multi-mountain fan-out                                |

---

## 2. GitHub current state (re-derived this turn)

### Main

- Tip: **#216** blueprint share card (Denon authored + Denon merged)
- CI on tip: **green**
- Open PRs: **none**
- Merged today (sample window): heavy Denon spine + Nitro docs high-water + Nitro babysit-merges of Denon PRs

### What the cook actually did (roles)

| Role                           | What landed                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nitro cook (product micro)** | Roughly **#110–#163** era agent ships (CCXT honesty slices, notify fans, tape, etc.) then declared DRAINED; occasional post-drain micro (#162/#163) then re-drain               |
| **Nitro cook (docs/ops)**      | High-water PRs (#200, #204, #205, #212, #215…), tracker honesty, wave/mega audit archives                                                                                       |
| **Nitro babysit**              | Merged many **Denon-authored** PRs under ZenYoda3 after CI + checklist comment (#201–#214 chain)                                                                                |
| **Denon spine**                | Loans #202, CCXT answers #201, pay checkout #214, venue fabric #209, academy lobbies #208, notify channels #207, local EVM #210, test isolation #211, blueprint card #216, etc. |
| **Batch audit**                | `docs/audit/2026-07-30-afk-cook-mega/` + `…-mega-r2/`                                                                                                                           |

### What the cook did **not** do

- Did **not** finish tracker “ready” mountains (futures, OTC, copy, algo, MM-bot, full smart-accounts prod, bank.earn/cards, …)
- Did **not** merge `feat/multi-asset-instruments` (correct — Denon-only)
- Did **not** replace live rails / licences / kill drill / go-live
- Did **not** implement a full “audit → fix → debug → merge” bar on every Denon babysit (thin gate review — see prior doc)

### Denon: new / still cooking (not “already taken care of”)

**Hot (minutes ago — post-#216):**

| Branch                          | Last signal | Meaning                                                                 |
| ------------------------------- | ----------- | ----------------------------------------------------------------------- |
| `feat/spine-token-factory`      | ~13:47 UTC  | Dev-chain deploy / launch / honest tracker — **in flight, not on main** |
| `feat/spine-indexer-readmodels` | ~13:44 UTC  | Indexer sockets / wiring docs + work — **in flight**                    |

**Standing / older WIP (not open PRs; may be crash-preserved):**

| Branch                                    | Note                                      |
| ----------------------------------------- | ----------------------------------------- |
| `feat/multi-asset-instruments`            | Money enum — **must not agent-merge**     |
| `feat/spine-otc-desk`                     | Crash WIP marker                          |
| `feat/spine-derivatives`                  | Crash WIP marker                          |
| `feat/spine-bank-card`                    | Crash WIP marker                          |
| `feat/spine-agent-fleet`                  | Crash WIP marker                          |
| `feat/spine-java-custody` / `java-rename` | Custody / rename hazard                   |
| `feat/spine-market-seeder`                | Seeding books (launch-critical class)     |
| `feat/spine-venue-fabric`                 | Overlaps #209 story — don’t rebuild blind |
| others `feat/spine-*`                     | Orient before touching                    |

**Open GitHub issues** still name large ops/product programs (ops.admin, compliance, mining, market.vendors, …) — backlog, not “done by cook.”

### Tracker honesty gap (important for overnight)

Generated tracker on tip still lists some surfaces as 🟢/🔨 while code is partially shipped:

- e.g. `bank.loans` still appears in “claim now” tables while **#202 is on main** (notes elsewhere catch up unevenly)
- `blueprint.card` still 🟢 with honest “PNG rail unconfigured” residual after **#216**
- `venue.aggregation` still 🟢 with fabric on main but **not mounted in production services**
- `pay.gateway` still 🔨 — honest: hosted checkout exists, **live rail still missing**

**Do not** let overnight agents re-implement these as greenfield because a table says 🟢.

---

## 3. Three pools of work (so “go ham” has a correct target)

### Pool A — Nitro agents may ship overnight **without your product judgment**

From parallel board Column B:

| Band           | Examples                                                                                                            | Overnight fit                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Stream A shell | N1–N8: empty/error states, order-entry polish, honest empty panes, mobile drawer, i18n **in Stream A only**         | **Good** if shell/dev env available |
| Hygiene        | N10–N14: WAVE-AUDIT after Denon merges, tracker honesty, brand/custody reds that are mechanical, LIVE-LANES refresh | **Good** · low risk                 |
| Cross-stream   | File issues only when blocked on services/edge                                                                      | **Safe**                            |

**Forbidden even if “ready” in tracker:** inventing candles, balances, factory addresses, live rails, multi-asset merge, licence answers, money models.

### Pool B — Denon owns (agents must **not** “go ham”)

Column A mountains: smart-accounts **prod**, pay.rails live, futures, OTC, copy, algo, MM-bot, full CCXT product-complete beyond honesty, ops.admin real kill path, bank.earn/cards design, etc.

**Overnight:** he may open PRs from hot branches. Your loop should **babysit with rules**, not take over those mountains.

### Pool C — Human only (never agent-done)

Licences, multi-asset merge call, wallet secrets, kill-drill sign-off, go-live, sanctions **content**, CI billing policy if it dies again.

---

## 4. Overnight recommendation (decision table)

### Option O1 — **Babysit-only (recommended default)**

**Keep the loop running** in DRAINED mode with **enhanced merge law**:

| Rule                                                 |                                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| Money / custody / ledger / pay / bank / withdraw     | **No Nitro merge** unless Denon comments “merge when green”            |
| PR says “not for fast merge” / needs review          | **Hard stop** — comment only                                           |
| Non-money Denon PR, CI+local green, no hold language | Optional merge **or** leave for Denon (prefer leave if he is online)   |
| No open PRs                                          | Doctrine/tracker honesty only · update high water · stop (no ceremony) |
| Never invent product to un-drain                     | Hard                                                                   |

**Overnight risk:** low.  
**Overnight upside:** Denon PRs get gate-checked; high water stays honest if docs PR allowed.  
**What will _not_ happen:** mountain of new Nitro features.

### Option O2 — **Babysit + Stream A / hygiene fan-out (recommended if you want “agents working”)**

Same merge law as O1, **plus** 2–3 parallel worktrees:

1. Stream A honesty/polish (one PR per concern, `feat/app-*` only)
2. Tracker honesty vs main (fix false 🟢 for bank.loans etc. if still wrong)
3. LIVE-LANES + grind high water → **#216+** (docs only)

**Overnight risk:** medium (UI churn, brand scan).  
**Upside:** visible progress without Denon collisions.  
**Requires:** shell/dev reachable; claim board updates.

### Option O3 — **“Go ham” on all tracker 🟢 ready (not recommended)**

Would mean agents inventing futures/OTC/copy/rails/etc.  
**Overnight risk:** high — money doctrine, partner collision, false done.  
**Do not.**

### Option O4 — **Stop the loop completely**

Only if you distrust any surviving AFK session.  
**Cost:** Denon PRs sit until he merges (which his policy already allows).

### Overnight pick (this plan’s default)

**Run O1 always. Add O2 only if you want active Nitro shipping.**  
**Do not run O3.**

---

## 5. Enhancement plan (what to upgrade and why)

Completeness = every enhancement named; detail compressed.

### E1 · Split law files (why: one prompt currently means three jobs)

| Piece                  | Job                                               |
| ---------------------- | ------------------------------------------------- |
| `GRIND-LOOP-ACTIVE.md` | Queue + high water + Status only                  |
| Babysit policy block   | Merge privileges (money = no)                     |
| Cook prompt            | Only when Status=RUNNING + non-empty NEXT QUEUE   |
| Un-drain protocol      | Who may set RUNNING and what must be listed first |

**Why:** DRAINED + “GO NEXT QUEUE” + “babysit-merge Denon” in one paste caused rubber-stamp merges.

### E2 · Merge privilege matrix (why: your audit→fix→debug bar)

Ship into grind law (from prior prompt-fix doc):

- CLASS M money → no Nitro auto-merge
- Review-hold language → no merge
- CLASS N Nitro PRs → full bar then merge
- Always: PR comment with what was verified / **not** verified

### E3 · Un-drain is a deliberate act (why: empty queue ≠ “go invent”)

To set Status **RUNNING** overnight/autonomy must:

1. List **named** NEXT QUEUE items from Pool A only (or Denon-assigned tickets)
2. Claim lanes in `LIVE-LANES.md`
3. Cap parallel mountains (e.g. ≤3) with **non-overlapping paths**
4. Wave audit every 3–4 product ships

### E4 · Tracker vs main reconciliation job (why: false 🟢 causes rebuilds)

Overnight-safe agent job: `pnpm tracker` honesty — mark done/wip notes to match #201–#216 reality (loans, venue fabric partial, pay checkout partial, blueprint card partial).

### E5 · Denon WIP radar (why: “did cook take care of it?”)

Each babysit fire:

```
gh pr list --state open
git ls-remote origin 'refs/heads/feat/spine*'
# note hot branches; never force-push / never take multi-asset
```

Do **not** open competing PRs on his hot branches.

### E6 · Stale WIP branch quarantine (why: crash markers look like free work)

Branches with `wip(…): process crashed` are **not** free cook targets until Denon reclaims or deletes. Overnight agents: list them, don’t resume blindly.

### E7 · CI spend guard (why: overnight can burn Actions minutes)

Keep path filters; prefer docs-only without full CI burn when possible; if billing fails → local green + honest “Actions not green” — never fake.

### E8 · Proof surface for you (why: you don’t read code)

Every fire ends with a 5-line STATUS block in grind file or Telegram-ready comment:

```
STATUS <time>
tip: <sha> #<n>
open PRs: <n>
merged this fire: <list or none>
money holds: <list>
next: babysit | stream-A PR | stopped
```

### E9 · Parallel workflow shape (when O2)

| Lane                  | Owner         | Branch prefix            | Do not touch       |
| --------------------- | ------------- | ------------------------ | ------------------ |
| babysit               | grind session | (no product branch)      | inventing features |
| stream-a-1            | agent         | `feat/app-*`             | `services/**`      |
| stream-a-2 or hygiene | agent         | `feat/app-*` or `docs/*` | money packages     |
| denon                 | Denon         | `feat/spine-*`           | Nitro force-push   |

Use worktrees; update LIVE-LANES on claim/release.

### E10 · Fix known honesty bugs in law file (why: next compact lies)

- High water **#214 → #216+**
- Human-only “chain factory **done**” vs “prod still human” contradiction
- LIVE-LANES stale #182 open / tip ~#169

---

## 6. Execution plan if you say “enhance then overnight”

**Phase 0 — 15 min (human decision)**

- Confirm O1 or O1+O2
- Confirm money **no Nitro merge**

**Phase 1 — Law PR (docs only, one PR)**

- Patch GRIND-LOOP-ACTIVE: Status, high water, merge matrix, STATUS block, un-drain rules
- Refresh LIVE-LANES
- Paste cook vs babysit prompts

**Phase 2 — Start overnight session(s)**

- One babysit session with enhanced prompt
- If O2: 1–2 Stream A/hygiene sessions with lane claims

**Phase 3 — Morning check (you or agent, 5 min)**

- `gh pr list` · tip CI · STATUS block · any money holds left open for Denon

**Not in overnight scope:** futures, live rails, multi-asset merge, resuming crash WIP spines, go-live.

---

## 7. Completeness checklist (this plan’s named set)

| #   | Item                          | Covered             |
| --- | ----------------------------- | ------------------- |
| 1   | What loop is doing now        | Yes §1–2            |
| 2   | What cook built vs left       | Yes §2              |
| 3   | Denon new work not on main    | Yes §2 hot branches |
| 4   | Tracker “ready” vs agent-safe | Yes §3              |
| 5   | Overnight O1–O4 + pick        | Yes §4              |
| 6   | Enhancements E1–E10           | Yes §5              |
| 7   | Execution phases              | Yes §6              |
| 8   | Myth of parallel go-ham       | Yes §1, §4 O3       |
| 9   | Merge bar vs your standard    | Yes E2 + prior docs |
| 10  | Human-only / no-fake list     | Yes §3 Pool C       |

---

## 8. Plain answers to your exact questions

**“Keep the loop running if good, but enhance?”**  
Keep **babysit** running after enhancements (E1–E2, E10 minimum). Do **not** keep rubber-stamp money merges.

**“Can it run overnight?”**  
**Yes under O1** (and O1+O2 if you want shell progress). **Not** as unbounded product cook on all ready tracker rows.

**“What did it actually do?”**  
Cooked agent micro product → drained → mega-audited → babysit-merged Denon’s spine wave → docs high water. **Did not** clear Denon’s backlog or the full tracker.

**“As far as I know cook already planned and backed out work for agents?”**  
Cook’s **own** NEXT QUEUE is empty on purpose. Broader **planning** (parallel board + tracker) still has a mountain — mostly **Denon**, plus **Stream A** for your agents.

**“Fully autonomous parallel go all out?”**  
That was true for **micro-queue waves** earlier. **Not** the present DRAINED state. Turning that back on without a Pool A queue = inventing product = the failure mode.

**“New Denon plan we didn’t see?”**  
Not a single new master plan file — **live branch work**: token-factory + indexer-readmodels **now**, plus older spine WIPs and standing issues. Cook did **not** absorb those.

---

## 9. What you decide next

Reply with one:

| Say          | Meaning                                                      |
| ------------ | ------------------------------------------------------------ |
| **O1**       | Babysit-only overnight + merge harden (recommended baseline) |
| **O1+O2**    | Same + Stream A/hygiene parallel                             |
| **Law only** | Docs PR for enhancements; don’t start overnight yet          |
| **Stop**     | Kill grind autonomy until morning                            |

Default if silent: treat **O1** as the safe assumption — do not un-drain product cook.
