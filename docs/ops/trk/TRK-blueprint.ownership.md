# TRK-blueprint.ownership — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `blueprint.ownership`  
**Title:** Export + hard delete, cascading  
**Module / phase:** `blueprint` · phase 4 · plane F  
**Status on tip:** ready (tracker note **stale** vs tip — re-derive) · **owner:** none  
**Depends on:** `blueprint.onboarding` (done)  
**Requires:** `services/svc-blueprint`, `services/svc-identity` (cascade consumer)  
**Tip freeze:** `origin/main` @ `04f9b1f2` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; **no** `features.mjs` edit from this pack.

---

## 1 · What “done” means (plain language)

1. A user can **export** their Blueprint package (JSON + card composition per §7.2) that follows **tables**, not UI — includes mentoring shortlists they appear on; excludes crewmates’ private profiles.
2. A user can **hard erase**; Blueprint data is gone in one serializable transaction (mentor both sides, match runs, membership, empty crew cleanup).
3. Erase **cascades** into `profiles.blueprint_id` in svc-identity via `blueprintDeleted` (and create sets via `blueprintCreated`) — not a mock consumer inside blueprint tests alone.
4. Redelivered delete does not wipe a **newer** blueprint the user re-onboarded (match-guarded clear).
5. Double erase returns a receipt of zeroes; no silent half-delete.

---

## 2 · Current code state (tip)

### 2.1 svc-blueprint half — complete on tip

Export schemaVersion 2 (card included), hard erase serializable, events published — covered by real Postgres tests in `blueprint-service.test.ts`. Stand-in `IdentityProjection` in those tests was the **old** proof for identity’s half.

### 2.2 svc-identity half — **shipped** (#229)

| Artifact    | Path                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| SQL helpers | `services/svc-identity/src/blueprint-profile.ts` — set on create; clear when id still matches on delete |
| Bus wiring  | `subscribeBlueprintProfileEvents` in `events.ts` — durable names, `idempotent()` wrapper                |
| Boot        | `index.ts` awaits subscribe on service start                                                            |
| Tests       | `blueprint-profile.test.ts` against real DB + bus                                                       |

**Landed:** `66726c5a` / PR **#229** — cascade blueprintCreated/Deleted into `profiles.blueprint_id`.

### 2.3 Stale documentation still on tip

| Doc                                                           | Claim                                                 | Truth on tip                        |
| ------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------- |
| `tooling/tracker/features.mjs` note for `blueprint.ownership` | “no service subscribes… only catalog + svc-blueprint” | **False** — svc-identity subscribes |
| `services/svc-blueprint/README.md` cascade section            | “svc-identity has no subscriber at all”               | **False** — same                    |

**Honest residual for “done”:** (1) tracker + blueprint README honesty PR; (2) optional **cross-service e2e** (erase in blueprint → profile pointer null on identity schema) if not already covered by dual unit suites; (3) confirm no other cascade targets required by §7.2 beyond `profiles.blueprint_id`.

---

## 3 · Doctrine constraints

| Law         | Implication                                                                     |
| ----------- | ------------------------------------------------------------------------------- |
| §7.2        | Export complete + deletion truly cascades                                       |
| §2          | Blueprint service never writes identity `profiles`                              |
| Events      | Cross-service only via catalog events                                           |
| Done rule 3 | Nothing propped only by mock consumers — **identity consumer is real code now** |

---

## 4 · DoD sketch (checkable — staged)

### Stage A — honesty (free residual now)

- [ ] Rewrite tracker note + blueprint README cascade section to match #229
- [ ] Decide tracker status: `done` vs keep `ready` until cross-service e2e named

### Stage B — proof bar (if not satisfied by unit suites)

- [ ] One e2e or contract test that both services agree after erase (no mock IdentityProjection as sole evidence)
- [ ] Redelivery / re-onboard match-guard covered in identity tests (already unit-level)

**Prefer mountain event to `done` only after docs match code and proof bar agreed — research pack does not flip `features.mjs`.**

---

## 5 · Open questions

1. Is #229 + dual unit suites enough for tracker `done`, or is a multi-service e2e required?
2. Any other subscribers needed (academy crew routing already separate event)?
3. Export retention / legal hold — product/ops?

---

## 6 · Estimated size

| Slice                             | Size                | Notes                       |
| --------------------------------- | ------------------- | --------------------------- |
| Tracker + README honesty          | **XS** Class N docs | Should ship soon            |
| Cross-service e2e                 | **S**               | If product requires         |
| Feature was large; residual small | —                   | Implement half largely done |

**First implement PR:** **XS docs honesty** (tracker note + blueprint README) **or** S e2e if owners require — **not** re-implementing identity consumer.

**Human blockers:** Tracker honesty; Optional e2e; Not blocked.

---

## 7 · Related docs / code

- PR #229 identity cascade
- `services/svc-identity/src/blueprint-profile.ts`
- `services/svc-blueprint` erase/export
- `packages/events` catalog blueprintCreated/Deleted

---

## 8 · Explicit non-goals for this pack

- No re-building identity consumer (exists).
- No features.mjs edit from this research pack (honesty PR is a separate mountain event).
- No PII in export beyond user’s own data tables.
