# System inventory — baseline `a19e337` + fix branch

**Claim tag:** `[VERIFIED 2026-07-29]`

## Services (15)

| System        | Port (compose) | Edge route                | Role (plain)                                       |
| ------------- | -------------- | ------------------------- | -------------------------------------------------- |
| svc-edge      | 4000           | (is the door)             | Auth front door; signs principal; proxies `/api/*` |
| svc-ledger    | 4001           | none (S2S)                | Only books / balances                              |
| svc-identity  | 4002           | `/api/identity`           | Accounts, login, rank, KYC                         |
| svc-token     | 4003           | `/api/token`              | IFC stake / yield / fees                           |
| svc-trade     | 4004           | `/api/trade`              | Spot orders, holds, fills                          |
| svc-matching  | 4005           | none (S2S + public depth) | Order book engine                                  |
| svc-pay       | 4006           | `/api/pay`                | Merchant pay + user deposit/withdraw               |
| svc-p2p       | 4007           | `/api/p2p`                | Offers, escrow, disputes                           |
| svc-agents    | 4008           | `/api/agents`             | Model gateway / metering                           |
| svc-bank      | 4009           | `/api/bank`               | Spaces, transfers, earn                            |
| svc-dex       | 4010           | `/api/dex`                | Protocol plane quote front door                    |
| svc-blueprint | 4011           | `/api/blueprint`          | Onboarding / crew                                  |
| svc-protocol  | 4012           | `/api/protocol`           | Smart accounts / session keys                      |
| svc-indexer   | 4013           | none yet                  | Chain → Postgres read models                       |
| svc-ws        | 4014           | none (direct browser)     | Live depth stream                                  |

## Apps

| App        | Port | Role                    |
| ---------- | ---- | ----------------------- |
| apps/web   | 3000 | Terminal + plane switch |
| apps/admin | 3100 | Operator console        |

## Shared packages

auth · config · contracts · db · events · exchange-contract · i18n · ledger-client · market-data · ui · venue-adapter

## Vendor (quarantined)

| Path                                   | Role                                                |
| -------------------------------------- | --------------------------------------------------- |
| `vendor/upstream-exchange/`            | Third-party full exchange stack (reference only)    |
| `vendor/upstream-exchange-compose.yml` | Isolated infra for vendor — not the product compose |

**Safe default:** reference/quarantine — not product money path; brand/format excluded.
