# Frontend Operating Plan — Stream A app surface

**[HISTORY 2026-09-01]** Not live execution. Live: [`FRONTEND-REMAINING-SOT-2026-08-25.md`](FRONTEND-REMAINING-SOT-2026-08-25.md). Chart licence: [`LICENCE-POSITION.md`](LICENCE-POSITION.md) §1.1a (Advanced Charts pending; LWC interim).

**Status:** planning record, 2026-07-30. Written against `origin/main` @ `5d742c6` (#133).
**Author role:** Planner agent = planner/auditor this turn. **Executor agent = executor.**
**Scope:** the vendored exchange shell at `vendor/*/05_Web_Front` served on `:8090`. **Not** `apps/web`.
**Companions:** [`STREAM-A-UNSTICK-CONTINUE.md`](STREAM-A-UNSTICK-CONTINUE.md) (freeze hazard), [`LICENCE-POSITION.md`](LICENCE-POSITION.md) (§1.1 charting), [`LIVE-LANES.md`](LIVE-LANES.md) (collision board), [`RUNNING.md`](RUNNING.md) (platform boot).

> Everything in §0 was read off disk this turn. Everything in §2–§5 is a proposal until a PR lands.

---

## 0 · Ground truth established this turn

| Fact                                                                                                                                                                                                                                                                                    | Evidence                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Shell stack is **Vue 2.5 / webpack 3 / iView 3 / jQuery 3 / less+sass**, `engines.node >= 4`                                                                                                                                                                                            | `vendor/*/05_Web_Front/package.json`                                                       |
| Shell ships **dead 2018 e2e scaffolding** — Nightwatch 0.9 + selenium-server + chromedriver 2.27, one placeholder spec                                                                                                                                                                  | `test/e2e/`, `test/unit/specs/HelloWorld.spec.js`                                          |
| **No Playwright, Cypress or Puppeteer anywhere in the repo**                                                                                                                                                                                                                            | grep over every non-vendored `package.json`                                                |
| A dev server **is running right now** on `:8090`, PID 40202, cwd = `.worktrees/feat-app-phase1-plan/.../05_Web_Front`                                                                                                                                                                   | `lsof -iTCP:8090`, `ps`                                                                    |
| It serves `GET /` → 200 (4.7 KB, INTAFACED title) and `GET /app.js` → 200 (**12.5 MB**)                                                                                                                                                                                                 | `curl`                                                                                     |
| Dev-server default port in config is **8080**; `:8090` comes from a `PORT` env override                                                                                                                                                                                                 | `config/index.js`                                                                          |
| `node_modules` exists **only** in the Stream A worktree, not in a fresh worktree                                                                                                                                                                                                        | `ls`, and `pnpm wt` printed `pnpm: command not found` when creating this doc's worktree    |
| Every backend call is **same-origin, proxied** by the dev server (`/uc`, `/market`, `/exchange`, `/otc`, `/api`→svc-edge:4000)                                                                                                                                                          | `config/index.js`                                                                          |
| `/exchange` has a **GET-HTML bypass** so deep links render the SPA instead of the API's 404                                                                                                                                                                                             | `config/index.js`                                                                          |
| Routes are flat in `src/config/routes.js` (no `src/router/`): `/`, `/login`, `/register`, `/exchange/:pair`, `/dex`, `/bank`, `/pay`, `/p2p`, `/token`, `/agents`, `/protocol`, `/chain`, `/platform`, `/blueprint`, `/academy`+`/launch` → `NotBuilt`, `/uc/*` (24 children), `/otc/*` | `src/config/routes.js`                                                                     |
| `pnpm-workspace.yaml` globs `tooling/*` — but **no `tooling/*` dir has a `package.json`**, so none are workspace packages today                                                                                                                                                         | `pnpm-workspace.yaml`, filesystem check                                                    |
| `pnpm scan:workspace` only inspects `services/*`                                                                                                                                                                                                                                        | `tooling/ci/workspace-sync.mjs`                                                            |
| CI is a single `.github/workflows/ci.yml`                                                                                                                                                                                                                                               | filesystem                                                                                 |
| TradingView **Charting Library** (proprietary, unlicensed) was deleted in #106 and has a history-purge script pending; **Lightweight Charts** (with its own LICENSE file) is already vendored under `src/assets/js/market-chart/` and is untracked                                      | `tooling/scripts/purge-charting-library-history.sh`, `docs/LICENCE-POSITION.md` §1.1, `ls` |

**Two facts that change the plan more than any opinion below:**

1. **Boot is nearly solved.** The shell already compiles and serves. The gap is that boot is _manual, undocumented and worktree-local_ — not that it is hard.
2. **Backends-down is the correct fixture, not a blocker.** Phase 1's shipped work (honesty bar, CEX/DEX toggle, order confirm, mobile drawer, empty states) is _exactly_ what the UI must show when there is no data. A harness that boots the shell alone can prove almost all of it. Only S2 (prices) genuinely needs the market seed (#109).

---

## 1 · Adversarial audit — what was wrong with "ask Nitro to open localhost"

Seven distinct failures. They are not restatements of one another; each has its own fix.

### 1.1 · Role inversion — the principal was made the test executor

Nitro is non-technical. Asked to open `:8090`, he can observe _"this looks wrong"_ but cannot distinguish **app broken** from **backend not seeded** from **wrong port** from **stale bundle**. His report of experience is ground truth; his _diagnosis_ was never his job, and the request implicitly demanded one.
**Fix:** agents diagnose. He is shown a screenshot only when the question is genuinely taste.

### 1.2 · The proof was unfalsifiable

"Looks fine" produces no artefact. It cannot be attached to a PR, cannot be re-run, cannot regress, cannot be diffed against last week. It is a claim about a moment, and the moment is gone.
**Fix:** every check emits a file — screenshot, console-error log, pass/fail table — into a committed-or-uploaded artefact directory.

### 1.3 · It serialised the whole stream on one human's availability

Every verification blocked on Nitro being awake, at a laptop, and willing. That is the single largest source of dead time in Stream A.
**Fix:** the gate runs headless, unattended, in any worktree, at any hour.

### 1.4 · It disguised the real gap instead of closing it

The actual missing capability was **a reliable, scripted, repeatable boot**. Asking a human to open a URL _outsourced_ that problem rather than fixing it. The evidence is on disk today: the only working dev server is a hand-started process in one worktree, and `node_modules` exists nowhere else.
**Fix:** `boot.mjs` is PR-1. The harness is downstream of it, not a substitute for it.

### 1.5 · It shares a root cause with the session-freeze incident

The same instinct — _show him it live_ — is what put `npm run dev` in the foreground and froze prior Stream A chats (documented in `STREAM-A-UNSTICK-CONTINUE.md`). "Human opens localhost" and "agent hangs on a dev server" are the same design error: **treating a long-lived process as a step in a turn.**
**Fix:** boot is always detached + polled + bounded by timeout. Never awaited in the foreground. This is a hard rule, restated in §2.3.

### 1.6 · Human eyeballs have no coverage discipline

One person, one viewport, one route, once. No mobile. No console errors — a Vue 2 app throws silently into devtools while looking perfect. No second run to catch flake. No record of what was _not_ looked at.
**Fix:** an explicit route × viewport matrix in one file, so coverage is a thing you can read rather than a thing you hope happened.

### 1.7 · It violated this repo's own standard

`AGENTS.md` §4: _"Never claim something works or is 'done' without running it or its tests first."_ A human's glance is not a run. We were about to certify visual work by a method the repo's own law forbids.
**Fix:** "visual done" is defined in §4.2 as a machine-produced artefact set, and nothing else.

### What Nitro is still for

Taste, direction, and product calls. The S8 "human look tour" is real and stays — but it is **elective and aesthetic**, never a functional certification, and never a prerequisite for a PR to merge.

---

## 2 · Automation stack — decision and first harness

### 2.1 · The decision

**Playwright**, run as an **external process against the already-running dev server**, in a **non-package directory** (`tooling/uiproof/`), with `@playwright/test` as a **root devDependency**.

| Option                                     | Verdict                                    | Why                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Playwright**                             | **CHOSEN**                                 | Talks HTTP to `:8090` — zero coupling to webpack 3 / babel 6 / iView 3. Multi-viewport and multi-browser are config lines. `page.on('pageerror')` is the single highest-value check for a 2018 Vue app. Headless, deterministic, CI-able, free. Ships its own browser so it does not depend on Nitro's Chrome. |
| **Cypress**                                | Rejected                                   | Runs _inside_ the page, which fights same-origin/websocket-heavy trading UI. Heavier install, weaker viewport matrix, weaker multi-tab. Buys nothing Playwright does not, costs more.                                                                                                                          |
| **Computer Use / browser computer-use**    | Rejected **as a gate**; kept as an S8 tool | Non-deterministic, token-priced per run, cannot run unattended in CI, cannot fail a PR reproducibly. It is excellent for _exploratory_ "does this feel like a real exchange" passes. It is not a regression gate.                                                                                              |
| **Orca**                                   | Not applicable                             | Worktree/terminal orchestration and an embedded browser for agent handoff. It is how executor gets a workspace, not how work is proven. Using its browser as the proof surface would make the proof unreproducible outside Orca.                                                                               |
| **Nightwatch/Selenium (already vendored)** | Do not revive                              | 2018, chromedriver pinned to Chrome 57. Dead scaffolding. _Not deleted this turn_ — flagged only, per surgical-changes rule.                                                                                                                                                                                   |

**The one thing that makes this cheap:** the harness never enters the vendored package. No new dependency lands in `vendor/*/05_Web_Front/package.json`, so vendor drift stays zero and the licence inventory in `NOTICE` is untouched.

### 2.2 · Why `tooling/uiproof/` with no `package.json`

`pnpm-workspace.yaml` globs `tooling/*`, but pnpm only adopts a directory that _has_ a manifest — and none there do. A manifest-less `tooling/uiproof/` is therefore invisible to pnpm, invisible to `turbo`, invisible to the Dockerfile, and invisible to `pnpm scan:workspace` (which reads `services/*` only). **Zero gate friction, zero deployment surface.**

Playwright goes in the **root** `devDependencies` alongside the existing `vitest` / `tsx` / `turbo`.

### 2.3 · Harness shape

```
tooling/uiproof/
  boot.mjs               # idempotent, detached boot of :8090 — never foreground
  matrix.mjs             # the route × viewport table — single source of coverage truth
  playwright.config.mjs
  proof.spec.mjs         # the assertions
  report.mjs             # writes the human-readable PROOF.md
.artifacts/uiproof/      # gitignored output: screenshots + PROOF.md + console logs
```

Root `package.json` gains two scripts and one devDependency — nothing else:

- `ui:boot` → `node tooling/uiproof/boot.mjs`
- `ui:proof` → boot, then `playwright test -c tooling/uiproof/playwright.config.mjs`, then `node tooling/uiproof/report.mjs`

**`ui:proof` is deliberately NOT wired into `pnpm verify`.** `verify` must stay a fast, browserless, hermetic gate. UI proof is a Stream-A-only step whose artefacts get attached to the PR.

### 2.4 · `boot.mjs` — the seven behaviours that matter

1. **Reuse before spawn.** Probe `http://127.0.0.1:8090/`. If it answers, exit 0 immediately and say so. (Today's live server would be reused, not duplicated.)
2. **Detached spawn.** `spawn(..., { detached: true, stdio: ['ignore', log, log] }).unref()`. The process outlives the turn; the turn does not wait on the process. This is the direct fix for §1.5.
3. **Correct working directory.** Resolve `git rev-parse --show-toplevel` + `vendor/*/05_Web_Front`, so the proof is of **the branch under test**, not of main.
4. **Fail loudly on missing deps.** If `node_modules` is absent, exit non-zero with the literal command to run. Do not silently install — a 2018 tree resolving fresh is a several-minute event that must be a visible decision.
5. **Two-stage readiness — this is the subtle one.** webpack-dev-server answers `GET /` with `index.html` _before compilation finishes_. Readiness is `GET /` **200 AND** `GET /app.js` **200**. Polling only `/` produces a green boot and a white-screen screenshot.
6. **Bounded.** ~240 s timeout (12.5 MB bundle, webpack 3, cold cache), then exit non-zero with the tail of the log.
7. **Pidfile + log** under `.artifacts/uiproof/` so a later run can find and stop what it started.

### 2.5 · What PR-1 asserts, per route × viewport

Viewports: **desktop 1440×900** and **mobile 390×844** (the mobile drawer, S6, is Phase 1 work and is invisible at desktop width).

1. **No uncaught page errors.** `page.on('pageerror')` → any entry fails the route. The highest-yield check available on this stack.
2. **No console errors**, with a narrow allowlist for _network_ failures against `/uc`, `/market`, `/exchange`, `/otc`, `/api` — because backends-down is the intended fixture (§0). Any non-network console error fails.
3. **Vue actually mounted.** `#app` has child elements. Distinguishes "rendered" from "white screen with a 200".
4. **Brand honesty at runtime.** The rendered DOM contains none of the forbidden vendor strings that `tooling/ci/brand-scan.mjs` scans for statically. Static scan misses anything assembled at runtime; this closes that hole.
5. **Screenshot** — full page, both viewports, deterministic filename.

**Deliberately NOT in PR-1:** pixel-diff baselines. Brand landed in #86 and Phase 1 UI is still moving; baselines now would generate noise, not signal. They arrive in Pass 4.

### 2.6 · Route set for PR-1

Derived from `src/config/routes.js`, restricted to Stream A Phase 1 surface:

| Route                | Proves                                                                           |
| -------------------- | -------------------------------------------------------------------------------- |
| `/`                  | index shell, honesty bar, market table empty state                               |
| `/exchange/btc_usdt` | trading terminal, honesty, order confirm entry point, deep-link bypass           |
| `/dex`               | CEX/DEX plane toggle target (S3)                                                 |
| `/login`             | auth surface + mobile drawer (S6)                                                |
| `/uc/account`        | **asserts the redirect to `/login`**, not the account UI — `/uc/*` is auth-gated |

The last row is honest about a real limit: **S5/S7 account empty-vs-error cannot be proven without a session.** That needs an auth fixture and is Pass 3, not PR-1. Claiming otherwise would be exactly the unfalsifiable proof §1.2 rejects.

---

## 3 · Research brief — references and libraries (no install, no adoption)

Ten candidates, each mapped. **Nothing here is approved by appearing on this list.**

| #   | Candidate                                                               | Verdict                                                    | Reasoning                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Playwright** (`@playwright/test`)                                     | **Phase 1 harness**                                        | §2. The only new dependency this plan proposes.                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2   | **iView 3 / View UI** (already installed)                               | **Phase 1 harness**                                        | It _is_ the shell's component system. Every Phase 1 UI need is met by reusing it. Adding a second system is the failure mode, not the upgrade.                                                                                                                                                                                                                                                                                                            |
| 3   | **`@axe-core/playwright`**                                              | **Phase 1.5**                                              | Accessibility floor as three lines inside the existing spec. Zero design impact, zero runtime footprint (test-time only). Cheapest real quality win after the error gate. Not PR-1 — do not bundle two new deps in one PR.                                                                                                                                                                                                                                |
| 4   | **TradingView Lightweight Charts** (Apache-2.0)                         | **Phase 2 polish — licence-gated, already partly present** | `src/assets/js/market-chart/` already holds `lightweight-charts.standalone.production.js` + its `LICENSE`, **untracked**. **CRITICAL:** this is _not_ the proprietary **Charting Library** purged in #106 (`LICENCE-POSITION.md` §1.1). Before any use: confirm the vendored file is Lightweight Charts, record it in `NOTICE`, and keep it nowhere near the purged path. Blocked behind #109 anyway — charts without a market seed would be fake prices. |
| 5   | **Binance / Bybit / OKX** spot terminals                                | **Phase 2 polish — reference only, never code**            | Density conventions: order-book depth shading, tab-per-order-type, one-line balance strip. Read for _pattern_, reimplement in iView. Copying markup or assets is a licence event.                                                                                                                                                                                                                                                                         |
| 6   | **Hyperliquid**                                                         | **Phase 2 polish — reference only**                        | Best current reference for a _DEX plane_ that does not look like a downgrade from the CEX plane. Directly relevant to S3's toggle, which is the one place the two planes must feel like one product.                                                                                                                                                                                                                                                      |
| 7   | **Coinbase Advanced Trade**                                             | **Phase 2 polish — reference only**                        | The strongest reference for _honest empty and error states_ on a money surface — the exact Phase 1 theme. Highest-value single reference on this list for what has already shipped.                                                                                                                                                                                                                                                                       |
| 8   | **Playwright `toHaveScreenshot()`** visual baselines                    | **Phase 2 polish**                                         | Native to the chosen stack — no Percy/Chromatic subscription, no third party seeing the UI. Turn on only after Phase 1 UI stops moving, or it produces pure noise (§2.5).                                                                                                                                                                                                                                                                                 |
| 9   | **Tailwind / shadcn / Radix**                                           | **DO NOT USE**                                             | Collides with #86 (black/orange tokens already landed). shadcn/Radix are React — the shell is Vue 2. Adopting any of these is "new design system mid-flight", which doctrine forbids without a product decision.                                                                                                                                                                                                                                          |
| 10  | **Element UI (Vue 2)**                                                  | **DO NOT USE**                                             | Technically compatible, which is what makes it dangerous. A second component library alongside iView doubles the surface and guarantees visual drift.                                                                                                                                                                                                                                                                                                     |
| 11  | **Storybook**                                                           | **DO NOT USE (now)**                                       | No supported webpack 3 path. Would force a build-tool migration of a _vendored_ package — the largest possible change for a documentation benefit. Revisit only if the shell is ever de-vendored.                                                                                                                                                                                                                                                         |
| 12  | **Nightwatch + selenium-server + chromedriver 2.27** (already vendored) | **DO NOT USE — removal candidate**                         | Dead 2018 scaffolding pinned to Chrome 57. Flagged, not deleted (surgical-changes rule). Worth its own tiny cleanup PR later.                                                                                                                                                                                                                                                                                                                             |

**Net new dependencies proposed across all of Phase 1: one** (`@playwright/test`, root, dev-only), plus `@axe-core/playwright` at Phase 1.5.

---

## 4 · The operating plan

### 4.1 · Ordered passes

| Pass  | Name                | Delivers                                   | Gate to leave                                                                                                            |
| ----- | ------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **1** | **Boot**            | `boot.mjs` + `RUNNING-STREAM-A.md`         | Two consecutive clean boots from a _fresh_ worktree, one cold + one warm (reuse path), each exiting 0 with `/app.js` 200 |
| **2** | **Proof**           | Playwright harness, 5 routes × 2 viewports | Full matrix green; `PROOF.md` + 10 screenshots produced; one deliberately-broken route proves the gate can go red        |
| **3** | **Auth fixture**    | Logged-in storage state                    | `/uc/account` reachable; S5/S7 empty-vs-error asserted rather than assumed                                               |
| **4** | **Baselines**       | `toHaveScreenshot()` snapshots             | Two consecutive runs with zero diff (proves non-flaky before it can protect anything)                                    |
| **5** | **Prices**          | Unblocked by market seed (#109)            | S2 asserts real numbers. **Never** before #109 — a passing price test on seeded-fake data is worse than no test          |
| **6** | **Human tour (S8)** | Screenshot pack for Nitro                  | Elective. Runs only when Nitro asks for taste input. Never blocks a merge                                                |

Passes 1–2 are the whole of the GO packet. **Do not start 3 before 2 is green.**

### 4.2 · Exit criteria — the definition of "agent checks out"

A Stream A visual claim is done when **all six** hold:

1. `pnpm ui:proof` exits **0** from a clean worktree, unattended.
2. `.artifacts/uiproof/PROOF.md` exists and every row reads PASS.
3. A screenshot exists for **every** route × viewport in `matrix.mjs` — coverage is read off the matrix file, not asserted in prose.
4. **Zero** uncaught page errors; **zero** non-network console errors.
5. `pnpm verify` is green (unchanged obligation — `ui:proof` is additional, never a substitute).
6. The PR body quotes the **actual** `PROOF.md` table.

**No human opened a browser at any point in that list.** If any of 1–6 cannot be produced, the claim is "unverified" and says so.

### 4.3 · RACI — Planner vs executor

| Activity                                   | Planner | executor           |
| ------------------------------------------ | ------- | ------------------ |
| Plan, audit, harness design, exit criteria | **R/A** | C                  |
| Writing `boot.mjs`, harness, specs         | C       | **R/A**            |
| Vendor shell UI edits (Phase 1 remainder)  | C       | **R/A**            |
| Running the harness, producing artefacts   | I       | **R/A**            |
| Adversarial review of executor's PRs       | **R/A** | I                  |
| Lane claim on `LIVE-LANES.md`              | I       | **R/A**            |
| Product/taste calls, S8 tour               | I       | I — **Nitro is A** |
| Licence decisions (charting, any new dep)  | **R**   | I — **Nitro is A** |

One rule that matters more than the table: **Executor executes, planner verifies. The agent that wrote a thing does not certify it.**

### 4.4 · PR shape

- **One pass per PR.** PR-1 = boot. PR-2 = harness. They do not merge as one.
- **Branch:** `feat/uiproof-boot`, `feat/uiproof-harness`. Worktree via `pnpm wt <branch>` — never the main checkout.
- **Body must contain:** the `PROOF.md` table verbatim (PR-2 onward), what was _not_ covered and why, and the `pnpm verify` result as printed.
- **Screenshots** attached to the PR, not committed. `.artifacts/` is gitignored.
- **Never** `git add .` — files individually.
- No commit until Nitro asks.

### 4.5 · Anti-collision with Stream B (the spine)

| Boundary                          | Rule                                                                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paths Stream A may touch          | `vendor/*/05_Web_Front/**`, `tooling/uiproof/**`, `docs/STREAM-A-*`, `docs/FRONTEND-*`                                                                                        |
| Paths Stream A must **not** touch | `services/**`, `packages/**`, `apps/**`, `tooling/ci/**`, `Dockerfile`, `docker-compose*.yml`, any migration                                                                  |
| The one shared file               | root `package.json` — PR-1 adds **two scripts and one devDependency**, nothing else. Smallest possible shared-file diff, in the _first_ PR, so later PRs touch nothing shared |
| Ports                             | Stream A owns `:8090` only. `:3000/:3100/:4000/:4014` and `55xx/56xx` belong to other stacks (`RUNNING.md`) — the harness never boots them                                    |
| Board                             | Claim `stream-a-uiproof` on `docs/LIVE-LANES.md` **before** the first edit                                                                                                    |
| Backends                          | The harness must **never** require the Java stack or the platform fleet. Backends-down is the fixture (§0)                                                                    |

---

## 5 · GO packet — Executor executes this next

Two PRs. Nothing beyond them without coming back.

### Preconditions

```
pnpm wt feat/uiproof-boot          # never the main checkout
```

Then claim `stream-a-uiproof` on `docs/LIVE-LANES.md`. Base off `origin/main` @ `5d742c6` or later — local main was behind by ~40 commits when this was written.

---

### PR-1 — `feat/uiproof-boot`

**Files created**

- `tooling/uiproof/boot.mjs`
- `docs/RUNNING-STREAM-A.md`

**Files modified**

- `package.json` — add `"ui:boot": "node tooling/uiproof/boot.mjs"` to `scripts`. **Nothing else in this PR.**
- `.gitignore` — add `.artifacts/`

**`boot.mjs` must implement all seven behaviours in §2.4.** Restated as requirements:

| #   | Requirement                                                                                         |
| --- | --------------------------------------------------------------------------------------------------- |
| 1   | Probe `http://127.0.0.1:${PORT}/` first; if 200, print `reusing existing server (pid N)` and exit 0 |
| 2   | Spawn detached + `unref()`, stdio to `.artifacts/uiproof/devserver.log`. **Never** await the child  |
| 3   | cwd = `git rev-parse --show-toplevel` + `/vendor/*/05_Web_Front`                                    |
| 4   | If that dir has no `node_modules`, exit 1 printing the exact `npm ci` command and its directory     |
| 5   | Ready = `GET /` 200 **AND** `GET /app.js` 200. Poll every 2 s                                       |
| 6   | Timeout 240 s → exit 1 + last 40 lines of the log                                                   |
| 7   | Write `.artifacts/uiproof/devserver.pid`. `PORT` defaults to 8090, overridable by env               |

**Acceptance tests — executor runs these and pastes the output**

| #   | Test                                                      | Expected                                                                                       |
| --- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A1  | `pnpm ui:boot` in a fresh worktree with no `node_modules` | Exit **1**, message names the directory and `npm ci`                                           |
| A2  | After `npm ci` in that directory, `pnpm ui:boot`          | Exit **0** within 240 s; `curl -o /dev/null -w '%{http_code}' localhost:8090/app.js` → **200** |
| A3  | `pnpm ui:boot` again immediately                          | Exit **0** in **under 3 s**, prints `reusing`                                                  |
| A4  | `time pnpm ui:boot`                                       | Command **returns** — proves nothing hangs (this is the §1.5 regression test)                  |
| A5  | `PORT=8091 pnpm ui:boot`                                  | Boots on 8091, does not disturb 8090                                                           |
| A6  | `pnpm verify`                                             | Unchanged from before the PR — paste what it printed                                           |

**PR body:** the six results above, verbatim.

---

### PR-2 — `feat/uiproof-harness` (only after PR-1 merges)

**Files created**

- `tooling/uiproof/matrix.mjs` — routes × viewports from §2.6
- `tooling/uiproof/playwright.config.mjs` — chromium only; `webServer` **not** used (boot.mjs owns boot); `outputDir` → `.artifacts/uiproof/`
- `tooling/uiproof/proof.spec.mjs` — the five assertions from §2.5
- `tooling/uiproof/report.mjs` — writes `.artifacts/uiproof/PROOF.md`

**Files modified**

- `package.json` — add `@playwright/test` to root `devDependencies`; add `"ui:proof"` script

**Acceptance tests — executor runs these and pastes the output**

| #   | Test                                                                                                    | Expected                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| B1  | `pnpm ui:proof` from clean                                                                              | Exit **0**; every `PROOF.md` row PASS                                                          |
| B2  | `ls .artifacts/uiproof/*.png`                                                                           | Exactly **10** files (5 routes × 2 viewports)                                                  |
| B3  | `/uc/account` result                                                                                    | Asserts redirect to `/login` — **not** the account UI (§2.6)                                   |
| B4  | **Negative control:** temporarily add `throw new Error('uiproof canary')` to a mounted component, rerun | Exit **non-zero**, that route FAILS. Revert. **A gate that has never gone red is not a gate.** |
| B5  | Run with the platform fleet **down**                                                                    | Still exit 0 — network errors allowlisted, non-network errors not (§2.5)                       |
| B6  | `pnpm verify`                                                                                           | Unchanged — paste what it printed                                                              |

**PR body:** the `PROOF.md` table verbatim, plus B4's red output as proof the gate works.

---

### Explicitly out of scope for the GO packet

Auth fixture (Pass 3) · visual baselines (Pass 4) · anything touching prices or #109 (Pass 5) · axe-core (Phase 1.5) · charts · deleting the Nightwatch scaffolding · any `services/**` file.

**Stop after PR-2 and report.** The next pass is chosen from what PR-2's artefacts actually show, not from this document.
