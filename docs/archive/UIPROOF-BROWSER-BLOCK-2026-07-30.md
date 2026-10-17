# uiproof status — 2026-07-30

## B1–B5 — GREEN (outside-sandbox session)

| Gate                        | Result                                                                          |
| --------------------------- | ------------------------------------------------------------------------------- |
| B1 `ui:proof`               | **PASS** — PROOF.md Overall PASS                                                |
| B2 screenshots              | **10/10** under `.artifacts/uiproof/shots/`                                     |
| B3 `/uc/account` login gate | **PASS**                                                                        |
| B4 canary                   | **PASS** — red then revert then re-green (`b1b5-status.txt`: `ALL_GREEN B1-B5`) |
| B5 fleet down               | **PASS** (backends down during run)                                             |

Artefacts: `.artifacts/uiproof/PROOF.md`, `b1b5-run.log`, `b1b5-status.txt`.

Harness fixes that unlocked green (this branch): broader network allowlist, Vue 2 mount detection, `/uc` HTML SPA bypass, `Account.vue` `v-else` typo, Chromium `--no-sandbox` args.

## Pass 3 — **PASS3_GREEN** (Nitro Terminal 2026-07-30)

3/3 auth tests + 3 shots under `.artifacts/uiproof/shots-auth/`.

## Pass 3 was (historical)

code on branch; live was pending

- `tooling/uiproof/auth-fixture.mjs` + `auth.spec.mjs`
- `pnpm ui:proof:auth`
- Grok agent sandbox still **SEGV** on Chromium; run auth proof via same unsandboxed host that greened B1–B5:

```bash
cd /Users/Nitro/projects/Sovereign/.worktrees/feat-uiproof-proof-green
pnpm ui:proof:auth
```

## Serial rules

Phase 2 polish only after Pass 3 live green. No fake prices (#109).
