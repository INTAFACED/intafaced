# Graphify peace check

> Retired on 2026-10-11 at Nitro's request. This page records historical checks. Its Graphify commands and requirements no longer apply; use local search and focused Git history as described in `AGENTS.md`.

**As of:** 2026-08-16. Tip at last run: `7d05b13e`.  
**Agents:** `pnpm graphify:peace`. **You:** say **graphify peace** after a cook.

GREEN = the **map** works. GREEN does **not** mean the last builder queried first.

---

## GitHub is the database — is Graphify useless?

**No.** GitHub holds the code. Every agent still works on a **checkout** (this Mac worktree, or a Bot `/workspace` clone). Graphify queries that checkout. It does **not** replace `gh pr list`.

**Wrong:** “the waste is `git status` / fetching GitHub.” Those are cheap and must stay live.  
**Right:** the waste is **re-reading `services/` + law + boards**. Graphify cuts that.

**What was broken:** we gitignored the map (#1671). A GitHub-only clone had no `graph.json`, so Bot/new worktree could not query until an 80s extract. Official Graphify **team** setup is: **commit the map**. This PR does that (`graph.json` + report + html). Cache stays local.

---

## What we actually tested (not vibed)

| Kind                                   | What                                                                                    | Result                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Smoke                                  | Graph loads; diagnose 0 broken edges                                                    | **PASS** 16 590 nodes / 35 117 edges                                                                                        |
| Smoke                                  | `explain PayService`                                                                    | **PASS** → `payment-service.ts` L547                                                                                        |
| Smoke                                  | Peace script fail-closed                                                                | **PASS** hide graph → RED exit 1; restore → GREEN                                                                           |
| Smoke                                  | Query-first law still on tip                                                            | **PASS** `AGENTS.md`                                                                                                        |
| Corpus                                 | No paste-w / docs / vendor / `.md` in graph                                             | **PASS**                                                                                                                    |
| Stress                                 | `graphify update` after **128** commits                                                 | **PASS** with `GRAPHIFY_MAX_WORKERS=1` (multiprocess = `Operation not permitted`)                                           |
| Stress                                 | Official `graphify benchmark` on **our** graph                                          | **PASS** their harness: **64.9×** fewer tokens vs naive full corpus (~17k/query vs ~1.1M). Canned questions, not a live PR. |
| Mountain                               | `query "hosted checkout payment links"`                                                 | **PASS** hits `checkout-page.ts` / `payment-service.ts`                                                                     |
| Mountain                               | `query "identity pii isolation vault"`                                                  | **PASS** `document-store.ts`, `boot-vault.ts`, `pii-isolation.gate.test.ts` — files exist on `origin/main`                  |
| Mountain                               | Bank withdraw files                                                                     | **PASS** `ramp-service.ts`, `withdraw-destination.ts` exist                                                                 |
| Poison                                 | `query "paste-w14…"`                                                                    | **PASS** no paste-wall files                                                                                                |
| Adversarial                            | `path PayService createLedgerClient`                                                    | **FAIL (expected trap)** 8 wrappers; none is `packages/ledger-client`. Documented in `AGENTS.md`                            |
| Adversarial                            | Vague “ledger-client move value”                                                        | **FAIL (expected trap)** also hits `moveAvatar`. Narrow the question                                                        |
| Adversarial                            | God-node #1                                                                             | **FAIL as a start point** academy ambassador class, not money                                                               |
| Independent builder (execute)          | First **code** command = `graphify query`; file = `checkout-page.ts`; `git cat-file` OK | **PASS** methodology                                                                                                        |
| Independent builder (read-only)        | No shell; grepped `graph.json` before `services/`                                       | **PARTIAL** — graph-first, not CLI                                                                                          |
| Independent review of old peace script | Could print GREEN without a smoke query                                                 | **TRUE** — script **replaced** this turn                                                                                    |

---

## What “full peace” is, and is not

**Is:** the install is official; the map is real; tight queries find the next mountains; a builder _with a shell_ did query-first; the check now **smokes query+explain+diagnose** or goes RED.

**Is not:** a guarantee the next chat will obey. That is still a yes/no after the cook. Path/god-nodes can still send you to the wrong file if you ignore the `AGENTS.md` traps.

---

## After you code — two lines only

1. Agent runs `pnpm graphify:peace` → paste **RESULT**.
2. **Queried first this cook?** yes / no / not a code cook.

Green + yes = used as intended.  
Green + no = tool works, we wasted it.  
Red = extract/update, then re-check.

---

## Commands (agents)

```
pnpm graphify:peace
pnpm graphify:extract
GRAPHIFY_MAX_WORKERS=1 graphify update .
graphify query "<mountain, tight>" --budget 1500
```
