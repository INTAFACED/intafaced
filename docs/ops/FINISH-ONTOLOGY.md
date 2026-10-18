# Finish ontology — when a session is done

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** BINDING · in-repo home · 2026-08-07
**Scope:** what "finished" means for a **session or a run**. Per-module Done is a different
question, owned by [`AGENT_PROTOCOL.md`](../../tooling/agent-protocol/AGENT_PROTOCOL.md) §8.
**Cited by:** [`SWARM-MANDATE.md`](./SWARM-MANDATE.md) · [`COORDINATION-TRUTH-LAYERS.md`](../COORDINATION-TRUTH-LAYERS.md)

---

## 0 · Why this file exists in the repo

Until 2026-08-07 this definition lived only in a private notes folder on one operator's machine,
while `SWARM-MANDATE.md` cited it as binding. Denon, Shehzad, CI, and any agent on any other
machine could not read the definition of "done" that the repo's own law depended on. The path is
deliberately not repeated here: a location no teammate can open is not a citation, and the
`agent-autoload` gate now fails any binding law that names one.

**The cost of that gap, measured:** `AGENT_PROTOCOL` §8 defines when a _module_ is done — tests,
gates, typecheck, CI. That bar is satisfiable **infinitely**. Between 2026-08-05 and 2026-08-07 the
swarm merged 64 PRs and 21,268 lines of catalog copies; every one passed its module Done bar, and
nothing anywhere said the _session_ was finished or that the work had to reach something. Given a
definition of done that can always be met again, an obedient agent meets it again, forever.
(PR #953 deleted 151 of those modules; the `reachability` doctrine gate now blocks the shape.)

If two documents disagree about "finished", **this file wins.**

---

## 1 · Finish types — pick one primary per run

| Code          | Name                                | "Finished" means                                                                                                 |
| ------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **F-QUEUE**   | Board / claim queue empty           | Every agent-safe claim in the freeze is done or honestly residual; the free lane is empty on `pnpm swarm:status` |
| **F-PRODUCT** | Product slice complete              | A named product outcome exists with proof — a behaviour, not "PRs opened"                                        |
| **F-AUDIT**   | Audit exit                          | Scoreboard + residual register + tip proof. No "zero bugs" unless proven                                         |
| **F-ALIGN**   | Law / decision landed               | Durable law on disk (and on main if that was the gate)                                                           |
| **F-HANDOFF** | Handoff only                        | The next agent can cold-start from disk; this run was not meant to execute                                       |
| **F-STANDBY** | Board finish met, session continues | Only valid under §3. Never a resting state you may declare and stop in                                           |

**Resolver.** Board-clear / "until nothing left" / AFK → **F-QUEUE**. A named feature or scope →
**F-PRODUCT**. Audit / residual / peace-of-mind → **F-AUDIT**. Law or direction only → **F-ALIGN**.
A prompt or plan for another agent → **F-HANDOFF**. Ambiguous → ask once, with the default stated.
Never invent a seventh type silently.

**Dual finish.** Often F-QUEUE inner, F-PRODUCT outer. You may claim F-QUEUE only when the board
says the free lane is empty. You may claim F-PRODUCT only when product proof exists. **Never report
F-PRODUCT complete because F-QUEUE drained.**

---

## 2 · Residual honesty

| Status                  | Meaning                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------- |
| **PASS**                | Primary finish met; residual empty or non-blocking notes only                          |
| **PASS-WITH-RESIDUALS** | Primary finish met for the declared scope; open items listed with owner + why not free |
| **FAIL / BLOCKED**      | Primary finish not met. Say so in the first line                                       |

"All good" while residuals are open is a **defect**, not a summary.

---

## 3 · F-STANDBY — the only legal way to stand still

F-STANDBY is not "nothing to do." It is a claim that must be evidenced every cycle:

| Line            | Required content                                                                  |
| --------------- | --------------------------------------------------------------------------------- |
| **P1 stranded** | N path-clear branches, and why each is not landable this cycle — or `landed #NNN` |
| **P2 partner**  | Which partner PRs changed state, or "matrix unchanged"                            |
| **P3 TRK**      | How many specs remain under 100 lines                                             |

**If P1 path-clear > 0, F-STANDBY is invalid.** Land one **only if** it closes or unblocks a tracker mountain. Honesty restamps and pin-only PRs are not P1.

"No board delta" justifies **not opening a stamp PR**. It never justifies not doing real P1–P3 work.

---

## 4 · Noise bans — never evidence of success

| Ban                                                                         | Why it is a defect                                          |
| --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **PR / commit / subagent counts as "we did a lot"**                         | Volume is not value. A status built on counts is defective  |
| **"You can leave" while the freeze is non-empty**                           | Fake AFK. The forbidden stop                                |
| **A plan or doc existing = the work is done**                               | A map is not a runner                                       |
| **A green test on a module nothing imports**                                | The test asserts itself. Blocked by the `reachability` gate |
| **Manufacturing work because the board is empty**                           | `freeProduct=0` never authorises minting                    |
| **Leftover honesty rebase / i18n pin-only / occupancy spawn as "progress"** | Sand-castle. Volume is not a mountain close (`AGENTS.md`)   |
| **Claiming a sibling's open multi-concern PR**                              | Multi-dev violation                                         |
| **Spec green = production money ready**                                     | Class M violation                                           |
| **"No bugs left" without proof**                                            | Over-claim — see §6                                         |

---

## 5 · Exit proof — every finish claim names how it is checked

| Proof | Example                                        |
| ----- | ---------------------------------------------- |
| Tip   | `git rev-parse origin/main` — state the SHA    |
| PR    | Links, with merged/open state                  |
| Board | `pnpm swarm:status` — free lane empty yes/no   |
| Tests | `pnpm verify` / `pnpm gates` output as printed |
| UI    | Screenshot path or URL (Class X)               |

**No proof → the status is not PASS.** Re-derive tip and board from git this turn before any
scoreboard; a scoreboard from memory is the stale-PEACE failure.

---

## 6 · Refuse over-claims, even when invited

When asked "so there are no bugs left?" / "everything is fixed?" / "can I close this?":

1. Answer truthfully first — often **no**, or PASS-WITH-RESIDUALS.
2. Show the residual register and the proof.
3. Do not soften to "basically done" when the primary finish is unmet.

This is a feature of the system, not rudeness.

---

## 7 · Class gates

| Class | May                                                   | Must not                                                                               |
| ----- | ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **N** | Structure, refactor, non-money product, docs, tooling | —                                                                                      |
| **X** | Prepare and structure UI, present options             | Declare visual/taste done without Nitro's eye                                          |
| **M** | Audit, test, draft PRs, hold the merge                | Merge money/doctrine without a self-audit path; claim live-money-ready from spec alone |

Money and ledger doctrine in [`AGENTS.md`](../../AGENTS.md) always wins.

---

## 8 · Relationship to module Done

| Question                           | Owner                                                             |
| ---------------------------------- | ----------------------------------------------------------------- |
| Is this **module** shippable?      | `AGENT_PROTOCOL.md` §8 — tests, gates, typecheck, CI              |
| Is this **run** finished?          | This file                                                         |
| Does this code **reach** anything? | `tooling/ci/reachability-scan.mjs` (doctrine gate `reachability`) |

Passing §8 for the Nth time is not progress toward finishing. That distinction is the whole
purpose of this document.
