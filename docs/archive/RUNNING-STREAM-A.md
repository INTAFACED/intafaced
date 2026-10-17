# Running Stream A (exchange shell on :8090)

This is the **vendored Vue 2 / iView shell** at `vendor/*/05_Web_Front`.  
It is **not** `apps/web`. Agents boot and prove it; Nitro is never the test runner.

Law: [`FRONTEND-OPERATING-PLAN-2026-07-30.md`](FRONTEND-OPERATING-PLAN-2026-07-30.md).

---

## One command (preferred)

From a **worktree** (never the main checkout):

```bash
pnpm ui:boot
```

What it does:

1. If something already answers on `http://127.0.0.1:8090/`, **reuses it** and exits 0.
2. Otherwise spawns `npm run dev` in the shell **detached** (does not hang the agent).
3. Waits until **both** `GET /` and `GET /app.js` return 200 (webpack can serve HTML before the bundle is ready).
4. Writes log + pid under `.artifacts/uiproof/`.

Override port:

```bash
PORT=8091 pnpm ui:boot
```

---

## First time in a worktree

### Node 18 for the shell (required)

The shell is **webpack 3 / 2018**. It dies on Node 20+ (`No such module: http_parser`).  
The monorepo may use a newer Node; Stream A boots with a **local Node 18**:

```bash
mkdir -p .tools && cd .tools
curl -fsSL https://nodejs.org/dist/v18.20.5/node-v18.20.5-darwin-arm64.tar.gz | tar -xz
mv node-v18.20.5-darwin-arm64 node18
# boot.mjs looks for .tools/node18/bin/node automatically
# or: export STREAM_A_NODE="$PWD/node18/bin/node"
```

`.tools/` is gitignored. One install per machine/worktree.

### Shell dependencies

The shell keeps its own `node_modules` (webpack 3 / npm, not the monorepo pnpm tree).

If `pnpm ui:boot` exits 1 saying `node_modules missing`, run the command it prints:

```bash
cd vendor/*/05_Web_Front
PATH="$(git rev-parse --show-toplevel)/.tools/node18/bin:$PATH" npm ci
pnpm ui:boot
```

`npm ci` can take several minutes on a cold tree. That is a deliberate visible step — the boot script will not install for you.

---

## Proof (after PR-2)

One-time browser install (Chromium only):

```bash
export PLAYWRIGHT_BROWSERS_PATH="$(pwd)/.tools/ms-playwright"
pnpm exec playwright install chromium
```

Then:

```bash
pnpm ui:proof
# or: PORT=8090 pnpm ui:proof
```

Produces `.artifacts/uiproof/PROOF.md` and 10 screenshots under `.artifacts/uiproof/shots/`.  
That file is the definition of “the UI works,” not a human opening localhost.

**Pass 3 (auth + empty vs error):**

```bash
# Real Terminal preferred (agent sandboxes often SEGV Chromium)
pnpm ui:proof:pass3
# or: bash tooling/uiproof/run-pass3.sh
```

Produces `.artifacts/uiproof/pass3-status.txt` (`PASS3_GREEN`) and shots under `shots-auth/`.

**Agents:** never run the proof with a foreground long-lived server. `ui:proof` calls `ui:boot` (detached) first. If Chromium SEGV/EPERM in a sandboxed agent, re-run in a normal Terminal on the same machine — the harness is fine; the sandbox is not.

### Performance budget (known debt)

| Artefact                         | Note                                                        |
| -------------------------------- | ----------------------------------------------------------- |
| `app.js` ~12 MB (webpack 3 cold) | Known; no new heavy deps without a budget note              |
| First usable paint               | Boot readiness is `/` + `/app.js` 200 — not FCP metrics yet |

---

## Rules agents must not break

| Rule                                                                 | Why                                                      |
| -------------------------------------------------------------------- | -------------------------------------------------------- |
| Never `npm run dev` in the **foreground** of a chat turn             | Freezes the session (see `STREAM-A-UNSTICK-CONTINUE.md`) |
| Never claim visual “done” without `PROOF.md` (or say **unverified**) | Unfalsifiable glances are forbidden                      |
| Backends-down is a valid fixture for Phase 1                         | Honesty bar / empty states are the product               |
| Do not invent prices                                                 | S2 waits on market seed #109                             |
| Auth empty-vs-error needs Pass 3 fixture (`ui:proof:auth`)           | Unauthenticated `/uc/*` only proves the login gate       |

---

## Ports

| Port                      | Owner                                                  |
| ------------------------- | ------------------------------------------------------ |
| **8090**                  | Stream A shell (this doc)                              |
| 8080                      | webpack default if `PORT` unset — do not use for proof |
| 3000 / 3100 / 4000 / 4014 | Platform apps / edge / ws — not Stream A               |

---

## Manual fallback (humans only, not the gate)

```bash
cd vendor/*/05_Web_Front
PORT=8090 npm run dev
# open http://127.0.0.1:8090/ — elective taste only, never certification
```
