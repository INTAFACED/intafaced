# Stream A executor handoff — 2026-07-30 (closeout of GO packet chat)

**For the next agent chat.** Nitro is non-technical; do not ask him to open localhost or run git.

## Already on `main` (do not re-do)

| Item                                                            | Evidence                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Operating plan + Grok audit                                     | #138                                                                        |
| PR-1 `boot.mjs` + `RUNNING-STREAM-A.md` + `ui:boot`             | **#169 merged** `e8c1ffa`                                                   |
| PR-2 Playwright harness + `STREAM-A-DESIGN-BAR.md` + `ui:proof` | **#172 merged** `d3874a5`                                                   |
| Boot acceptance A1–A6                                           | Green in executor session (Node 18, two-stage readiness, reuse, multi-port) |
| Local `pnpm verify` on harness                                  | Green at ship time                                                          |

## Still open (this is the real remaining work)

1. **`PROOF.md` green (B1–B5)** — **unverified**
   - Chromium **SEGV_ACCERR** in Grok agent sandbox (system Chrome headless same).
   - Harness code is on main; browser cannot launch _in that sandbox_.
   - **Fix:** run outside sandbox (normal Terminal / desktop agent app with full OS perms):

```bash
cd /Users/Nitro/projects/Sovereign/.worktrees/feat-uiproof-proof-green
# worktree already has: Node 18, shell node_modules, Playwright browsers, monorepo install
export PATH="/Users/Nitro/projects/Sovereign/.tools/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$(pwd)/.tools/ms-playwright"
export PORT=8094   # already booted if still up; else pnpm ui:boot
pnpm ui:proof
# then B4 canary: throw in a mounted component → expect FAIL → revert
```

2. **Auth fixture (Pass 3)** — `/uc/*` empty vs error still **unproven** by design until session fixture.
3. **Prices (Pass 5)** — blocked on #109; never fake.
4. **Polish** — only after PROOF green; score against `docs/STREAM-A-DESIGN-BAR.md`.
5. **Shell `package-lock.json` out of sync** — `npm ci` fails (`browserslist` lock mismatch). Working install used:

```bash
cd vendor/*/05_Web_Front
PATH="$(git rev-parse --show-toplevel)/.tools/node18/bin:$PATH" \
  npm install --no-save --no-package-lock --legacy-peer-deps --engine-strict=false
# chromedriver postinstall fails on arm64 Mac — ignore if webpack-dev-server + vue exist
```

6. **GitHub CI** — many main/PR runs red in ~3s with empty steps (infra flake); treat **local `pnpm verify` + PROOF** as signal until CI is healthy.

## Ready worktree (reuse; do not recreate cold if possible)

| Path                                  | Contents                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `.worktrees/feat-uiproof-proof-green` | branch `feat/uiproof-proof-green` @ recent main; `.tools/node18`; `.tools/ms-playwright`; shell `node_modules`; root `pnpm install` done |
| Port **8094**                         | Was booted successfully (`/` + `/app.js` 200) during closeout — probe before respawn                                                     |

## RACI reminder

- Grok/executor: green PROOF, canary, next passes.
- Planner/auditor: score #169/#172 method + design bar; do not re-implement boot.
- Nitro: product/taste only — never test runner.

## Definition of done for “soundproof UI method”

- [ ] `pnpm ui:proof` exit 0
- [ ] `.artifacts/uiproof/PROOF.md` all PASS + 10 PNGs
- [ ] B4 canary went red then reverted
- [ ] Auth + prices still marked unproven until their passes

Until the first three boxes, the **method is shipped; the product is not certified.**
