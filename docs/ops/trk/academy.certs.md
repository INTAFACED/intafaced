# TRK-academy.certs — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `academy.certs`  
**Title:** Certifications → XP → real perks  
**Module / phase:** `academy` · phase **5**  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `academy.curriculum` (**ready**) · `identity.rank` (**done**)  
**Tip freeze:** `origin/main` @ `083ef879` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; no dual-edit Denon open money PRs; no `features.mjs` edit.

---

## 1 · What “done” means (plain language)

1. Completing defined curriculum milestones grants a **certification** record.
2. Cert path emits **XP** into the one identity rank graph (`intafaced.identity.xp.earned`) without double-award.
3. Certs unlock **real perks** via rank/perks tables — not cosmetic-only badges that claim perks.
4. Progress is durable, user-visible, and re-complete is idempotent.
5. Cert grant itself does not post ledger money.

---

## 2 · Current code state (tip)

### 2.1 Absent product

| Area                           | Reality                                              |
| ------------------------------ | ---------------------------------------------------- |
| Cert schema / progress tables  | **Not built** (catalog says so)                      |
| XP emit from academy cert path | Event named for cert path — consumer wiring residual |
| Perk unlock from cert          | Residual                                             |
| Catalog                        | Spine only; progress excluded                        |

### 2.2 Dependencies

| Dep                  | Status | Role                                                     |
| -------------------- | ------ | -------------------------------------------------------- |
| `academy.curriculum` | ready  | Content to certify against                               |
| `identity.rank`      | done   | XP graph + rank ladder + perks SoT                       |
| `academy.lobbies`    | done   | Host rights already read `lobbyHostRights` from identity |

### 2.3 Honest residual quotes

- `catalog.ts`: Progress, certifications, paper workbooks, and XP are **not** here.
- `academy-service.ts`: Certifications need progress tracking — not on lobby class.
- P2P already emits XP into the same graph — certs must use same event + idempotency discipline.

---

## 3 · Doctrine constraints

| Law             | Implication                                   |
| --------------- | --------------------------------------------- |
| One XP graph    | No academy-local rank silo                    |
| No double-award | Idempotency keys on cert completion           |
| Brand           | Cert names/copy vendor-clean                  |
| Perks SoT       | identity rank_thresholds — no parallel limits |
| Money           | Cert grant ≠ ledger post                      |
| No dual-edit    | Open identity rank / academy PRs              |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — progress spine

- [ ] Schema: enrollment, item completion, cert grant.
- [ ] API: mark complete, list progress, list certs.
- [ ] Tests: re-complete no-op; incomplete cannot grant.

### Stage 2 — XP + perks

- [ ] Emit `intafaced.identity.xp.earned` with stable idempotency.
- [ ] Map cert → XP policy (product law).
- [ ] User-visible perk unlock from cert.

### Stage 3 — surfaces

- [ ] Shell UI; i18n for cert titles.

### Tracker `done` bar

Flip only when cert → XP → real perk works in a real env.

---

## 5 · Open questions

1. Which spine items required for v1 cert?
2. XP amounts (product law).
3. Expire / revoke policy?
4. Exam vs completion-only?

---

## 6 · Gaps (named)

1. No progress store.
2. No cert grant API.
3. XP wiring residual.
4. Perk mapping residual.
5. Curriculum still thin for full program.

---

## 7 · Risks

| Risk                         | Why it hurts                   |
| ---------------------------- | ------------------------------ |
| Double XP                    | Rank inflation → unfair limits |
| Cosmetic cert claiming perks | Trust break                    |
| Academy-local rank           | Dual identity                  |
| Empty content cert farm      | Integrity failure              |

---

## 8 · Estimated size

| Slice                      | Size    |
| -------------------------- | ------- |
| Progress + cert schema/API | **M**   |
| XP wire + tests            | **S–M** |
| UI                         | **S–M** |

**First implement PR (when free):** **M** — progress + one cert against spine; XP idempotency tests.

---

## 9 · Related docs / code

- `services/svc-academy/src/curriculum/catalog.ts`
- `services/svc-identity` rank / XP
- Event `intafaced.identity.xp.earned`
- `academy.curriculum` pack

---

## 10 · Explicit non-goals for this pack

- No inventing full curriculum under certs.
- No ledger posts for “cert fees” without product law.
- No `features.mjs` edit.
