# Owner / ops checklist — 2026-07-31

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

These items are **human-only** or **Denon multi-week mountains**. An agent cannot close them by inventing product or paying bills. This file is the honest split.

## 1. GitHub Actions billing (human)

**Symptom:** workflow runs fail in a few seconds with empty `steps: []` when the org spending limit / billing plan blocks Actions.

**Owner action:**

1. GitHub org → **Billing & plans** → raise Actions spending limit (or enable billing).
2. Re-run a PR workflow and confirm jobs actually execute (gates / build / test / dod).
3. Until then: treat local `pnpm verify` + Postgres compose as the proof; do **not** claim Actions green without a run URL.

**Repo already does:** `.github/workflows/ci.yml` with `paths-ignore` for docs; local verify path in CONTRIBUTING.

## 2. Postgres money e2e (local + CI)

**Local:**

```bash
cp .env.example .env
docker compose up -d
REQUIRE_POSTGRES=1 pnpm test
```

Suites that skip without Postgres include ledger, trade money path, pay, bank, p2p, identity, etc. (`packages/db` `postgresAvailable()`).

**Owner:** keep compose Postgres healthy on developer machines; once Actions billing works, CI already starts Postgres/Redis/NATS/anvil for the test job.

## 3. Licences / counsel (legal — not code)

See `docs/LICENCE-POSITION.md` and `docs/OWNER-DECISIONS-OPEN.md`.

| Item                                         | Owner / counsel                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| Root product licence text                    | Decide and add (NOTICE is inventory only)                                     |
| Sanctions / geo lists                        | Counsel supplies list + `INTAFACED_SANCTIONS_LIST_SOURCE`                     |
| TradingView Advanced Charts (if ever wanted) | Purchase / licence — terminal uses honest SVG candles + Apache-friendly stack |
| Undetermined vendor jars                     | Counsel / cleanup track in PROPER-CLEANUP                                     |

Agents keep screening **mechanism** fail-closed; they must not invent list content.

## 4. Wallet secrets perimeter (ops)

See `docs/A1.4-WALLET-SECRETS-PERIMETER-2026-07-30.md` and `docs/RUNBOOK-ETH-KEYSTORE-REENCRYPTION.md`.

| Agent-runnable                                   | Owner-only                                           |
| ------------------------------------------------ | ---------------------------------------------------- |
| `pnpm scan:secrets` / `pnpm scan:custody`        | Rotate any disclosed credentials                     |
| Env placeholders, no Protocol Plane private keys | Host binding, kill weak defaults                     |
| Refuse wallet keys in TS plane                   | Keystore re-encryption for legacy ETH keys           |
| Pay `PAY_CRYPTO_*` hot keys stay out of git      | Hold production hot-wallet material outside the repo |

## 5. Claimable trade mountains (Denon — do not invent)

Tracker 🟢 means **unblocked to start**, not “small PR”:

| Feature         | Reality                                                          |
| --------------- | ---------------------------------------------------------------- |
| `trade.futures` | Multi-week: margin, mark, funding, liquidation ladder, insurance |
| `trade.otc`     | Desk + stake gate + RFQ; convert is the pattern, not a drop-in   |
| `trade.algo`    | TWAP/VWAP/POV scheduler — greenfield                             |
| `trade.copy`    | Leader fan-out + profit-share — greenfield                       |

**Shipped adjacent (this wave):** terminal charts + equity wiring; AMM Solidity compile unblocked; private positions WS (separate PR #227).

## 6. Protocol smart accounts → `done`

Code + anvil proofs exist; still blocked for honest `done` by: production chain decision, bundler/EntryPoint, passkey verifier (`socket.p256-verifier`), external audit (`socket.contract-audit`). Keep refusing mainnet value until audit.

AMM compile fix unlocks **starting** `protocol.lending` / `protocol.router` / meme-factory — it does not implement them.
