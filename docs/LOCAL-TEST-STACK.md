# Local test stack

One command starts a private copy of the INTAFACED backend and the Customer app on your Mac, without Docker. Everything binds to `127.0.0.1`. Balances in it are **test funds, not real money**; the Customer shows a fixed banner saying so.

## Commands

| Command                                              | What it does                                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm local:stack`                                   | Start (safe to re-run) and print a health table. First run builds and sets up the database; allow a few minutes. `--rebuild` forces a rebuild. |
| `pnpm local:stack:stop`                              | Stop only the processes this script started (checked by pid file and command line), then Postgres. Data is kept.                               |
| `pnpm local:fund <email-or-userId> <ASSET> <amount>` | Credit test funds, e.g. `pnpm local:fund me@example.com USDT 1000`. Decimal strings only.                                                      |
| `node tooling/scripts/local-test-stack.mjs status`   | Health table only.                                                                                                                             |

Open **http://127.0.0.1:3210**. (`localhost:3210` redirects there; Edge only allows that one origin.)

## Ports

Postgres 15460 · NATS 14232 (monitor 18232) · Edge 14500 · Ledger 14501 · Identity 14502 · Trade 14504 · Matching 14505 · Pay 14506 · Bank 14509 · Customer 3210. Ports 3200, 3401, 3162, 3340, 5432, 15440 and 15444 are not used.

State lives in `~/.intafaced/local-test-stack/` (data, logs, `secrets.json` mode 600, `LOCAL-TEST-STACK.json` marker). Delete that folder to start from nothing. Requires PostgreSQL 16 at `/opt/homebrew/bin` and at least 14 GB free disk.

## Real vs test

Real: the code. Identity, Ledger, Trade, Matching, Pay, Bank and Edge are the repository's own services, running their own migrations against a real Postgres and a real NATS JetStream. Funds move only through the ledger (`packages/ledger-client` recipes into `svc-ledger`); amounts are decimal strings on the wire.

Test: the money. `local:fund` posts a `deposit` recipe on rail `local-test` with reference `LOCAL-TEST-<timestamp>-<id>`, so every entry is labelled. It refuses unless the marker file exists and the database is `127.0.0.1` on the stack's port. No bank, card, chain or exchange feed is connected. Prices, bank cards, on-chain Pay, WebSocket (`/ws` returns 503) and loans' price marks are unavailable. Background money jobs in Bank (scheduled transfers, auto-invest, interest, loan accrual) are switched off.

Placeholders the services refuse to boot without (no owner-published value exists): reconcile cadence, rate limits, Pay checkout limits (from `.env.example`), Bank `LOAN_QUOTE_ASSET_ID=USDT` and batch sizes `1` (jobs off), Matching snapshot cadence `0` (off). They are local-test values, not product decisions. Edge's kill-state file is written once as an explicit all-on list; without it Edge halts every module.

## Screening

Edge refuses **every** `/api/*` call, including sign-up and sign-in, with `edge.screening_unset` (HTTP 503) until a sanctions screening list is set. This script never sets or invents one. It passes `INTAFACED_SANCTIONS_REGIONS` and `INTAFACED_SANCTIONS_LIST_SOURCE` to Edge from the shell environment, or else from the machine-local file `~/.intafaced/local-test-stack/screening.local.json` (`{"regions": "...", "source": "..."}`), which is never committed. Without either, it prints a warning and every call returns 503. See `services/svc-edge/src/geo-block.ts` and `packages/config/src/screening.ts`.

On Nitro's Mac (approved by Nitro, 13 Oct 2026) that file holds a labelled local test fixture. It is not counsel's list and must never be copied to staging or production. Commas separate entries, so keep any explanation in `source`, not in `regions`.
