# Nitro L3 slice factory law

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** standing · **Owner:** Nitro agents · **Date:** 2026-08-05  
**Stacks with:** 24h build program · continuation ladder · partner/Shehzad bans  
**Does not replace:** Denon L1 product law · Class X · dual-edit bans

Denon has mapped the project at product-law scale. That is **L1**. It is **not** missing “nitty-gritty specs.”  
Nitty-gritty is **L3 PLANNING** — Nitro’s job (agents under Nitro).  
`freeProduct=0` never means “wait for Denon to re-spec the whole product.”

---

## Layer model (bind this)

### L1 — PRODUCT LAW (Denon direction)

|                |                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Home**       | ADRs, SPEC-\*, DIRECTION, SPEC-FACTORY-INDEX, doctrine                                                               |
| **Content**    | what may exist · non-goals · refuse cases · money/custody/spine · “agents may implement against this”                |
| **Agents**     | **IMPLEMENT against L1.** Never rewrite L1. Never invent L1 gaps as code truth.                                      |
| **Partial L1** | e.g. D-S-01/07 mark/funding: implement **only** the decided half; blank half → human-blocker or Denon PR, not invent |

### L2 — OVERVIEW BLANKS (still Denon / owner §8 — big rules only)

|                |                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Examples**   | futures mark & funding law; fee/share/copy/launch **NUMBERS**; commercial sockets (sponsor bank / BIN); Class X content |
| **NOT L2**     | Stage-2 checklists, file lists, test matrices, claim text, spawn order for mountains that already have L1               |
| **If blocked** | write **one** human-blocker row with the exact missing rule. Keep shipping all path-clear L3                            |

### L3 — BUILD PLANNING = “LOWER SPECKING” (Nitro + agents — DEFAULT WORK)

This **is** planning, and it **is** how we generate infinite tasks without a new Denon encyclopedia.

For every mountain with L1 on tip and Stage-1 (or any slice) merged:

1. Read `docs/ops/trk/<id>.md` + related ADR/SPEC
2. Write the **NEXT** slice pack: goal · non-goals · Done bar · paths · Class N/P/M · tests · proof · claim id
3. Claim → worktree → fat PR → merge on green → claim merged with PR#

- L3 may deepen thin tracker specs to ≥100 lines **only** when code-grounded and non-money (or Class M held).
- L3 may open “research → implement” packs from existing L1 **without asking Denon**, **unless** the pack would invent product truth (new engine shape, new money rule, invent rates) — then **STOP** and flag for Denon green-light / L2.

---

## Who specs what (Nitro clarity)

| Need                                                    | Owner                                       |
| ------------------------------------------------------- | ------------------------------------------- |
| “What is the product allowed to be?”                    | Denon L1                                    |
| “What number / commercial relationship is still blank?” | Denon or Nitro human L2 / §8                |
| “What do we build next week as tickets?”                | Nitro L3 (you + agents)                     |
| “Green-light that my plan doesn’t invent law?”          | Denon once per invent risk — not per ticket |

---

## freeProduct=0 → RUN THE L3 FACTORY

Nitro’s goal: agents **always** have L3 tasks. When free board empty → **do not idle**:

1. Enumerate mountains with L1 done and Stage-N incomplete (trk + claims)
2. Mint next slice packs (fat, path-disjoint, Class-correct)
3. Spawn width 3–6; one concern per PR (no run budget to batch around)
4. Partner open PR paths = hard wall (Denon/Shehzad dual-edit ban)
5. Shehzad protocol/INTACHAIN = babysit only

**Swarm starvation is a FAILURE of L3 factory, not of Denon L1.**

---

## Plan completeness (every L3 pack must name)

1. **Outcome** in one sentence (user/operator visible)
2. **Non-goals** (what we refuse this slice)
3. **Done bar** (checkable: tests / gate / tip proof)
4. **Paths allowlist** + path-intersect vs open partner PRs
5. **Class** N / P / M / X and why
6. **Depends on** (L1 doc + prior slice PR#)
7. Explicit: **does NOT invent L1/L2** OR **needs Denon green-light because …**
8. **Board-Delta** one line for the PR
9. **Consumer** — name the **existing** file that will import this slice, **or** state that the slice imports a real source and guards it. A slice with no reachable consumer is not a slice (see Reachability law).

---

## Reachability law (added 2026-08-07 — binding)

**Why this exists.** Between roughly #905 and #946 the factory produced **151 catalog modules that nothing
imports**, each re-declaring a constant that already exists elsewhere, with a test asserting the copy against a
hardcoded literal. Every one passed doctrine gates, format, typecheck, tests, CI and the stamp-mill gate — the
gate led with `docsOnly`, so code PRs were never checked (#884). 22k lines, zero reachable behaviour, and each
copy is a silent drift trap: change the real list and the copy disagrees while CI stays green.

**The ban, by name:**

1. **Never copy a constant and then assert the copy.** If a catalog already exists in the codebase, the only
   legal slice against it **imports it** and guards it. Re-declaring the values is banned.
2. **Every slice names a consumer** (plan completeness §9). "An operator board will use it" is not a consumer
   unless that board exists on tip and the PR wires it.
3. **A green test is not a Done bar** when the module under test is imported by nothing.
4. `freeProduct=0` still never authorises manufacturing work. Minting a pack that satisfies the template shape
   while reaching nothing is the stamp mill in a `feat(` wrapper.

**Machine enforcement — LIVE:** `tooling/ci/reachability-scan.mjs`, doctrine gate `reachability`, runs in
`pnpm gates` / `pnpm verify` / CI. A non-test module that imports nothing from the repo **and** is imported by
nothing outside its own test **fails the build**. Verified both ways on 2026-08-07: clean on the cleaned tree
(387 modules), and red within one second when a single deleted copy is restored.

**PARKED — built, specced, awaiting a caller.** Six real Stage-1/Stage-2 modules (~2,384 lines) pass the ban on
manufacturing but have no caller yet: ambassador residency, paper workbook loop, copy-intel stats, merchant
watch, scanner rank, support comment draft. They are listed by name with a reason in the scan's `PARKED` map so
unwired work stays **visible and owed** rather than invisible. **The list may only shrink** — when a parked
module gains a caller the gate fails until its row is deleted. Adding a row is a decision to owe the wiring, not
a way to pass.

### Protected keep-list — these 9 `*-honesty.ts` files are real and must never be swept

They import a live source and assert against it. Four guard the agent **money-tool deny lists**. Deleting any of
them removes a safety property. Never delete `*-honesty.ts` by filename pattern — only by explicit list.

- `packages/config/src/fiat-currency-honesty.ts`
- `packages/config/src/module-id-honesty.ts`
- `packages/contracts/src/analytics-metric-honesty.ts`
- `services/svc-agents/src/copy-intel/money-deny-honesty.ts`
- `services/svc-agents/src/merchant/guardrail-honesty.ts`
- `services/svc-agents/src/navigator/money-deny-honesty.ts`
- `services/svc-agents/src/support-agent/money-deny-honesty.ts`
- `services/svc-identity/src/affiliates/commission-tier-honesty.ts`
- `services/svc-notify/src/channels/refusal-code-honesty.ts`

---

## Implicit requirements (infer, don’t wait)

From L1 always carry into L3 without re-asking Denon:

- No fabricated money / empty≠zero / decimal strings on wire
- No balances outside ledger-client; no money as `number`
- One surface `:8090` Vue shell; `apps/web` stays dead
- `freeProduct=0` ≠ platform done; stamp mill still banned
- Money-prefix tracker stays gated until Nitro opens a wave OR L1+Class M path is clear
- If a “spec” is only a pointer gap (law already on tip), **implement** — do not re-spec

---

## Denon touchpoints (rare, high value)

Ping Denon **only** when:

- L2 blank blocks a money/risk engine half
- An L3 pack would invent product law or §8 numbers
- Partner integrity/money PR needs his judgment (**never dual-edit to “help”**)

Do **not** ping Denon to approve routine Stage-2/3 planning packs that stay inside L1.

---

## Slice pack home

`docs/ops/slices/` — one file per wave batch or per slice.  
Claims stay `docs/ops/claims/`.

## Success

Standing order: when free board empty → mint L3 packs from existing L1 → spawn → ship → repeat — **only for packs that name a reachable consumer.** A pack nothing can reach is not shipped work; see Reachability law.  
This law stacks with the 24h build program and the continuation ladder; it does **not** replace partner/Shehzad bans.
