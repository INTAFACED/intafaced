> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](GITHUB-CI-SPEND-CONTROL-2026-07-31.md).

# Coordination stress test — audit of Nitro’s claims

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Date:** 2026-08-02  
**Tip at audit:** re-derive `git log origin/main -1`  
**Law under test:** #385 + #386 · [`COORDINATION-TRUTH-LAYERS.md`](COORDINATION-TRUTH-LAYERS.md)  
**Purpose:** Verify whether “what Nitro believes we shipped” matches reality and Denon’s intent — without overselling automation.

---

## Verdict (one screen)

| Your claim                                                   | Verdict                      | Plain truth                                                                                                                        |
| ------------------------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| We have **backend implementation** that enforces this        | **False / mislabel**         | We shipped **agent law + entry-chain docs**, not a product backend or auto-sync service                                            |
| It will **not limit** me                                     | **True (by design)**         | No PR caps, no new Approves, thrift deleted 2026-08-07, craft PRs need not touch tracker every time                                |
| As a user I **don’t need to notice** — automatic             | **Half-true**                | **You** do not run git/tracker. **Agents** must still claim and update on mountain events. Nothing auto-writes the registry        |
| GitHub work is **more structured the way Denon wants**       | **Mostly true (intent)**     | Shared product map + claim rules restored; **not** literal “every merge edits tracker”                                             |
| I **never need to do anything** going forward in these chats | **True for git/claim/merge** | Operator mode: agents own the loop. **False** for Class X (go-live, secrets, etc.) and if you must paste/start a new agent session |

**Bottom line for you:** Right _user_ outcome (no homework, no slowdown) is correct. Wrong mental model if you picture a silent machine that always keeps the board true without agents.

---

## What Denon wanted (restated)

1. Push/merge work is registered so multi-dev context is shared
2. Tracker is a **truth database** of current product context
3. Unregistered main work → **agent conflict**

### What we delivered against that

| Denon need                                        | Delivered?                 | Mechanism                                                               |
| ------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------- |
| Shared product free/owner/done                    | **Yes (law)**              | `features.mjs` wins ownership questions                                 |
| Agents know not to double / steal human mountains | **Yes (law + LIVE-LANES)** | Claim ritual + shehzad locks                                            |
| Main never lies                                   | **Partial**                | CI blocks **fake done**; does **not** force registry on every code ship |
| Every push updates tracker                        | **Intentionally no**       | Mountain events only — avoids speed limit                               |
| You never become the board clerk                  | **Yes**                    | AGENTS operator mode                                                    |

**Right way for you as user:** agents enforce structure; you direct outcomes.  
**Not the right way if Denon meant a robot that patches the registry on every merge without agent judgment** — we rejected that as over-limit / over-engineer.

---

## Stress tests run `[VERIFIED this audit]`

### T1 — Is there automatic backend?

| Probe                                             | Result                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| Service/job auto-updating `features.mjs` on merge | **None found**                                                                |
| Git hook auto-claim / auto-done                   | **None** (hooksPath exists for other reasons; not tracker sync)               |
| CI requires `features.mjs` on every code PR       | **No** — `tracker:check` only: valid registry, false-done paths, stale render |

→ **Not automatic infrastructure.** It is **binding process for agents** wired into AGENTS / session prompt / Board Clear entry.

### T2 — Will you feel limits?

| Limit risk                       | Present?      |
| -------------------------------- | ------------- |
| PR count cap                     | No            |
| New Denon Approve on agent work  | No            |
| Every craft PR must edit tracker | No (explicit) |
| Thrift removed / parallel banned | No            |
| You must update boards           | No            |

→ **Does not limit your operator goals** when agents follow the law.

### T3 — Do you need to notice?

| Actor                                    | Must notice?                                 |
| ---------------------------------------- | -------------------------------------------- |
| Nitro                                    | **No** for claim/git/merge of normal work    |
| Agents (every coding chat)               | **Yes** — cold-start layers + claim          |
| New chat without session prompt / AGENTS | **Risk** — may skip until it reads AGENTS.md |

→ “Invisible to me” works **if agents load AGENTS / session prompt**. Starting a blank chat with no repo context can still skip the law — **agent failure mode**, not your homework, but not physics-automatic.

### T4 — Denon “truth DB” vs remaining lies

| Residual hole                                  | Severity | Mitigated?                                         |
| ---------------------------------------------- | -------- | -------------------------------------------------- |
| Silent code ship without mountain event        | Medium   | Agents required by law; CI does not catch          |
| Order-route not a tracker feature id           | Low–med  | Git + order-route docs; optional E5                |
| Notes lag under long `wip` (e.g. web.terminal) | Low      | Optional wave note                                 |
| Agents ignore docs                             | Med      | Same as all doctrine — self-audit + review culture |

→ Denon’s **risk class is reduced and clarified**, not eliminated by a machine.

### T5 — Multi-dev still real

Open human/Denon work remains (e.g. pay #346, Denon #350 class). Locks exist so agents babysit — that **is** the structure he wants for conflict avoidance.

---

## Unspoken needs (yours) mapped

| Unspoken                                            | Status after stress test                                         |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| Don’t make me the process                           | Met — agents own loop                                            |
| Don’t slow me                                       | Met — anti-limit guarantees are law                              |
| Make Denon less angry about chaos                   | Met at **intent** level if agents comply                         |
| “Set and forget forever with zero agent discipline” | **Not met** — no system does that without hard CI tax (rejected) |
| Trust without reading code                          | Met — this stress doc + finish audit F1–F10                      |

---

## Plan completeness — residual (honest)

| Item                                        | Needed?                                                    | Owner                   |
| ------------------------------------------- | ---------------------------------------------------------- | ----------------------- |
| More law docs                               | **No** — program finished                                  |
| Hard CI “code ⇒ features.mjs”               | **Only if** dual-build/false-free returns as measured pain | Later, optional E7      |
| Optional tracker row / note for order-route | Nice-to-have                                               | Agent P-TRACK when free |
| You learn git                               | **Never**                                                  | —                       |

---

## Enhanced prompt (user-facing truth for future chats)

```
USER BELIEF CHECK (coordination)
- Nitro believes: structured GitHub for Denon, zero his homework, no speed limit.
- Truth: agent LAW on main (#385/#386), not auto-backend. Agents claim/update mountain events.
- If he says “is the automatic tracker working?” → correct: “agent-enforced layers, not a robot; you still do nothing.”
- Do not re-open design unless F1–F10 broken or dual-build storm returns.
- Never sell CI force as default “to make Denon happy” — violates no-limit guarantee.
```

---

## Final answer to “did we do what Denon wanted for me the right way?”

**Yes for you as user:** multi-dev structure without your manual work and without throttling agents.  
**Yes for Denon’s intent:** one product ownership map + claims so agents don’t collide.  
**No if “right” meant invisible infra that always updates the board without agents** — that would either fail or become a limit; we did not build it, on purpose.
