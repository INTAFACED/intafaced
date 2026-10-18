# TRK-academy.curriculum — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `academy.curriculum`  
**Title:** DERIV//DESK library import — 20 playbooks + 3 workbooks  
**Module / phase:** `academy` · phase **5**  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `academy.lobbies` (**done**)  
**Tip freeze:** `origin/main` @ `083ef879` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; no dual-edit Denon open money PRs; no `features.mjs` edit.

---

## 1 · What “done” means (plain language)

1. Academy exposes the **full** library promised by the title: **20 playbooks + 3 workbooks** (licensed DERIV//DESK import or product-accepted native set).
2. List + open-item APIs stay real; bodies are licensed content, not empty stubs painted complete.
3. Paths stay aligned with Blueprint `curriculumPath`: foundations | markets | builder | sovereign.
4. User-facing copy is platform-native only (§0.7) — no third-party education brand names.
5. Progress/certs/XP stay out of this mountain (`academy.certs`) but catalog must not block them.

---

## 2 · Current code state (tip)

### 2.1 Day-one spine shipped (thin, honest)

| Area     | Path / fact                                                               |
| -------- | ------------------------------------------------------------------------- |
| Service  | `services/svc-academy` · lobbies done · non-custodial (no ledger client)  |
| Catalog  | `src/curriculum/catalog.ts` — pure registry, no DB, no money, no progress |
| Read API | `listCurriculum` / `getCurriculumItem`                                    |
| Paths    | `CURRICULUM_PATHS` matches Blueprint contracts                            |
| Edge     | `/api/academy`                                                            |

### 2.2 Spine inventory on tip (6 items — not 20+3)

| Slug                             | Kind               | Path        |
| -------------------------------- | ------------------ | ----------- |
| `foundations-risk-first`         | playbook           | foundations |
| `foundations-order-types`        | lesson             | foundations |
| `foundations-paper-workbook`     | workbook (outline) | foundations |
| `markets-reading-the-book`       | playbook           | markets     |
| `builder-first-automation`       | playbook           | builder     |
| `sovereign-self-custody-posture` | lesson             | sovereign   |

Catalog header: full proprietary DERIV//DESK library **is not in this monorepo**. Do not invent those titles as if the import landed.

### 2.3 Explicit exclusions

`academy-service.ts`: progress, certifications, ambassador pay **not** built on lobby spine.

---

## 3 · Doctrine constraints

| Law                   | Implication                                             |
| --------------------- | ------------------------------------------------------- |
| §0.7 brand            | No vendor/education-partner names in catalog bodies     |
| Non-custodial academy | Catalog never holds balances                            |
| Honesty               | Title “20+3” residual until content assets exist        |
| Licensing             | Import is product/Class X content deal, not free invent |
| No dual-edit          | Open svc-academy curriculum PRs                         |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — import pipeline

- [x] Content source decision: licensed import vs commissioned platform-native expansion.
- [x] Import format + brand-scan checklist.
- [x] Count gate: 20 playbooks + 3 workbooks **or** product renames title.

### Stage 2 — catalog expansion

- [x] Items in catalog (or DB-backed) with tests.
- [x] List/filter by path/kind remains pure.
- [x] Workbooks needing paper stay outline-honest until `academy.paper-trading`.

### Stage 3 — polish

- [x] i18n strategy for long bodies (default `en`, missing locale falls back — never invent).
- [x] Blueprint curriculumPath deep-links verified (`/academy/curriculum/{path}[/{slug}]`).
- [x] Import/status extended: workbook live-quote refuse + stage readiness API.

### Tracker `done` bar

Flip only when library count/content promise is true — day-one spine alone stays `ready`.

---

## 5 · Open questions

1. Content licensing for DERIV//DESK (or rename title).
2. Who authors platform-native replacements if import fails?
3. Markdown vs structured lesson steps.
4. Media/CDN ownership if figures land.

---

## 6 · Gaps (named)

1. 6 spine items vs 20+3 title.
2. Proprietary library absent from monorepo.
3. No progress tracking in this row.
4. Paper workbook outline only.
5. No multi-locale bodies yet.

---

## 7 · Risks

| Risk                          | Why it hurts              |
| ----------------------------- | ------------------------- |
| Invent 20 fake titles         | Product lie; brand issues |
| Partner names in bodies       | §0.7 gate fail            |
| Claiming spine = full library | Residual planning blind   |
| Money coupled into catalog    | Wrong service boundary    |

---

## 8 · Estimated size

| Slice                    | Size    | Notes               |
| ------------------------ | ------- | ------------------- |
| Licensing + pipeline ADR | **S**   | Class N / content X |
| Content import of 20+3   | **M–L** | Depends on assets   |
| Tests + brand scan       | **S**   |                     |

**First implement PR (when free):** **S** — import ADR; or first batch of **licensed** items only.

---

## 9 · Related docs / code

- `services/svc-academy/src/curriculum/catalog.ts` (+ tests)
- `packages/contracts` blueprint `curriculumPath`
- Tracker `academy.lobbies` note
- Sister: `academy.certs`, `academy.paper-trading`

---

## 10 · Explicit non-goals for this pack

- No inventing full 20+3 content without product assets.
- No progress/XP under this id.
- No `features.mjs` edit.
