# TRK-blueprint.ownership — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `blueprint.ownership`  
**Title:** Export + hard delete, cascading  
**Module / phase:** `blueprint` · phase **4** · plane **F**  
**Status on tip:** `ready` (tracker **note stale** vs tip — re-derive) · **owner:** none  
**Depends on:** `blueprint.onboarding` (**done**)  
**Requires:** `services/svc-blueprint`, `services/svc-identity` (cascade consumer)  
**Tip freeze:** `origin/main` @ `d9e517bd` (re-derive before implement)  
**Pack type:** research only — no re-implement of shipped cascade; no `features.mjs` edit from this pack alone.

---

## 1 · What “done” means (plain language)

1. A user can **export** their Blueprint package (JSON + card composition per §7.2) that follows **tables**, not UI — includes mentoring shortlists they appear on; excludes crewmates’ private profiles.
2. A user can **hard erase**; Blueprint data is gone in one serializable transaction (mentor both sides, match runs, membership, empty crew cleanup).
3. Erase **cascades** into `profiles.blueprint_id` in svc-identity via `blueprintDeleted` (and create sets via `blueprintCreated`) — not a mock consumer inside blueprint tests alone.
4. Redelivered delete does not wipe a **newer** blueprint the user re-onboarded (match-guarded clear).
5. Double erase returns a receipt of zeroes; no silent half-delete.
6. Export contents respect privacy law (user’s own data only; no crew PII dump).

---

## 2 · Current code state (tip)

### 2.1 svc-blueprint half — complete on tip

| Capability                      | State                                                            |
| ------------------------------- | ---------------------------------------------------------------- |
| Export schemaVersion 2 (+ card) | **Yes** — §7.2 export JSON + card composition                    |
| Hard erase serializable         | **Yes** — mentor both sides, match runs, membership, empty crew  |
| Double-erase receipt of zeroes  | **Yes** — tested                                                 |
| Publishes `blueprintDeleted`    | **Yes** — `blueprint-service.ts` erase path + catalog            |
| Export tables vs UI             | **Yes** — mentoringOthers included; crewmates’ profiles excluded |
| Self-only scopes                | `blueprint:read` / `blueprint:write` on export/erase             |

Covered by real Postgres tests in blueprint service suites.

### 2.2 svc-identity half — **shipped** (#229)

| Artifact    | Path                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| SQL helpers | `services/svc-identity/src/blueprint-profile.ts` — set on create; clear when id still matches on delete |
| Bus wiring  | `subscribeBlueprintProfileEvents` in `events.ts` — durable names, `idempotent()` wrapper                |
| Boot        | `index.ts` awaits subscribe on service start                                                            |
| Tests       | `blueprint-profile.test.ts` against real DB + bus (create, delete, redelivery match-guard)              |

**Landed:** PR **#229** — cascade `blueprintCreated` / `blueprintDeleted` into `profiles.blueprint_id`.

### 2.3 Stale documentation still on tip

| Doc                                                           | Claim                                                 | Truth on tip                        |
| ------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------- |
| `tooling/tracker/features.mjs` note for `blueprint.ownership` | “no service subscribes… only catalog + svc-blueprint” | **False** — svc-identity subscribes |
| Older short packs / scoreboards                               | “CASCADE not done”                                    | **False** for identity pointer      |

**Honest residual for tracker `done`:**

1. Tracker note + any blueprint README cascade section honesty (Class N mountain event if editing `features.mjs`).
2. Optional **cross-service e2e** (erase in blueprint → profile pointer null on identity schema) if dual unit suites are not enough for product bar.
3. Confirm no other cascade targets required by §7.2 beyond `profiles.blueprint_id` (academy crew routing is separate event ownership).

---

## 3 · Doctrine constraints

| Law         | Implication                                                                     |
| ----------- | ------------------------------------------------------------------------------- |
| §7.2        | Export complete + deletion truly cascades                                       |
| §2          | Blueprint service never writes identity `profiles`                              |
| Events      | Cross-service only via catalog events                                           |
| Done rule 3 | Nothing propped only by mock consumers — **identity consumer is real code now** |
| PII         | Export is user’s own data; no crew private profiles                             |

---

## 4 · Dependency honesty

- **`blueprint.onboarding` done** — profile exists to export/erase.
- **`blueprint.card`:** composition included in export schemaVersion 2; PNG rail residual is a **separate** mountain.
- **Not Shehzad** — Fiat/identity plane residual.

---

## 5 · DoD sketch (checkable — staged)

### Stage A — honesty (free residual now)

- [ ] Rewrite tracker note to match #229 (mountain event — not silent from research-only pack).
- [ ] Fix any README still claiming void subscriber.
- [ ] Decide tracker status: `done` vs keep `ready` until cross-service e2e named.

### Stage B — proof bar (if not satisfied by unit suites)

- [ ] One e2e or contract test that both services agree after erase (no mock `IdentityProjection` as sole evidence).
- [ ] Redelivery / re-onboard match-guard covered (already unit-level on identity).

**Prefer mountain event to `done` only after docs match code and proof bar agreed — this research pack does not flip `features.mjs`.**

---

## 6 · Gaps (named)

1. Tracker note still wrong (says cascade incomplete).
2. Possible missing multi-service e2e (product call).
3. Legal hold / export retention policy not productized.
4. Other FK holders of `blueprint_id` (if any) not fully inventory-scanned in this pack — re-grep before `done`.

---

## 7 · Risks

| Risk                                         | Why it hurts                           |
| -------------------------------------------- | -------------------------------------- |
| Re-implementing identity consumer            | Waste + dual subscribers               |
| Export including crew PII                    | Consent / privacy failure              |
| Erase without cascade (if consumer disabled) | Orphan `blueprint_id` pointers         |
| Marking done from blueprint tests alone      | Done-rule-3 violation historically     |
| Research pack editing features.mjs           | Coordination law: mountain events only |

---

## 8 · Estimated size

| Slice                    | Size                | Notes               |
| ------------------------ | ------------------- | ------------------- |
| Tracker + README honesty | **XS** Class N docs | Should ship soon    |
| Cross-service e2e        | **S**               | If product requires |
| Feature implement half   | **—**               | Largely done on tip |

**First implement PR:** **XS docs honesty** (tracker note + README) **or** S e2e if owners require — **not** re-implementing identity consumer.

**Human blockers:** optional e2e bar decision; legal hold policy — not blocked by money spine or Shehzad.

---

## 9 · Related docs / code

- PR #229 identity cascade
- `services/svc-identity/src/blueprint-profile.ts` · `events.ts` · `blueprint-profile.test.ts`
- `services/svc-blueprint/src/blueprint-service.ts` erase/export
- `packages/events` catalog `blueprintCreated` / `blueprintDeleted`
- Sister long-form: `TRK-blueprint.ownership.md`

---

## 10 · Explicit non-goals for this pack

- No re-building identity consumer (exists).
- No features.mjs edit from this research pack alone (honesty PR is a separate mountain event).
- No PII in export beyond user’s own data tables.
- No cross-service SQL from blueprint into identity.
- No conflating with `blueprint.card` PNG residual.
