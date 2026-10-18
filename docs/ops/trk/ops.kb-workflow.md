# TRK-ops.kb-workflow — implementable spec

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `ops.kb-workflow`  
**Title:** Knowledge base and workflow automation (§25:720)  
**Module / phase:** `core-ops` · phase **5** · plane **F** (operator-side, not a plane ruling)  
**Status on tip:** declared `ready` (default) · computed **ready** · **owner:** none  
**Depends on:** `ops.support` — **`done`** on `origin/main` (`tooling/tracker/features.mjs` `ops.support`, owner `Phantom-X-007`, #1494 Stage-4 + compose pin)  
**Class (this cook):** **N** — content surface, no ledger, no money. Workflow-execution half is **parked** (would become Class **M** the moment it acts on a user’s behalf).  
**Tip freeze:** `origin/main` @ `318425e8` (re-derive before implement)  
**Pack type:** implementable research — no `features.mjs` edit from this docs PR (not a mountain event).

**Tracker note is stale.** The row still says “Blocked on ops.support (`ready`, not `done`)”. The badge in `docs/TRACKER.md` is 🟢 because the edge is spent. Do not flip this row `done` from a spec PR.

---

## 1 · Two capabilities — only one is this cook

Law §25:720 is one matrix line with two different sizes.

| Half                    | What it is                                                                  | This row now                                |
| ----------------------- | --------------------------------------------------------------------------- | ------------------------------------------- |
| **Knowledge base**      | Versioned, published, vendor-clean articles extracted from the desk catalog | **Buildable today** — extend `svc-support`  |
| **Workflow automation** | User-defined triggers that run actions across modules                       | **Parked** — that is a second agent runtime |

`agents.gateway` already owns the fleet runtime, guardrail schema, and append-only `agents.agent_actions` (`services/svc-agents/src/db/schema.ts`, `services/svc-agents/src/runtime.ts`). A workflow engine inside `svc-support` would punch a hole in the Agentic Law. Owner ruling required before that half ships; this spec does not invent one.

`ops.support` **done** already stores a day-one KB spine. This row is the **extraction**: version + publish + contract completeness — not a second catalog and not a CMS.

---

## 2 · What “done” means (plain)

1. A user (or public caller) lists / searches / fetches **published** help articles. Missing id → `null` / empty, never an invented article.
2. Every article is **versioned**. A locale edit of German copy does **not** change the citation digest (keys, not rendered text). A title/body **key** change **does**.
3. An operator can publish / unpublish without a third-party CMS. Unpublished never appears on the public doors.
4. Escalation still cites **real catalog ids** (`citeKbArticle` in `services/svc-support/src/case-file.ts`). An unpublished / unknown id contributes **no** citation (same skip as today’s missing id in `SupportService.escalate`).
5. `agents.support` keeps reading `SupportKbArticle` (`kbArticleFromContract` / `searchKbCatalog` in `services/svc-agents/src/support-agent/grounding-resolve.ts`). It must not SQL `support.*` tables.
6. Human desk still works with the agent down (`deskVsAgentSplit().deskStandalone === true` in `services/svc-support/src/desk-vs-agent-split.ts`).
7. **No** workflow trigger runner in `svc-support`. If a door is added, it refuses by name and points at `agents.gateway`.

---

## 3 · Current code state (tip — RAN-IT against `318425e8`)

### 3.1 What already shipped under `ops.support`

| Path                                                         | Fact                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `services/svc-support/src/kb-catalog.ts`                     | `PLATFORM_KB_SPINE` — 5 hardcoded articles; keys only                                 |
| `listPlatformKb` / `searchKb` / `getKbById`                  | In-memory. Empty query → full spine. Unknown → `[]` / `null`                          |
| `assertKbArticle`                                            | Refuses empty keys, keys outside `support.kb.*`, `VENDOR_SMELL`                       |
| `KbCatalogErrorCode`                                         | `support.kb_invalid` · `support.kb_vendor_name`                                       |
| `SupportService.listKb` / `searchKb` / `getKbArticle`        | Thin wrappers around the catalog                                                      |
| `createSupportRouter` `listKb` / `searchKb` / `getKb`        | **`publicProcedure`** — no scope                                                      |
| `packages/contracts/src/support.ts` `supportKbArticleSchema` | `{ id, titleKey, bodyKey }` — **no revision, no published flag**                      |
| `SupportContract`                                            | Declares `listKb` only — **`searchKb` / `getKbArticle` missing from the interface**   |
| `packages/i18n/src/catalog.ts`                               | English strings for the five `support.kb.*` keys (resolver, not the catalog)          |
| `citeKbArticle`                                              | Digests `${titleKey}${bodyKey}` so locale copy cannot invalidate historic citations   |
| `services/svc-support/src/db/schema.ts`                      | `tickets` · `comments` · `ticket_events` · `case_files` — **no `kb_articles` table**  |
| Edge                                                         | `services/svc-edge/src/routes.ts` prefix `/api/support` → `SUPPORT_URL` (dev `:4017`) |
| Compose                                                      | `docker-compose.apps.yml` + `fleet-compose-pin.test.ts`                               |
| Desk / agent split                                           | `DESK_OWNS` includes `'kb'`; agent is assist only                                     |

Spine ids on tip: `kb-account-access` · `kb-security-basics` · `kb-orders-status` · `kb-deposit-withdraw-honest` · `kb-paper-vs-live`.

### 3.2 What is still residual (this row)

1. Catalog is a **TypeScript constant**, not a versioned published set.
2. Public doors cannot hide a draft — there is no draft.
3. Contract shape cannot carry `revision` / `published`.
4. `SupportContract` is behind the router (search/get live on the service, absent on the interface).
5. `searchKbCatalog` in `svc-agents` **mirrors** `searchKb` locally so the agent does not SQL another service — keep that; do not collapse it into a join.
6. No operator publish mutation.
7. Workflow half does not exist and must not be scaffolded here.

### 3.3 Related mountains (do not merge)

| Id               | Status on tip | Relation                                                               |
| ---------------- | ------------- | ---------------------------------------------------------------------- |
| `ops.support`    | **done**      | Desk owns tickets + current spine; this row extracts/versions the KB   |
| `agents.support` | **done**      | Grounded on `SupportKbArticle`; live prod credentials Class X residual |
| `agents.gateway` | **done**      | Sole runtime for any future workflow action                            |
| `infra.i18n`     | ready         | Copy catalogs — this row keeps **keys** on the wire                    |
| `ops.admin`      | ready         | Staff UI later; **not** required for Stage 1                           |

Frontend (`apps/admin`, vendored shell) is **out of this cook** (`nitro-frontend-all`).

---

## 4 · Leverage path (mandatory)

**Phase A IN — extend `svc-support`.** Do not scaffold `svc-kb`, `svc-workflow`, a second SPA, or a CMS.

| Need                       | Existing asset                                           | Do not                          |
| -------------------------- | -------------------------------------------------------- | ------------------------------- |
| KB storage + public doors  | `svc-support` + `SupportContract` + edge `/api/support`  | New service                     |
| Copy                       | `@intafaced/i18n` `support.kb.*` keys                    | English strings on the wire     |
| Agent grounding            | `svc-agents` `grounding-resolve.ts` + `SupportKbArticle` | Agent SQL into `support.*`      |
| Citations                  | `citeKbArticle`                                          | Digest rendered locale copy     |
| Any later “if X then do Y” | `agents.gateway` + `agent_actions`                       | Trigger runner in `svc-support` |

Horizon: `docs/INTERNET-LEVERAGE-PHASE-B-FULL-HORIZON-2026-08-05.md` names `ops.support` as **IN / MID / N**. There is **no** named row for `ops.kb-workflow` — treat it as the same IN path. PR body must say this.

---

## 5 · File map (first implement PR)

One service: **`svc-support`**. Contracts first if the schema grows.

| File                                                                                     | Change                                                                                                                             |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/support.ts`                                                      | **Do not edit** (T-001). Public wire stays `{id,titleKey,bodyKey}`; `revision`/`published` stay in `kb_articles` until that merge. |
| `services/svc-support/src/kb-catalog.ts`                                                 | Keep `assertKbArticle` + `VENDOR_SMELL`; published-only list/search/get; `toPublicKb` strips store columns                         |
| `services/svc-support/src/db/schema.ts` + `drizzle/0003_kb_articles.sql` (+ `.down.sql`) | `support.kb_articles` (`id`, `title_key`, `body_key`, `revision`, `published`, `updated_at`) — **no body text, no money columns**  |
| `services/svc-support/src/store.ts`                                                      | `listPublishedKb` / `getPublishedKb` / `putKbRevision`                                                                             |
| `services/svc-support/src/support-service.ts`                                            | Wire store; `escalate` still `getKbById` **published only**                                                                        |
| `services/svc-support/src/router.ts`                                                     | Keep public list/search/get; add `support:ops` `publishKb` / `unpublishKb`                                                         |
| `packages/i18n/src/catalog.ts`                                                           | New keys only if new article ids land — same `support.kb.*` prefix                                                                 |
| `services/svc-support/src/kb-catalog.test.ts` (+ new store/router tests)                 | Names in §7                                                                                                                        |
| `services/svc-agents/src/support-agent/*`                                                | **Do not edit** unless the article shape breaks compile — then a **second** PR                                                     |

Seed: migrate the five `PLATFORM_KB_SPINE` rows as `revision: 1`, `published: true` so public doors stay non-empty.

---

## 6 · Refuse codes

### Already on tip (keep)

| Code                           | Where            | Meaning                                       |
| ------------------------------ | ---------------- | --------------------------------------------- |
| `support.kb_invalid`           | `KbCatalogError` | Empty id/keys, or keys outside `support.kb.*` |
| `support.kb_vendor_name`       | `KbCatalogError` | `VENDOR_SMELL` hit on id or keys              |
| `support.not_found`            | tickets          | Unrelated; do not reuse for missing articles  |
| `support.case_file.ungrounded` | escalate         | Empty citations — still applies               |

Public `getKb` stays **`null`**, not a throw, for unknown / unpublished (today’s `getKbById` contract).

### Add on this row

| Code                                  | When                                                                                     | HTTP / tRPC           |
| ------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------- |
| `support.kb.not_published`            | Operator fetch of a draft is fine; **public** mutation that would leak a draft           | `PRECONDITION_FAILED` |
| `support.kb.revision_stale`           | `publishKb` with `baseRevision` that is not current                                      | `CONFLICT`            |
| `support.kb.unpublished_cite`         | **Not used on escalate** — keep today’s silent skip so a stale id cannot strand the user | —                     |
| `support.workflow.use_agents_gateway` | Any workflow-trigger door if one is stubbed                                              | `PRECONDITION_FAILED` |

Never add `support.kb.refund_*` or any amount-bearing code. `money_request` remains an escalation **reason name** only (`EscalateTicketInput`).

---

## 7 · Test names (must exist before `done`)

Keep the existing `kb-catalog.test.ts` cases (rename-safe; behaviour is the bar):

- `spine is non-empty and vendor-clean`
- `search finds by id fragment; unknown returns empty not invent`
- `getKbById null when missing`
- `refuses vendor-named keys`
- `refuses keys outside support.kb.*`

Add:

- `listKb omits unpublished revisions`
- `getKb returns null for unpublished, never invents`
- `searchKb empty query returns published only`
- `citeKbArticle digest is locale-stable (keys not copy)` — already asserted in `case-file.test.ts`; keep green
- `escalate citing unpublished id contributes no citation`
- `publishKb bumps revision and refuses stale baseRevision`
- `unpublishKb hides the article on public listKb`
- `assertKbArticle still refuses vendor keys after persist`
- `kb_articles table has no amount/balance/currency column`
- `workflow trigger door refuses support.workflow.use_agents_gateway` — only if a stub door is added; otherwise omit (do not add the door to satisfy the test)

Router: extend `router.mount.test.ts` (`listKb is public and returns Stage-2 spine from service`) so public still works unauthenticated and `publishKb` requires `support:ops`.

---

## 8 · Staged DoD (checkable)

### Stage 1 — versioned published catalog (first PR · Class N · **this cook**)

- [x] `support.kb_articles` (+ down migration) · seed five spine rows published r1
- [ ] `SupportKbArticle` carries `revision` + `published` on the **wire** — T-001; this cook keeps them server-side only
- [ ] `SupportContract.searchKb` + `getKbArticle` exist — T-001
- [x] Public doors = published only; unknown → empty/`null`; response keys `{id,titleKey,bodyKey}` only
- [x] Operator `publishKb` / `unpublishKb` (`support:ops`) + stale-revision refuse
- [ ] `assertKbArticle` + brand-scan still green
- [ ] Tests in §7 except the workflow stub
- [x] No `apps/admin` / shell change
- [x] No `features.mjs` `done` flip (reachability of a **versioned** public KB in a real env is the flip; seed+API alone is Stage 1)

### Stage 2 — consumers stay honest

- [ ] `citeKbArticle` still keys-only
- [ ] `agents.support` still maps `SupportKbArticle` (no `support.*` SQL)
- [ ] New article ids get `support.kb.*` i18n keys in the same or a follow-up contracts/i18n PR

### Stage 3 — workflow (parked)

- [ ] Owner ruling: ship at all? If yes, it is a named `svc-agents` task, every action → `agent_actions`, guardrails refuse money tools.
- [ ] `svc-support` never grows a trigger runner.

### Tracker `done` bar

Flip only when Stage 1 is reachable through edge `/api/support` in compose **and** unpublished articles cannot leak on the public procedures. Workflow half is **not** on this bar. Agent routing names are **not** this bar (`desk-vs-agent-split.ts`).

---

## 9 · Class / money / brand

| Topic            | Rule                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Class            | **N** for Stage 1. **M** if a later PR lets automation move value (then ledger recipes only). |
| §0.6             | No `ledger-client` in `svc-support`. No amount column on `kb_articles`.                       |
| §0.7             | Keys + copy: no partner / model / venue product names. Reuse `VENDOR_SMELL`.                  |
| Class X          | Who may hold `support:ops` in prod; live credentials. Not this cook.                          |
| One service / PR | Contracts schema change may land with `svc-support`. Do not bundle `svc-agents` edits.        |

---

## 10 · Non-goals

- No `svc-kb` / `svc-workflow` scaffold
- No CMS, no markdown-in-DB bodies (keys stay the article)
- No refund / chargeback recipes under this id
- No SLA / ETA on help articles (`sla-honesty.ts` already forbids SLA on the queue)
- No Vue / `apps/admin` help browser (frontend lane)
- No `features.mjs` ownership flip from research
- No dual-edit of open `svc-support` money-adjacent PRs (re-check `gh pr list` before implement)

---

## 11 · First implement PR (when claimed)

**M** — contracts + `0003_kb_articles` + store + public/ops doors + tests. Zero money. Zero UI.  
Claim: LIVE-LANES session row + tracker mountain event on that implement PR (not this spec).  
Re-derive tip: `git fetch && git log -1 --oneline origin/main` — this freeze is `318425e8`.

---

## 12 · Related

- Law: `INTAFACED_DEFINITIVE_BUILD.md` §25:720 · §8.8 `svc-core-ops` · §8.2 Agentic Law
- Desk spec (partially stale vs done mountain): `docs/ops/trk/ops.support.md`
- Agent spec (stale “no KB yet”): `docs/ops/trk/agents.support.md`
- L3 spine pack: `docs/ops/slices/L3-2026-08-05-support-kb.md`
- Phase A: `docs/INTERNET-LEVERAGE-CURRENT-AUDIT-2026-08-04.md` (ops.support IN)
- Phase B: `docs/INTERNET-LEVERAGE-PHASE-B-FULL-HORIZON-2026-08-05.md` row `ops.support`
