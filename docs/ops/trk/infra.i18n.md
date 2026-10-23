# TRK-infra.i18n — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `infra.i18n`  
**Title:** 100+ languages — keyed from day one (§9)  
**Module / phase:** `core-ops` · phase **0** · plane **F**  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `infra.ui-tokens` (**done**) · **requires:** `packages/i18n`  
**Tip freeze:** `origin/main` @ `d9e517bd` (re-derive before implement)  
**Pack type:** research only — no bulk machine translation; no `features.mjs` flip; no implement swarm under this pack.

---

## 1 · What “done” means (plain language)

1. Every **user-facing** string on shipped **customer** surfaces is a **catalog key**, not an inline literal or local `const copy = {}`.
2. Adding a language is **adding translation files** (and registering them) — **not** refactoring components.
3. Missing keys / missing catalogs never blank the UI: English fallback + measured `untranslated` / `no-catalog` reports via `localeCoverage()`.
4. Money formatting never goes through IEEE floats (`formatMoney` decimal-string path only).
5. “100+ languages” is a **content program** over time, not a one-PR engineering claim. Declared locales without catalogs stay visibly empty — never reported as complete.
6. Operator console (`apps/admin`) may stay English-only **by design** (allowlisted); customer shell and trader surfaces may not silently grow hardcoding.
7. Out-of-app notify copy already keys through the package; customer UI must join the same catalog, not invent a second string system.

---

## 2 · Current code state (tip)

### 2.1 Package (`packages/i18n`)

| Fact                              | Value (tip source + tests)                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Locales **declared**              | **28** (`locales.ts`) — en, major EU/APAC, ar/he/fa/ur (RTL), sw/ha, etc.; tests pin the number                           |
| Locales with **catalog**          | **1** — English only (`catalogs.ts` / `CATALOGS`); `TRANSLATED_LOCALES === ['en']`                                        |
| English message keys              | **118** (`MESSAGE_KEYS` / `catalog.ts`) — tests require 60–120 range                                                      |
| Runtime consumers                 | **`svc-notify`** only for UI-adjacent render (`src/channels/render.ts` + channels tests)                                  |
| Customer surfaces through package | **0** — `apps/web` does **not** import `@intafaced/i18n` for UI                                                           |
| React binding                     | **None** — no provider, no `useT()`, no Next locale negotiation                                                           |
| API                               | `createTranslator`, `negotiateLocale`, `parseAcceptLanguage`, `formatMoney` / number / percent / date, `localeCoverage()` |

**Policy already coded:** requesting a declared-but-empty locale serves English; `dir` and `renderedLocale` follow the **actual** text language, not the requested empty catalog (RTL is not applied around LTR English by mistake).

### 2.2 Apps / shell hardcoding

| Surface            | State                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web`         | Local `const copy = { … }` in **15 files / 164 strings** (frozen baseline 2026-08-03 in `i18n-bypass-scan.mjs`). Comment still says i18n “in a separate worktree.” |
| `apps/admin`       | English operator copy; **allowlisted** in `i18n-scan` as internal tooling                                                                                          |
| Vendored Vue shell | `vendor/**/05_Web_Front` — vue-i18n present; residual keys landed **#714** (`feat/shell-i18n-keys-land`); scan gate **#425** on main                               |

### 2.3 Gates / scanners (tip)

| Tool                 | Script                                           | CI posture                                                                                           |
| -------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| JSX heuristic (apps) | `pnpm scan:i18n` → `tooling/ci/i18n-scan.mjs`    | **Advisory** (exit 0); `--strict` local                                                              |
| `copy = {}` ratchet  | `pnpm scan:i18n-bypass` → `i18n-bypass-scan.mjs` | **Blocking** on verify — queue may shrink, not grow (15 files / 164 strings baseline)                |
| Shell (Vue) scan     | `tooling/ci/shell-i18n-scan.mjs`                 | **On main** (rescued #425); residual keys #714 landed — re-derive scan green before new bare strings |
| Types                | `MessageKey` / param types in package            | Compile-time: no unknown keys, no missing params                                                     |

**Implication of bypass gate:** full “migrate 164 strings tomorrow” is deliberately **not** the default next step. Adoption layer (provider + locale choice) is missing; English-only product law means migration buys users nothing until non-en catalogs exist.

### 2.4 Tracker honesty

Tracker note (2026-07-28): package imported by zero external files; apps/web hardcodes English — **still directionally true for UI**. **svc-notify** is the one real monorepo consumer for rendered out-of-app copy. Do not claim “keyed from day one” for any customer screen. Do not claim “100+ languages” from 28 declared empty catalogs.

**Tip residual:** package + honesty scoreboard + shell scan/keys ship; customer surfaces largely unkeyed through the package; no React provider; non-English catalogs are **owner content cost**.

---

## 3 · Doctrine constraints

| Law             | Implication                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| §9              | Key from day one; 100+ langs = files not refactors                                                                   |
| §14.4           | Every user-facing string keyed; brand-scan still separate (§0.7)                                                     |
| §0.7 brand      | Catalog copy: only allowed product names — never partner/model vendors                                               |
| Money           | No `Number`/`parseFloat` on money format path; display precision from fiat registry                                  |
| Class / content | Non-English money copy is **owner content + review**, not agent MT. Mistranslated “confirm withdraw” is a loss event |
| PR shape        | Per-surface keying PRs; never “bulk-MT 100 catalogs” as one PR — reviewability, not CI cost                          |

---

## 4 · Dependency honesty

- **`infra.ui-tokens` done** — palette/tokens exist; i18n package already palette-independent for copy.
- **Shell path:** #425 scan + #714 residual keys reduce bare-string growth on Vue shell — still not “100+ languages.”
- **Notify coupling:** notify title/body keys must exist in English catalog; expanding consumers without keys fails tests.
- **ADR risk:** `2026-08-03-retire-apps-web-port-to-vue-shell` — large keying investment in `apps/web` alone may be wrong SoT; re-read before mass migration.

---

## 5 · DoD sketch (checkable — layered)

### Layer A — platform readiness (engineering, can be free residual)

- [ ] Documented adoption path for apps: locale negotiation + translator entry (even if English-only).
- [ ] At least one high-traffic `apps/web` surface keys through `@intafaced/i18n` and **lowers** bypass baseline for those files.
- [ ] `localeCoverage()` (or dashboard) visible to operators/devs — 27 empty rows stay honest.
- [ ] shell-i18n-scan stays green on tip; no new bare strings in shell.
- [ ] svc-notify key completeness tests remain green as consumers grow.

### Layer B — “100+ languages” (content program — not agent-done alone)

- [ ] Owner picks launch language set (e.g. en + 3–5 priority locales).
- [ ] Human-written catalogs registered in `CATALOGS`; partial catalogs allowed with measured gaps.
- [ ] No machine-translated money strings without review process.
- [ ] Coverage metrics wired to observability — gaps counted, not hidden.

**Marking tracker `done` for full §9 ambition requires Layer B progress, not only Layer A.** Prefer status notes that say “keyed + N catalogs” over binary done.

---

## 6 · Gaps (named)

1. No React / Next binding for `@intafaced/i18n`.
2. 15 `apps/web` `copy` objects still outside the package (ratchet frozen).
3. 27 declared locales with zero catalogs.
4. Tracker note still slightly stale on “zero imports” (notify exists).
5. Product SoT for customer strings: Next `apps/web` vs Vue shell during transition.

---

## 7 · Risks

| Risk                              | Why it hurts                               |
| --------------------------------- | ------------------------------------------ |
| Bulk MT money copy                | Wrong withdraw/confirm wording = real loss |
| Migrate without adoption layer    | 164 string moves, zero user value          |
| Claim “100+ langs” from 28 rows   | Tracker vapor / marketing lie              |
| Key only apps/web if shell is SoT | Double work; wrong investment              |
| Grow bypass baseline              | Gate fails verify — intentional            |

---

## 8 · Estimated size

| Slice                                                              | Size                      | Notes                                         |
| ------------------------------------------------------------------ | ------------------------- | --------------------------------------------- |
| App binding design + one surface keying (e.g. landing / app-shell) | **S–M**                   | Shrink bypass baseline only for touched files |
| Order ticket / protocol plane keying                               | **M each**                | Money-adjacent — wording fidelity             |
| Full apps/web 164-string migration                                 | **L**                     | Needs binding + product review; not one night |
| First non-en catalog (all keys)                                    | **M content**             | Human write + review, not code bulk           |
| 100+ catalogs                                                      | **Multi-quarter content** | Not an engineering sprint                     |

**First implement PR (when free):** **S** — minimal app translator entry + key **one** low-risk surface; delete its `copy` object; lower BASELINE row; test import of `@intafaced/i18n`. **Do not** claim 100+ languages. **Do not** auto-MT catalogs.

**Not free / not agent solo:** choosing launch languages; hiring/assigning translators; any claim of full §9 completion.

---

## 9 · Related docs / code

- `packages/i18n/README.md` (honest scoreboard)
- `packages/i18n/src/{locales,catalogs,catalog,format,t}.ts`
- `tooling/ci/i18n-bypass-scan.mjs` · `tooling/ci/i18n-scan.mjs` · `tooling/ci/shell-i18n-scan.mjs`
- Landed: #425 shell scan · #714 residual Vue keys · #134 notify i18n keys
- Doctrine: `INTAFACED_DEFINITIVE_BUILD.md` §9, §14.4
- Sister long-form: `TRK-infra.i18n.md` (Pack 6 solid)

---

## 10 · Explicit non-goals for this pack

- No machine-translated catalogs.
- No mass rewrite of apps/web in a research PR.
- No tracker `done` flip from this pack.
- No Shehzad / money-spine work under the guise of `formatMoney`.
- No inventing React bindings as “just docs.”
