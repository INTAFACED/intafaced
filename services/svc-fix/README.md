# svc-fix

**FIX gateway adapter. QuickFIX/J 3.0.2 dictionary and session only. Not a book, not a ledger.** It accepts FIX sessions, adapts a supported `NewOrderSingle` into a matching order command, and posts that command to svc-matching. It holds no balance and no order book: value and fills stay in svc-ledger and svc-matching.

## What it does

- `src/command.ts`: the adapted order command and its refusals (unsupported BeginString, message type, tag, side or order type; missing ClOrdID, quantity or price; bad decimal).
- `src/matching-port.ts`: the HTTP port to svc-matching. An unmapped CompID or a missing time-in-force refuses before any POST. It returns the named matching ack only; it never invents fills, last price or account.
- `src/developer-contract.ts`: the developer-facing contract for FIX integrators.
- `src/main/java/io/intafaced/fix`: the QuickFIX/J acceptor, adapter and drop-copy code. `scripts/run-mvn.mjs` and `scripts/ensure-toolchain.mjs` set up the JDK and Maven it needs.

## Settings

- `FIX_COMPID_ACCOUNT_JSON`: maps a FIX CompID to an account. Blank means every order refuses with `matching_account_unmapped`.
- `INTERNAL_SERVICE_SECRET` (at least 32 characters) signs the call to svc-matching as service `svc-fix`. Blank refuses with `matching_service_auth_unconfigured`, except in keypair mode.
- `S2S_AUTH_MODE`, `S2S_KEYRING`, `S2S_SIGNING_KID` and `S2S_SIGNING_KEY` select service-key signing. `dual` sends the key signature and the shared secret; `keypair` sends the key signature only. A mode without its signing key refuses rather than posting an unsigned order.
- `MATCHING_BASE_URL` is the svc-matching host; blank refuses with `matching_unconfigured`.

Ports and the full settings list: the generated `docs/SERVICES.md`.

## Run and test

- `pnpm --filter @intafaced/svc-fix test` runs Maven tests, then vitest.
- `pnpm --filter @intafaced/svc-fix start` starts the acceptor; `pnpm --filter @intafaced/svc-fix adapt` starts the adapter.

Money and security package: a red test here blocks merge even when `main` shares it (see root `AGENTS.md`).
