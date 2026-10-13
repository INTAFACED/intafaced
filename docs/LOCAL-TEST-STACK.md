# Local test stack

One command starts a private copy of the INTAFACED backend and the Customer app on your Mac, without Docker. Everything binds to `127.0.0.1`. Balances in it are **test funds, not real money**; the Customer shows a fixed banner saying so.

## Commands

| Command                                              | What it does                                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm local:stack`                                   | Start (safe to re-run) and print a health table. First run builds and sets up the database; allow a few minutes. `--rebuild` forces a rebuild. |
| `pnpm local:stack:stop`                              | Stop only the processes this script started (checked by pid file and command line), then Postgres. Data is kept.                               |
| `pnpm local:fund <email-or-userId> <ASSET> <amount>` | Credit test funds, e.g. `pnpm local:fund me@example.com USDT 1000`. Decimal strings only.                                                      |
| `node tooling/scripts/local-test-stack.mjs status`   | Health table only.                                                                                                                             |
| `pnpm local:stack:plan`                              | Read-only: every service, port, database schema and where Edge sends each route. Changes nothing (`--json` for a machine-readable copy).       |
| `pnpm local:stack --only token,p2p`                  | Start only the named services (plus Postgres and NATS). Anything already running is left alone.                                                |
| `pnpm local:stack:restart edge`                      | Stop the named services, then start whatever is not running. Use after Edge's wiring changes; other services and their data stay up.           |

Open **http://127.0.0.1:3210**. (`localhost:3210` redirects there; Edge only allows that one origin.)

## Ports

Postgres 15460 · NATS 14232 (monitor 18232) · Edge 14500 · Ledger 14501 · Identity 14502 · Token 14503 · Trade 14504 · Matching 14505 · Pay 14506 · Agents 14507 · P2P 14508 · Bank 14509 · Notify 14510 · Academy 14511 · Support 14512 · Market 14513 · Blueprint 14514 · Quant 14515 · Execution 14516 · Customer 3210. Ports 3200, 3401, 3162, 3340, 5432, 15440 and 15444 are not used.

State lives in `~/.intafaced/local-test-stack/` (data, logs, `secrets.json` mode 600, `LOCAL-TEST-STACK.json` marker). Delete that folder to start from nothing. Requires PostgreSQL 16 at `/opt/homebrew/bin` and at least 14 GB free disk.

## Real vs test

Real: the code. Identity, Ledger, Trade, Matching, Pay, Bank and Edge are the repository's own services, running their own migrations against a real Postgres and a real NATS JetStream. Funds move only through the ledger (`packages/ledger-client` recipes into `svc-ledger`); amounts are decimal strings on the wire.

Test: the money. `local:fund` posts a `deposit` recipe on rail `local-test` with reference `LOCAL-TEST-<timestamp>-<id>`, so every entry is labelled. It refuses unless the marker file exists and the database is `127.0.0.1` on the stack's port. No bank, card, chain or exchange feed is connected. Prices, bank cards, on-chain Pay, WebSocket (`/ws` returns 503) and loans' price marks are unavailable. Background money jobs in Bank (scheduled transfers, auto-invest, interest, loan accrual) are switched off.

Placeholders the services refuse to boot without (no owner-published value exists): reconcile cadence, rate limits, Pay checkout limits (from `.env.example`), Bank `LOAN_QUOTE_ASSET_ID=USDT` and batch sizes `1` (jobs off), Matching snapshot cadence `0` (off). They are local-test values, not product decisions. Edge's kill-state file is written once as an explicit all-on list; without it Edge halts every module.

## Every Customer door is reachable

Edge answers `502 Connection unavailable` for any route whose service is not running, so the stack starts all 17 backend services the Customer app calls: besides Ledger, Identity, Matching, Trade, Pay and Bank, also **Token** (Token room), **P2P**, **Academy**, **Support**, **Market**, **Notify** (Notifications), **Agents** (Navigator), **Blueprint**, **Quant** and **Execution** (Trade tools). Each is one Node process on `127.0.0.1`, gets the same secrets as the others (edge principal, internal service secret, screening pass-through) and its own Postgres schema and role (`svc_<name>`); Quant and Execution have no tables. `pnpm local:stack:test` fails if any route in `services/svc-edge/src/routes.ts`, or any module the Customer app calls, points at a service the stack does not start and is not listed (with a reason) in `EDGE_ABSENT` in the script.

"Reachable" means the door answers with the service's own responses. These parts stay **not connected** on purpose, because they need a real outside provider or an owner decision, and the service says so by name instead of inventing an answer:

| Door               | Not connected              | Why                                                                                                                                                                                 |
| ------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigator / Agents | Model provider             | `AGENTS_PROVIDER=upstream` aimed at a closed port; the service's built-in mock is not used. Metering is off, so no usage fee is charged.                                            |
| Blueprint          | Neural engine              | `BLUEPRINT_ENGINE_MODE=http` aimed at a closed port; the stub engine is not used. Card PNG renderer is unset.                                                                       |
| Academy            | Live classes, video        | No LiveKit and no video storage. Paper-trading market limit is owner-unpublished and unset.                                                                                         |
| P2P                | Fee, offer caps, deadlines | Owner-unpublished, so unset. Payment-instrument encryption has no provider locally.                                                                                                 |
| Notifications      | Email, push, SMS           | No gateway; the in-app inbox works.                                                                                                                                                 |
| Market             | House commission           | Owner-unpublished, unset.                                                                                                                                                           |
| Quant              | Data lake, venue vault     | Not connected.                                                                                                                                                                      |
| Execution          | Outside venues             | `EXECUTION_VENUE_IDS` is empty, so nothing can route off-platform.                                                                                                                  |
| Token              | Emissions, yield, buyback  | Background jobs off, like Bank's.                                                                                                                                                   |
| Mining             | The whole service          | Not started: `svc-mining-pool` listens on `0.0.0.0` in its code, which breaks the loopback-only rule. The Mining room is a static "unavailable" page; its health probe answers 502. |

Not started because the Customer app never calls them: Protocol, DEX, Indexer, Tax, Ops (operator back-office) and the data-lake door.

## Screening

Edge refuses **every** `/api/*` call, including sign-up and sign-in, with `edge.screening_unset` (HTTP 503) until a sanctions screening list is set. This script never sets or invents one. It passes `INTAFACED_SANCTIONS_REGIONS` and `INTAFACED_SANCTIONS_LIST_SOURCE` to Edge from the shell environment, or else from the machine-local file `~/.intafaced/local-test-stack/screening.local.json` (`{"regions": "...", "source": "..."}`), which is never committed. Without either, it prints a warning and every call returns 503. See `services/svc-edge/src/geo-block.ts` and `packages/config/src/screening.ts`.

On Nitro's Mac (approved by Nitro, 13 Oct 2026) that file holds a labelled local test fixture. It is not counsel's list and must never be copied to staging or production. Commas separate entries, so keep any explanation in `source`, not in `regions`.

## Living test market (prices, book, fills)

`pnpm local:market` / `pnpm local:market:stop` / `node tooling/scripts/local-test-market.mjs status`. It makes Trade look alive on this stack only: a labelled test account `test_market_maker` keeps a ladder of post-only bids and asks around a deterministic synthetic **TEST PRICE** (BTC/ETH vs USDT and USDC, IFC/USDT; `--markets all` adds commodities; `--seed N`, `--interval S`, `--levels N`), and a second account `test_taker` occasionally crosses the best level so recent trades and candles exist. Log: `~/.intafaced/local-test-stack/logs/market.log`. Credentials of the two test accounts: `~/.intafaced/local-test-stack/market-accounts.json` (mode 600).

Real vs test: orders go through Edge `/api/v1` into svc-trade and svc-matching, and the accounts are funded by `local:fund` (svc-ledger deposits, rail refs `LOCAL-TEST-MM-...`). Nothing writes a balance, fill or price into a database. Ticker, order book, trades and candles on the Customer are derived by svc-trade from the book and the fill tape (`services/svc-trade/src/public-rest.ts`), so there is no separate price feed to drive. Prices are invented starting points, not a feed.

Containment: it refuses unless the state directory and `LOCAL-TEST-STACK.json` exist and every target URL is `http://127.0.0.1:<a port the marker lists>`. Test: `pnpm local:market:test`.

Preflight: on this stack three gates stop every order, and the script reads them (GET only) and refuses with their names instead of sending failing orders: (1) Edge refuses new orders because svc-matching `/health` carries no halt flag (`edge.venue_halt_unavailable`); (2) no market-lifecycle publication exists, so svc-trade refuses every order (`trade.lifecycle_authority_unavailable`); (3) svc-matching holds no book until a first order, and svc-trade will not admit that first order (`trade.matching_market_missing`). Until these are resolved the script prints them and exits. In the Customer the market picker lists every active market but opens on the first one alphabetically (AUD/USD, which is also not orderable), which is why only AUD/USD appears to show.

## Living test world (local only)

`pnpm local:world` watches for new accounts every 5 s and gives each one labelled test funds (10,000 USDT, 0.25 BTC, 2 ETH; edit `WELCOME_AMOUNTS` in `tooling/scripts/local-test-world.mjs`) through the real ledger, using the `local:fund` recipe with ref `LOCAL-TEST-welcome-<userId>-<ASSET>`, so a repeat is a no-op. `pnpm local:world:seed` creates the test counterparty `test_friend` (credentials in `~/.intafaced/local-test-stack/world-accounts.json`, mode 600) and has it send the newest real user 3 small transfers; the watcher also sends back what anyone pays `test_friend`. It refuses unless `LOCAL-TEST-STACK.json` exists and every target is 127.0.0.1. Log: `logs/world.log`.

Limits: Bank transfers have no memo field, so labels like "Lunch (test)" appear only in the log. The recipient needs a primary space for the asset (`bank.dest_user_missing`). Bank refuses every call while the screening list is a test fixture under fail-closed screening.
