# TRK-infra.i18n — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `infra.i18n`  
**Title:** 100+ languages — keyed from day one (§9)  
**Module / phase:** `core-ops` · phase 0 · plane F  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `infra.ui-tokens` (done) · **requires:** `packages/i18n`  
**Tip freeze:** `origin/main` @ `81771578` (re-derive before implement)  
**Pack type:** research only — no implementation swarm, no tracker flip, no bulk machine translation.

---

## 1 · What “done” means (plain language)

1. Every **user-facing** string on shipped customer surfaces is a **catalog key**, not an inline literal or local `copy = {}` object.
2. Adding a language is **adding translation files** (and registering them) — **not** refactoring components.
3. Missing keys / missing catalogs never blank the UI: English fallback + measured `untranslated` / `no-catalog` reports.
4. Money formatting never goes through IEEE floats (`formatMoney` decimal-string path).
5. “100+ languages” is a **content program** over time, not a one-PR engineering claim. Declared locales without catalogs stay visibly empty (`localeCoverage()`), never reported as complete.
6. Operator console (`apps/admin`) may stay English-only **by design** (allowlisted); customer shell and trader surfaces may not silently grow hardcoding.

---

## 2 · Current code state (tip)

### 2.1 Package (`packages/i18n`)

| Fact                              | Value (tip README + source)                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Locales **declared**              | **28** (`locales.ts`) — en, major EU/APAC, ar/he/fa/ur (RTL), sw/ha, etc.                                                 |
| Locales with **catalog**          | **1** — English only (`catalogs.ts` / `CATALOGS`)                                                                         |
| English message keys              | ~**118** (`catalog.ts`)                                                                                                   |
| Runtime consumers                 | **`svc-notify` only** (out-of-app email/SMS/push render)                                                                  |
| Customer surfaces through package | **0** — `apps/web` does not import it for UI                                                                              |
| React binding                     | **None** — no provider, no `useT()`, no Next locale negotiation                                                           |
| API                               | `createTranslator`, `negotiateLocale`, `parseAcceptLanguage`, `formatMoney` / number / percent / date, `localeCoverage()` |

**Policy already coded:** requesting a declared-but-empty locale serves English; `dir` and `renderedLocale` follow the **actual** text language, not the requested empty catalog (so RTL is not applied around LTR English by mistake).

### 2.2 Apps / shell hardcoding

| Surface            | State                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`         | Local `const copy = { … }` in **15 files / 164 strings** (frozen baseline 2026-08-03). Comment still says i18n “in a separate worktree.” |
| `apps/admin`       | English operator copy; **allowlisted** in `i18n-scan` as internal tooling                                                                |
| Vendored Vue shell | Separate tree under `vendor/**/05_Web_Front` (shape-found); customer-facing shell product                                                |

### 2.3 Gates / scanners

| Tool                 | Script                                           | CI posture                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSX heuristic (apps) | `pnpm scan:i18n` → `tooling/ci/i18n-scan.mjs`    | **Advisory** (exit 0); `--strict` local                                                                                                                                                                   |
| `copy = {}` ratchet  | `pnpm scan:i18n-bypass` → `i18n-bypass-scan.mjs` | **Blocking** on verify — queue may shrink, not grow                                                                                                                                                       |
| Shell (Vue) scan     | `tooling/ci/shell-i18n-scan.mjs`                 | On open rescue PR **#425** (`chore/rescue-shell-i18n-keys`) — **blocking** intent for finished shell; **not necessarily on main yet** — re-derive `git show` / PR state before claiming gate lives on tip |
| Types                | `MessageKey` / param types in package            | Compile-time: no unknown keys, no missing params                                                                                                                                                          |

**Implication of bypass gate:** full “migrate 164 strings tomorrow” is deliberately **not** the default next step. Adoption layer (provider + locale choice) is missing; English-only product law means migration buys users nothing until catalogs exist.

### 2.4 Tracker honesty

Tracker note (2026-07-28): package imported by zero external files; apps/web hardcodes English — **still directionally true** for **UI**; **svc-notify** is the one real consumer for rendered out-of-app copy. Do not claim “keyed from day one” for any customer screen.

---

## 3 · Doctrine constraints

| Law             | Implication                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| §9              | Key from day one; 100+ langs = files not refactors                                                                                 |
| §14.4           | Every user-facing string keyed; brand-scan still separate (§0.7)                                                                   |
| §0.7 brand      | Catalog copy: only allowed product names (Identity Blueprint, Sovereign Intelligence, Neural Engine) — never partner/model vendors |
| Money           | No `Number`/`parseFloat` on money format path; display precision from fiat registry                                                |
| Class / content | Non-English money copy is **owner content + review**, not agent MT. Mistranslated “confirm withdraw” is a loss event               |
| PR shape        | Per-surface keying PRs; never “bulk-MT 100 catalogs” as one PR — reviewability, not CI cost                                        |

---

## 4 · DoD sketch (checkable — layered)

### Layer A — platform readiness (engineering, can be free residual)

- [ ] Documented adoption path for apps: locale negotiation + translator entry (even if English-only).
- [ ] At least one high-traffic `apps/web` surface keys through `@intafaced/i18n` and **lowers** bypass baseline for those files.
- [ ] `localeCoverage()` (or dashboard) visible to operators/devs — 27 empty rows stay honest.
- [ ] shell-i18n-scan on main (if product law: vendor shell is live SoT) stays green; no new bare strings in shell.
- [ ] svc-notify key completeness tests remain green as consumers grow.

### Layer B — “100+ languages” (content program — not agent-done alone)

- [ ] Owner picks launch language set (e.g. en + 3–5 priority locales).
- [ ] Human-written catalogs registered in `CATALOGS`; partial catalogs allowed with measured gaps.
- [ ] No machine-translated money strings without review process.
- [ ] Coverage metrics wired to observability (doctrine intent) — gaps counted, not hidden.

**Marking tracker `done` for full §9 ambition requires Layer B progress, not only Layer A.** Prefer status notes that say “keyed + N catalogs” over binary done.

---

## 5 · Open questions

1. **Who is SoT for customer UI strings long-term?** `apps/web` (Next) vs vendored Vue shell vs both during transition (ADR `2026-08-03-retire-apps-web-port-to-vue-shell` — re-read before large keying investment in apps/web alone).
2. **React adoption API:** `createTranslator` only vs `I18nProvider` + `useT` — design choice; blocked pure migration.
3. **User locale source:** Accept-Language only vs profile preference vs both.
4. **First non-English catalog owner:** who writes/reviews money copy (Class X quality bar).
5. **Admin English-only forever?** Current allowlist is deliberate; confirm for multi-region ops teams.
6. **shell-i18n-scan merge:** land #425 (or equivalent) before counting shell as gated on main.

---

## 6 · Estimated size

| Slice                                                               | Size                      | Notes                                         |
| ------------------------------------------------------------------- | ------------------------- | --------------------------------------------- |
| Land / verify shell-i18n-scan on tip                                | **XS–S**                  | Rescue PR may already exist                   |
| App binding design + one surface keying (e.g. app-shell or landing) | **S–M**                   | Shrink bypass baseline only for touched files |
| Order ticket / protocol plane keying                                | **M each**                | Money-adjacent — wording fidelity             |
| Full apps/web 164-string migration                                  | **L**                     | Needs binding + product review; not one night |
| First non-en catalog (all keys)                                     | **M content**             | Human write + review, not code bulk           |
| 100+ catalogs                                                       | **Multi-quarter content** | Not an engineering sprint                     |

**First implement PR (when free):** **S** — add minimal app translator entry + key **one** low-risk shell surface; delete its `copy` object; lower BASELINE row; test import of `@intafaced/i18n`. **Do not** claim 100+ languages. **Do not** auto-MT catalogs.

**Not free / not agent solo:** choosing launch languages; hiring/assigning translators; any claim of full §9 completion.

---

## 7 · Related docs / code

- `packages/i18n/README.md` (honest scoreboard)
- `tooling/ci/i18n-bypass-scan.mjs` (queue law)
- `tooling/ci/i18n-scan.mjs` (heuristic)
- Open: `chore/rescue-shell-i18n-keys` / PR **#425** (`shell-i18n-scan.mjs`)
- Doctrine: `INTAFACED_DEFINITIVE_BUILD.md` §9, §14.4
- Notify coupling: notify consumers require catalog keys for title/body

---

## 8 · Explicit non-goals for this pack

- No machine-translated catalogs.
- No mass rewrite of apps/web in a research PR.
- No tracker `done` flip.
- No Shehzad / money-spine work under the guise of “formatMoney.”
