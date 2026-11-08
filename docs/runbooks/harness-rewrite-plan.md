# The journey harness rewrite: the plan

Written 8 Nov 2026, 02:12 UTC, from `origin/main` at `69f5a7a04`. A plan only; each piece below is its own PR.

## The outcome

1. Journeys and their helpers (`apps/customer/tests/real-app/`) import no CI tooling and no stack tooling. They reach the stack through three contracts only: `tooling/scripts/local-test-facts.mjs` (plain values and the state-folder rule, importing node built-ins only), files the stack writes in its state folder (data), and `tool()` in `stack.mjs` (a process).
2. One world-restore (`world-restore.mjs`) puts the shared world back between files. Nothing else does.
3. The TEST maker (`tooling/scripts/local-test-market.mjs`) stops being a cross-journey timing hazard: a journey waits on what the maker has quoted, never on time or on its log's wording.
4. What every journey step observes is unchanged: no step's words, assertions or timeouts change in any piece.

## Why: the map on `69f5a7a04`

- **CI tooling in every journey's import graph.** `world-restore.mjs:3` imports `declaredWorld` from `tooling/scripts/journey-world.mjs`, the CI scan the seal reads, and `journey.mjs` enters world-restore for every file. So every scan tweak reaches every journey step. `journey.mjs:5-6` adds `journey-fail-fast.mjs` and `journey-freeze-guard.mjs` the same way.
- **Stack tooling imported in-process,** counted with `grep` over `apps/customer/tests/real-app/*.mjs`:
  - `local-test-gates.mjs` (3,477 lines): 56 files, 27 names, among them `makeContext`, `founderTotp`, `approverSessions` and `setFeeSchedule`;
  - `local-test-state`, `-device`, `-chain` and `-founders`: 5 or 6 files each, for paths, ids and constants;
  - `local-test-market.mjs`: 2 files (`world-restore.mjs`, `J-derivatives-04`), for the maker's paths and log readers;
  - 8 more modules with 1 file each, mostly seeded TEST values.
- **`tool()` blocks the worker.** It runs `execFileSync` (`stack.mjs`), so a long tool call freezes the worker's event loop. There are 247 call sites in 98 files.

## Tonight's main reds, by mechanism

| Red                                                | Mechanism                                      | Piece                                                        |
| -------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| #7493 maker requote emptied a perp side            | the maker's own quote order                    | 1 (book-never-empty check over every market)                 |
| #7494 BTC/USDT requote under a step                | requote during a step that prices off the book | 1 (hold as a recorded lease)                                 |
| #7496 shift read before it was quoted              | waiting on log wording and time                | 1                                                            |
| #7468 maker restarted, next file met an empty book | restore waited on log wording                  | 1                                                            |
| J-copy-bots-otc-12 #5 (#7491), under investigation | depth at the best ask                          | 1 gives it a wait on what is quoted; the cause is still open |
| #7462 58 s freeze outlived Edge's keep-alive       | `tool()` blocks the worker                     | 4                                                            |
| #7463, #7465 identity restarts                     | restart and sign-up budgets                    | 5                                                            |
| #7500 TOTP replay in `founderSignIn`               | 4 writers of one founder step file             | 6                                                            |
| #7457 stale response across a reload               | a response wait bound before the navigation    | 7                                                            |

**A hazard in today's restore** (my inference from the code, 8 Nov): `restoreWorld` runs `unshift`, and when the maker was not restarted, `makerQuoting` returns at once, because every market was already quoted in that run. So the next file can read a book that is still shifted or held until the maker's next cycle (8 s). Piece 1 closes this.

## The rules for every piece

- **Its own PR,** undone by reverting that one PR. Pieces land one at a time, in the order below.
- **Never in the same PR:** the harness and the judge's yardstick or the seal (`tooling/ci/test-judge*`, `tooling/ci/ci-review/`, `journey-verdict.mjs`, `journey-seal.mjs`, `docs/runbooks/journey-baseline.json`). A piece that must touch the seal, the judge, a workflow or anything else that decides a pass, a count, a stop or a merge is a `gate:` PR with its own review. `journey.mjs` and `journey-freeze-guard.mjs` are gate files.
- **Behaviour kept:** each moved function gets a unit test showing the old and new versions give the same answers.
- **Verification**, stated in the PR:
  - R0 is the last finished full Real-app journeys run on main before the PR. The PR's own full run must be green on every step R0 had green, except the steps in `journey-baseline.json` and steps the machine set aside, each named.
  - The journeys the piece names pass 10 of 10 local repeats, with 0 retries.
  - The Test judge and the CI review PASS on the exact head.
  - After the merge, R1 is the first full run on main that contains it. A step green in R0 and red in R1 means the piece is reverted, unless it is fixed within 2 hours.
- **Full runs share runners:** the lead approves each one first.

## The pieces, in order

| #   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Journeys it affects                                                                                                                            | Builder-hours |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | **The maker, settled.** The maker writes a cycle record (`run/market-cycle.json`: run, cycle, start, and per market the resting quotes, shift and hold). It keeps its log as is. A harness module, `market.mjs`, reads the record. World-restore waits for a cycle that started after its `unshift` or restart to have quoted every market unshifted and unheld. `J-derivatives-04` waits for its shift the same way. `world-restore.mjs` stops importing `local-test-market.mjs`.                                                                                                                                                | Every file (restore); the 10 files that declare `market`, and the book readers (J-derivatives-03, -04, -06, J-cex-spot-03, J-copy-bots-otc-12) | 4             |
| 2   | **The world line in the harness.** `declaredWorld` moves to `real-app/world-line.mjs`, and the CI scan `journey-world.mjs` imports it from there (CI depends on the harness, never the reverse). The scan's output on main's tree stays byte for byte the same.                                                                                                                                                                                                                                                                                                                                                                   | Every file                                                                                                                                     | 2             |
| 3   | **Stack facts as one leaf.** `tooling/scripts/local-test-facts.mjs` holds the state-folder rule, the TEST browser key and its cookies, the chain's id and gate, file names and the seeded TEST values, and imports node built-ins only (a unit test holds it to that). `local-test-state`, `-device`, `-chain`, `-founders`, `-home`, `-entry` and `local-stack-services/bank` re-export from it, and the journeys import it in their place. A file the stack writes was the first idea, but it would need every running stack restarted and would fall outside the judge's import map and the seal's `local-test-*.mjs` trigger. | 6 to 10 files each                                                                                                                             | 4             |
| 4   | **`tool()` stops blocking the worker.** It becomes `execFile` behind the same name, and callers `await` it. Three PRs by area, with a harness unit test that fails on a `tool(` call that isn't awaited.                                                                                                                                                                                                                                                                                                                                                                                                                          | 98 files                                                                                                                                       | 5             |
| 5   | **One restart.** `restartService(name, env)` waits for the service's health through Edge on its own bounded budget, and fails naming the service and the tool's shown lines. It replaces `restartWith` and the direct `local-test-stack.mjs restart` calls.                                                                                                                                                                                                                                                                                                                                                                       | 40 files declaring `restart`                                                                                                                   | 2.5           |
| 6   | **One TOTP step owner.** `real-app/totp.mjs` is the only writer of the founder steps file, with #7500's retry after a refusal. `admin.mjs`, `staff.mjs` and `identity-factors.mjs` use it, and so does the gates code that journeys call.                                                                                                                                                                                                                                                                                                                                                                                         | 14 files                                                                                                                                       | 2             |
| 7   | **A response wait after a reload.** `afterNavigation(page, match)` binds a response wait to the navigation that follows. The call sites that wait across a reload or `goto` move to it.                                                                                                                                                                                                                                                                                                                                                                                                                                           | Up to 43 files (`reload(` with `waitForResponse`)                                                                                              | 3             |
| 8   | **The gates client in the harness.** The 27 names journeys use from `local-test-gates.mjs` move to `real-app/lib/gates-client.mjs`, and the CLI imports them back. Two PRs, each diff under the judge's 400 KB.                                                                                                                                                                                                                                                                                                                                                                                                                   | 56 files                                                                                                                                       | 4             |
| 9   | **The import boundary held.** A harness unit test fails when a `real-app/` file imports anything outside Playwright, Node, `real-app/` and `local-test-facts.mjs`. It passes on the tree after piece 8, and fails on a planted `tooling/` import.                                                                                                                                                                                                                                                                                                                                                                                 | none (a check)                                                                                                                                 | 1.5           |

Rollback for every piece: revert its PR. Only piece 9 builds on earlier ones (3 and 8), so revert it first if either of those goes.

## The forecast

The total is about 28 builder-hours, about 3.5 builder-days, plus one full run per PR (about 13 runs) and its wait for runners.

The design's 2 builder-days covered the import outcome, pieces 2, 3, 8 and 9 (11.5 h). Pieces 1 and 4 to 7 (16.5 h) were added for tonight's red classes. The binding constraint is runners, not builder time.

## Not in this plan

- Giving each journey that moves a price its own TEST market. That would change what steps observe, because the step words name BTC/USDT.
- Which journeys a PR runs. That is a separate builder's work in the seal, the shard planner and the workflow, and these pieces stay out of those files.
