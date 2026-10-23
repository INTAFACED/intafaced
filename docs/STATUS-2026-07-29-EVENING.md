# Status — 29 July, evening. Nitro has the wheel.

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

Denon is offline for 1–2 hours. **You have full access to the whole app** — the
territory split in `SPLIT-BOARD.md` is suspended. Build anywhere.

**Start here:** `docs/SPLIT-BOARD.md` §"WHERE THE APP ACTUALLY IS". The product
is the vendored exchange under `vendor/upstream-exchange/`, served at
**http://localhost:8090**. `apps/web` is not the product.

---

## What is on `main` right now

Merged this session, all gates green (`brand-scan`, `workspace-sync`,
`custody-scan`, `migration-check`):

1. **The shell is ours.** Chinese removed rather than defaulted — the locale file
   is deleted and the language hard-wired, so no stored preference can bring it
   back. Black and orange throughout, vendor logos gone. TradingView terminal
   given the full working surface: drawing tools, indicators, resolutions, the
   timeframe bar, OHLC legend.
2. **A privilege escalation is closed.** `apiKeys.create` accepted a scope array
   from the request body verbatim. Any logged-in account could mint a key with
   `admin:compliance`, self-approve its KYC to `institutional`, and clear the
   tier gate on every custodial module.
3. **The wallet RPC is no longer open.** All 13 services exposed
   `GET /rpc/withdraw?address=X&amount=Y` with **no auth infrastructure anywhere
   in `01_wallet_rpc`** — a grep of the whole tree returned zero files. Anyone
   who could reach the port drained the hot wallet.
4. **A live trading backdoor is gone.** `987654321asdf` was not a test fixture:
   `exchange-api`'s config listed those endpoints in `excludePathPatterns` so the
   auth interceptor never saw them. It reached order placement as `uid 1`,
   crediting an arbitrary member's wallet, and rewriting a pair's price limits.
   Also removed: a `GET` that ran `TRUNCATE TABLE member_wallet_*`.
5. **Bank and blueprint are no longer 403 for everyone**, and the three refusal
   reasons — missing scope, insufficient tier, blocked region — are now
   distinguishable, so the UI can say something true.
6. **`NOTICE` and `docs/LICENCE-POSITION.md`** — 43 components inventoried from
   the artefacts themselves. Two genuine blockers, below.
7. **Deployment gates widened.** `workspace-sync` now checks every service's
   upstream URLs, not just the edge's — it immediately caught `svc-dex` calling
   `svc-matching` on `svc-trade`'s port, which was reaching a live service that
   answers a different API rather than failing cleanly.

---

## Two decisions waiting for Denon — do not guess

**1. The chart.** The vendored TradingView Charting Library 1.11 carries **no
licence, NOTICE, EULA or copyright anywhere across its 85 files**. Meanwhile
`docs/TERMINAL.md` already specifies **lightweight-charts (Apache-2.0)** for
exactly this job. So there are two coherent paths — apply to TradingView for a
grant and keep the terminal as built, or switch to lightweight-charts per our own
spec — and they lead to different work. Denon picks.

**2. `mysql-connector-java:8.0.11`** is GPL v2 with the FOSS exception, and a
proprietary product is not on that exception's list. MariaDB Connector/J is a
one-line swap, but it is a swap in the money path.

---

## Known red, so you do not chase it

- **`pnpm verify` fails on two `svc-pay` tests.** `user-money-service.test.ts`
  expects `pay.rail_failed` where the service raises "client reference already
  used". That is a real disagreement about withdrawal retry semantics — either
  the test encodes the wrong contract or the service does. It is a money path and
  it was left failing and visible rather than skipped. **Pre-existing, from #80.**
  Everything else in `verify` passes.
- The market prices are all `0`. Pairs are seeded and the datafeed works, but
  nothing has ever matched so there are no bars. An agent is on it.

---

## Sharp edges that cost hours today

- **Hot reload now works** (`poll: 1000`). It did not before — inotify does not
  cross the Windows bind mount, so every edit needed a 90-second
  `docker restart intafaced-shell-web`. If you find yourself restarting, don't.
- **Never point a test at the shared dev database.** `svc-trade`'s test applies
  every migration, so pointed at `intafaced` it applied an unmerged branch's
  schema and broke `main`'s tests from another checkout entirely. It now uses
  `intafaced_test`. Neither `git bisect` nor a clean checkout can find a cause
  that lives in shared mutable state.
- **Do not run PowerShell `Get-Content`/`Set-Content` over `.vue` files.** 5.1
  reads UTF-8 as ANSI without a BOM and writes the mojibake back.
- **Port 8080 is Apache** on this machine. Docker will bind it on IPv6 only while
  the browser reaches Apache on IPv4 — which looks exactly like the app serving
  the wrong page.
- **A service that builds a router and never mounts it** answers 200 on `/health`
  and 404 on everything else. That has now happened three times here.
  `workspace-sync` check 6 catches it; run it before you believe a service works.

---

## Live security items, not yet fixed

- **CORS is wildcard-with-credentials in all seven Java web modules.** Under
  Spring 4.3 that reflects the request origin when credentials are allowed, so
  **any website can make authenticated cross-origin requests using a logged-in
  user's session.** Fixing it needs the list of legitimate origins — that is why
  it was not guessed at.
- **`MemberWalletDao.unfreezeMore()`** adds 500 units to every qualifying user's
  balance. No endpoint reaches it today. It is still a live method.
- **`WALLET_RPC_AUTH_TOKEN` has no default by design.** The wallet RPC services
  will refuse to start until it is set. None are running today.
- **Existing ETH deposit keystores were created with an empty password.** Once
  `ETH_KEYSTORE_PASSWORD` is set to a real value, those files will not decrypt.
  Re-encrypt or sweep them out first.
- **The sanctions blocklist is empty.** Screening works and screens nothing. This
  needs counsel before a public DEX — a compliance decision, not an engineering
  one.

---

## Agents still running

Market price history · svc-academy and svc-launch · DEX quote sourcing (per §27,
our own venue fabric — **not** the `ccxt` package, which the doctrine excludes
from the money path) · the DoD gate (e2e in CI, kill-switch, SLO panel).

Each is on its own `feat/spine-*` branch and will need rebasing onto this `main`.
None will open a PR.
