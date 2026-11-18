# Secret rotation readiness (tip)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker:** D26-P3-05 · **Class:** Ops runbook + gates. **Not** Class X live rotation.  
**Date:** 2026-08-15 · **Lane:** `denon-d26-p3-05-rotation`

This is the **tip runbook**: what must be rotatable, in what order, and which gates prove a disclosed value cannot be reused. It does **not** rotate anything. **No secret value appears here** — names, files, and gate ids only.

**Do not treat this page as a rotation.** Generating, pasting, or deploying a replacement credential is an owner action (Class X). Agents stop at readiness.

**Leverage (Phase A IN):** `.env.example` shapes + existing owner-actions + existing gates. Do not invent a second vault, a second money book, or a new product SPA.

This page holds what was still true in the two dated reports it replaced on 2026-11-18 (the 2026-07-30 wallet-secrets and perimeter audit, and the 2026-08-03 rotation inventory); both are in git history.

**Wallet disclosed-literal half (do not edit):** [`OWNER-ACTIONS-WALLET-RPC-SECRETS.md`](OWNER-ACTIONS-WALLET-RPC-SECRETS.md) — A1 first, A2 is a **different** account, A3/A3b/A4 constraints. Cite it; never duplicate its values.

---

## 0 · What this mountain is, and is not

| This mountain does                                                     | This mountain does not                                                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Name every rotatable class on the TypeScript fleet and wallet env keys | Rotate live secrets                                                                                  |
| Order rotations so value-moving keys go first                          | Paste literals, hashes of live keys, or “example” replacements into git                              |
| Point at gates that **refuse** a disclosed or unwired secret           | Start `01_wallet_rpc` against real value (A4)                                                        |
| Keep compose/schema parity as a rotation safety net                    | Edit `OWNER-ACTIONS-WALLET-RPC-SECRETS.md`, P3-02 threat docs, P3-10 incident runbook, or `svc-edge` |

---

## 1 · What must be rotatable (by class)

Shapes live in `.env.example` and `packages/config` / `services/*/src/env.ts`. Compose wiring is asserted by `compose-secret-parity` (see §3).

### 1.1 · Edge principal

| Env name                | Role                                                                                                                                                               | Rotate with                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `EDGE_PRINCIPAL_SECRET` | HMAC over the principal svc-edge forwards. Edge signs; mounting services verify. `z.string().min(32)`, **no schema default**. Compose `:?` refuses an unset stack. | **One** `.env` edit. Restart **all** consumers together (§1.6). Partial rotation → authenticated paths **401**. |

`.env.example` carries a `dev-only-*` placeholder so a clone boots locally. That placeholder is **not** a production value. A staging/prod host still running it is a disclosure — treat the five `dev-only-*` fleet placeholders (edge, internal, JWT, both `PAY_*` webhooks) as burned and rotate each as §2 says. Confirm off-repo; do not paste the placeholder into this file as if it were evidence.

### 1.2 · Ledger / internal service secrets

| Env name                  | Role                                                                                                                   | Rotate with                                                                                                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `INTERNAL_SERVICE_SECRET` | Shared secret on the internal money plane. svc-ledger verifies; callers send it. `z.string().min(32)`, **no default**. | One `.env` edit. Restart **all** callers + ledger together (§1.6). Partial rotation → `ledger.post` **401** while `/health` stays green. **Verify with a money path** (`pnpm order-path-smoke` or a small fill), not a health check. |
| `JWT_ACCESS_SECRET`       | Access-token HMAC. Identity mints; the other holders verify (§1.6). `z.string().min(32)`; optional in svc-ws.          | Every holder in §1.6 **together**. Every existing session dies; that is the design.                                                                                                                                                  |

`INTERNAL_SERVICE_BODY_BIND` is not a secret. If it is `require` anywhere, set it everywhere before blaming a rotation 401 on the secret. In production posture (`APP_ENV` anything but exactly `dev`/`test`) it must be exactly `require` on every process that holds `INTERNAL_SERVICE_SECRET`, or that process refuses to boot (`config.s2s_body_bind_not_required`).

### 1.3 · Notify gateway tokens

Optional **until** the matching URL is set. `svc-notify` `superRefine`: a gateway URL with no token is an open relay and **fatal at boot**.

| Env name                     | Pair with                  |
| ---------------------------- | -------------------------- |
| `NOTIFY_EMAIL_GATEWAY_TOKEN` | `NOTIFY_EMAIL_GATEWAY_URL` |
| `NOTIFY_PUSH_GATEWAY_TOKEN`  | `NOTIFY_PUSH_GATEWAY_URL`  |
| `NOTIFY_SMS_GATEWAY_TOKEN`   | `NOTIFY_SMS_GATEWAY_URL`   |

Rotate token and vendor console together. Blast radius is notify only. Do not put a live token in `.env.example`.

### 1.4 · Wallet env keys (vendored `01_wallet_rpc` + pay crypto rail)

**A4 still holds:** do not deploy `01_wallet_rpc` against real value until the owner security review. Rotate **because git history disclosed the old values**, not because the module is in the compose fleet.

| Env name                                                    | Role                                                                                                                                                                                                         | Proof the old disclosed value is refused                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ECT_WITHDRAW_WALLET_SECRET`                                | ECT withdrawal signing seed (`coin.withdraw-wallet`). **OWNER-ACTIONS A1 — do this first among wallet keys.** Not listed as a filled `.env.example` default; the module is not in `docker-compose.apps.yml`. | `EctWithdrawSecretConfig` refuses unset **and** refuses when SHA-256(env) matches the digest of the committed literal (digest in source, **not** the literal). See [`OWNER-ACTIONS-WALLET-RPC-SECRETS.md`](OWNER-ACTIONS-WALLET-RPC-SECRETS.md) A1 “Already done for you”. Width of that digest is also CI: `wallet-rpc-mainnet` rule **M11**. |
| Second ECT seed (A2)                                        | Different account in a deleted `main()`. **Rotating A1 does not cover A2.**                                                                                                                                  | Code path gone (`EctApi.main` deleted). No env var. Owner still sweeps the historical source account. Cite A2; do not recover the literal into git.                                                                                                                                                                                            |
| `WALLET_RPC_AUTH_TOKEN`                                     | Shared `/rpc/**` auth. Minimum 32 chars.                                                                                                                                                                     | `RpcSecurityConfig` + `wallet-rpc-auth` scan: a bootable module without the guard on its classpath fails CI. Unset or short token → service does not start.                                                                                                                                                                                    |
| `ETH_KEYSTORE_PASSWORD` / `ETH_WITHDRAW_WALLET_PASSWORD`    | ETH-family keystore passwords.                                                                                                                                                                               | Commented in `.env.example` with **no properties default**. Read `docs/runbooks/RUNBOOK-ETH-KEYSTORE-REENCRYPTION.md` before setting on an existing keystore (empty password → files stop decrypting).                                                                                                                                         |
| `PAY_CRYPTO_HOT_WALLET_KEY` / `PAY_CRYPTO_DEPOSIT_MNEMONIC` | Optional live crypto rail (TypeScript pay). Unset ⇒ no live rail.                                                                                                                                            | Schema: `0x` + 64 hex for the key. **Never commit a mainnet hot key.** Compose/env parity covers the name once required.                                                                                                                                                                                                                       |

ACT node RPC in a test `main()` (A3) is evidence, not a fleet env key. Owner decides if that node is ours. Cite A3; do not delete it as a “fix”.

### 1.5 · Values disclosed in git history (the vendored exchange tree)

The vendored Java tree was deleted on 2026-10-19, so nothing in HEAD boots these values. Each one is still readable in git history, and no rotation of any of them is recorded. Only the owner can make an old value worthless, with the provider or on the chain. Removing a literal from HEAD never un-discloses it. Names and keys only, never values.

| What                                   | Where it was (history)                                                                                                                                  | Owner action                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two ECT withdrawal seeds (A1, A2)      | `01_wallet_rpc/ect` properties `coin.withdraw-wallet`; a `main()` in its `EctApi`                                                                       | Move the value to fresh addresses; the destination must change, not just the seed. [`OWNER-ACTIONS-WALLET-RPC-SECRETS.md`](OWNER-ACTIONS-WALLET-RPC-SECRETS.md) A1, A2. |
| ACT node RPC credential (A3)           | `01_wallet_rpc/act` test `ActClientTest`                                                                                                                | Rotate it on the node if the node is ours; else nothing to rotate. A3 there.                                                                                            |
| Actuator basic-auth password           | `ucenter-api`, `otc-api` → `security.user.password`                                                                                                     | Rotate first. It guarded `/monitor/heapdump` on a published port, so treat everything those processes held in memory as exposed too.                                    |
| Cloud access key pairs                 | `admin`, `ucenter-api` → `aliyun.accessKeyId` / `accessKeySecret`                                                                                       | Rotate with the provider (billable).                                                                                                                                    |
| SMS gateway passwords                  | `admin`, `ucenter-api`, `wallet` → `sms.password`                                                                                                       | Rotate with the provider (billable).                                                                                                                                    |
| Captcha keys                           | `ucenter-api` → `geetest.privateKey` (also a field copy in `GeetestLib`), `water.proof.app.secret.key`, and an id plus key pair in `RegisterController` | Rotate with the provider.                                                                                                                                               |
| Admin console signing factor           | `admin` dev properties → `spark.system.md5.key`, read by eight admin controllers, the withdraw approval among them                                      | Rotate if that console was ever deployed anywhere; changing it can invalidate stored admin credentials.                                                                 |
| Bytom access token; Etherscan API keys | `01_wallet_rpc/btm` → `client.access.token`; `erc-token`, `erc-eusdt` → `etherscan.token`                                                               | Rotate if ever used (the Bytom token is real-shaped).                                                                                                                   |

The rest of what the 2026-07-30 audit swept (keyboard-mash values against the unroutable `111.111.111.111`, the matched dev pairs, a dead 2FA demo seed) was judged dead and needs nothing.

### 1.6 · Who must move together

Each shared secret must be identical in every compose block that holds it. On 2026-11-18 `docker-compose.apps.yml` gives them to:

| Secret                    | Holders (re-count with `grep -n -e '*edge-secret' -e '*internal-secret' -e JWT_ACCESS_SECRET docker-compose.apps.yml`)                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EDGE_PRINCIPAL_SECRET`   | 23: svc-edge, svc-academy, svc-agents, svc-bank, svc-blueprint, svc-campaigns, svc-dex, svc-execution, svc-identity, svc-indexer, svc-market, svc-matching, svc-notify, svc-ops, svc-p2p, svc-pay, svc-protocol, svc-quant, svc-support, svc-tax, svc-token, svc-trade, vendor-shell |
| `INTERNAL_SERVICE_SECRET` | 17: svc-ledger, svc-academy, svc-agents, svc-bank, svc-execution, svc-fix, svc-identity, svc-market, svc-matching, svc-mining-pool, svc-ops, svc-p2p, svc-pay, svc-support, svc-tax, svc-token, svc-trade                                                                            |
| `JWT_ACCESS_SECRET`       | 9: svc-identity (mints), svc-edge, svc-ledger, svc-ws (optional), svc-agents, svc-bank, svc-support, svc-token, svc-trade                                                                                                                                                            |

Absences that are load-bearing, not oversights: svc-ws holds neither the edge nor the internal secret, which is why it may be a second internet-facing port; svc-edge holds no `INTERNAL_SERVICE_SECRET`, so the front door cannot reach the money plane; svc-dex and svc-protocol hold no `INTERNAL_SERVICE_SECRET`, non-custodial by construction.

What a partial rotation looks like:

| Left on the old value               | Symptom                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| An `EDGE_PRINCIPAL_SECRET` holder   | Its authenticated requests return 401; public paths keep working.                                                                    |
| An `INTERNAL_SERVICE_SECRET` caller | Its `ledger.post` returns 401. The platform starts and `/health` passes, and no value can move. Nobody notices until someone trades. |
| svc-identity (`JWT_ACCESS_SECRET`)  | Logins succeed and every later request is anonymous, with no error in any log.                                                       |
| svc-edge (`JWT_ACCESS_SECRET`)      | Every request 401s.                                                                                                                  |
| svc-ledger (`JWT_ACCESS_SECRET`)    | Users are unaffected; the operator console stops authenticating, mid-rotation.                                                       |
| svc-ws (`JWT_ACCESS_SECRET`)        | Public market data keeps flowing; `/private/stream` refuses upgrades, so order and fill updates stop while prices still show.        |

Per-service secrets reach one service and rotate alone. A `PAY_*_WEBHOOK_SECRET` also changes at its sender at the same moment, or deliveries fail their signature check.

### 1.7 · What the dev stack publishes

On 2026-11-18 the app fleet publishes only svc-edge (`4000`), svc-ws (`4014`), vendor-shell (`8090`) and admin (`3100`); every money service is compose-internal. `docker-compose.yml` publishes its infrastructure on all interfaces (Postgres `5433`, Redis `6380`, NATS `4222`/`8222`, OTLP `4317`/`4318`, Tempo `3200`, Prometheus `9090`, the dev EVM nodes `8545`/`8546`) and Grafana on `3001` with anonymous users given the Admin role. That is fine on a laptop; on any shared host bind them to loopback first.

---

## 2 · Order of rotation

Order is **blast radius of value**, then **auth plane**, then **money plane**, then **session**, then **outbound notify**, then **per-service**. Do not skip 1–2 because the Java modules are not in compose — disclosure is in git history, not in `docker ps`.

1. **Wallet disclosed keys (Class X, owner only)**
   - Check balances / sweep **before** issuing replacements ([`OWNER-ACTIONS-WALLET-RPC-SECRETS.md`](OWNER-ACTIONS-WALLET-RPC-SECRETS.md) A1 steps 1–2).
   - Rotate **A1** `ECT_WITHDRAW_WALLET_SECRET` first among wallet secrets.
   - Treat **A2** as a separate burned account.
   - Then `WALLET_RPC_AUTH_TOKEN` (and ETH keystore passwords only if those modules will ever boot).
   - Keep `coin.rpc` off cleartext or off the public network (A1 step 5) or the new seed is disclosed on first use.
   - **Do not boot `01_wallet_rpc` to “test” the new key against real value (A4).**
2. **`EDGE_PRINCIPAL_SECRET`** — whole edge-principal set, one restart.
3. **`INTERNAL_SERVICE_SECRET`** — whole ledger-caller set, money-path probe.
4. **`JWT_ACCESS_SECRET`** — every holder in §1.6 together.
5. **Notify gateway tokens** — with vendor-side token, URL pairing intact.
6. **Per-service pay webhooks** (`PAY_CRYPTO_WEBHOOK_SECRET`, `PAY_CARD_SANDBOX_WEBHOOK_SECRET`) and, only if the live rail is actually on, `PAY_CRYPTO_*` signing material.

Shared HMAC secrets have **no two-key overlap** today. The safe procedure is still: one env edit, restart the **entire** affected set. Rolling one container at a time is a mixed fleet.

A rotation **recreates containers**. That is why compose/schema parity is a rotation gate, not a nicety: every latent missing `environment:` line becomes a crash-loop at the same moment (#431: svc-ledger crash-looped on a missing `JWT_ACCESS_SECRET` when a recreate reached it; #442: svc-academy died at import, so no container and no logs existed to read).

---

## 3 · How gates prove the old disclosed value is refused

CI does not rotate. It proves **the code path cannot quietly reuse a known-bad or unwired secret**. Live “did the coins move” is still the owner’s chain check.

| Gate / guard                                       | What a green line actually means                                                                                                                                                               | What it does **not** mean                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Retired with the vendored wallet code (2026-10-19) | The Java wallet RPC tree, its disclosed-secret boot refusal and its auth gates were deleted with `vendor/`. Nothing in the tree boots those secrets any more.                                  | Rotation happened. History is still disclosed; only a new address makes the old key worthless. |
| `secret-scan`                                      | Credential-shaped **literals** in HEAD fail (except a **KNOWN_DISCLOSED** register that must stay true). Mutation suite (`secret-scan-mutation`) proves the scanner is not `exit 0` on line 1. | A value only in git history is gone.                                                           |
| `compose-secret-parity`                            | Every **required** secret-shaped env field in `services/*/src/env.ts` is passed in that service’s `docker-compose.apps.yml` block. Rotation cannot leave a consumer unwired.                   | The **value** in `.env` is not `dev-only-*`. The check never reads values.                     |
| `secrets` / gitleaks (when run)                    | No new secret **landed in this tree**.                                                                                                                                                         | Owner vault contents.                                                                          |

**Empty denominator:** if this runbook file is deleted, `secret-rotation-readiness` fails. A missing inventory is not “nothing to rotate”.

---

## 4 · Operator checklist (still not a rotation)

1. Confirm you are the human with wallet / vendor / vault authority. If not, stop.
2. Follow §2 order. Generate replacements **off this repository**. Never commit them.
3. After each shared-secret step: full affected restart, then the probe in the table (login / money path / notify).
4. For A1: verify the **old address** holds nothing. `pnpm scan:secrets` going quiet is **not** that proof.
5. Leave `01_wallet_rpc` undeployed until A4 is an owner decision.

---

## 5 · Files this mountain does not own

Do not “helpfully” edit: `docs/OWNER-ACTIONS-WALLET-RPC-SECRETS.md`, P3-02 threat docs, P3-10 incident runbook, P2-02 Java map, P4-07 ADR, `packages/config/src/screening.ts`, skip-honesty scans, `services/svc-edge`. Vue is HUMAN (`nitro-frontend-all`).
