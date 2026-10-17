# Incident runbook — Protocol Plane (chain / relay / self-custody)

**Board:** S-J3 · Shehzad (`@shehzad002`)  
**Class:** N (ops procedure). Does **not** close Class X go-live or `socket.contract-audit`.  
**Law:** Doctrine §14.6 (operator kill, never trap funds) · S-A1 never-a-guardian · [`../SHEHZAD-BLOCKCHAIN-TASK-BOARD-2026-08-03.md`](../SHEHZAD-BLOCKCHAIN-TASK-BOARD-2026-08-03.md)  
**Not this page:** ledger posting / trade match red — that is [`INCIDENT-MONEY-PATH-RUNBOOK.md`](INCIDENT-MONEY-PATH-RUNBOOK.md) (Denon). If both are red, contain the **book** first with that runbook, then come here.

This page exists so an operator can act when **svc-protocol relay** or **on-chain account behaviour** is the incident **without inventing a pause, an upgrade, or a platform guardian**. If a door is not named below, it is not in this playbook.

---

## 0 · Decision tree (one screen)

| What you see                                                               | First contain (existing door only)                                                                                                                           | Who                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Relayer is forwarding bad / stuck UserOps; users can still submit on-chain | **Edge module kill `protocol`** — `POST /admin/kill-switches` `{ module: "protocol", disabled: true, reason }` (`admin:write` + MFA). Reads still pass.      | Operator with `admin:write`          |
| Same, host-local, edge already killed or down                              | Process flag **`PROTOCOL_RELAY_ENABLED=false`** on svc-protocol (boot). `relayUserOperation` refuses. Address prediction and calldata construction continue. | Operator who can restart the process |
| User lost a key / wants recovery                                           | **Do not become a guardian.** User-elected recovery is `UserElectedRecovery` — the user already set guardians. Platform has no rotate-owner door.            | User (and their elected guardians)   |
| Want to `pause()` or `upgradeTo()` a deployed contract                     | **Stop.** No contract in this suite exposes those. Inventing them in an incident is how the plane becomes custodial.                                         | Nobody                               |
| Book / trade / ledger is the red                                           | **Stop this page.** Use [`INCIDENT-MONEY-PATH-RUNBOOK.md`](INCIDENT-MONEY-PATH-RUNBOOK.md).                                                                  | Denon                                |
| Need prod keys, RPC funding, licence content, sanctions list               | **Class X.** This runbook does not authorize it.                                                                                                             | Nitro human (+ counsel)              |
| INTACHAIN / validator / bridge incident                                    | **Stop.** S-D2–D9 is not an engineering playbook yet. Do not invent a halt.                                                                                  | Shehzad                              |

**Never:** pause a user's SmartAccount, upgrade a factory, set the platform as a recovery guardian, freeze tokens sitting in a user's account, or treat a relay kill as "the chain is halted." The account is on a public chain. The same signed UserOp goes to any bundler.

---

## 1 · Detect

| Signal                    | File / route                                                                    | What red looks like                                                                                |
| ------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Protocol liveness         | `services/svc-protocol` `GET /health` / `GET /ready` (`svc-protocol:4012`)      | Process down, or `chain_unreachable` on every chain path                                           |
| Relay posture             | `health.relayEnabled` · `src/index.ts` `PROTOCOL_RELAY_ENABLED`                 | `false` means we already stopped forwarding. That is contain, not a user lockout.                  |
| Edge halt list            | `GET /admin/status` · `GET /admin/kill-switches` (`admin:write` + MFA)          | `protocol` in `disabledModules`                                                                    |
| Edge still allowing reads | `services/svc-edge/src/control-plane.e2e.test.ts` (protocol module kill)        | After `protocol` kill: relayed submit → `edge.module_killed`; unauthenticated reads still pass     |
| User can self-submit      | `services/svc-protocol/README.md` Kill-switch · `relayUserOperation`            | Missing bundler / killed relay is a convenience refuse. The user submits to EntryPoint themselves. |
| Recovery is user-elected  | `contracts/recovery/UserElectedRecovery.sol` · `test/forge/RecoveryOwner.t.sol` | Platform is never a guardian. Factory is not defaulted to recovery.                                |

Compose port: `docker-compose.apps.yml` (`intafaced-svc-protocol` 4012). Edge prefix: `/api/protocol` (`PROTOCOL_URL`).

---

## 2 · Contain — existing doors only

**Do not add a new flag, pause, or upgrade in an incident.**

### 2.1 Edge kill of module `protocol` (preferred)

Same door as the money-path runbook §2.2: `POST /admin/kill-switches` with `module: "protocol"`. Command surface: [`OPS-KILL-SWITCH-RUNBOOK.md`](../OPS-KILL-SWITCH-RUNBOOK.md).

Proven: `services/svc-edge/src/control-plane.e2e.test.ts` — relay submit refuses; account reads still pass.

This stops **our** hosted relay. It does not stop a UserOp on chain.

### 2.2 In-service relay flag (boot)

`PROTOCOL_RELAY_ENABLED=false` — `services/svc-protocol/src/env.ts`. Read once at boot. `src/index.ts` `setRelayEnabled` is the in-process mirror the admin console was meant to reach; the **reachable** live switch is the edge (§2.1), not a second deploy.

**Effect:** `relayUserOperation` refuses. Predict / build calldata / reads continue (`services/svc-protocol/README.md`).

### 2.3 What is not a contain step

| Temptation                          | Why it is forbidden                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pause()` on SmartAccount / factory | No such function. A pause that freezes user funds is custody.                                               |
| `upgradeTo` / new implementation    | Factories are immutable clones. An incident upgrade is a new product, not a contain.                        |
| Platform-signed recovery            | S-A1: user elects guardians. The platform is never in the quorum.                                           |
| Pulling tokens from CardPull        | `CardPull` holds nothing. `kill` is the **user's** call on **their** program, not an operator switch.       |
| Emptying the paymaster float        | Operator of `ScopedPaymaster` may withdraw leftover ETH from **that contract only**. Do not touch user SAs. |
| `audited:true` because we halted    | Halt ≠ audit. `socket.contract-audit` stays Nitro budget.                                                   |

---

## 3 · Roles

| Role                        | During a protocol incident                                                                                          | Must not                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Shehzad** (`@shehzad002`) | Technical lead for chain / relay / venue contracts / INTACHAIN. Decides whether the edge `protocol` kill is enough. | Invent a pause/upgrade; become a guardian                          |
| **Denon**                   | If the red is ledger/trade, he leads on the money-path runbook. Does not implement chain contain.                   | Dual-build protocol contracts in the incident                      |
| **Nitro human** Class **X** | RPC, funding, licence content, prod keys, sanctions list.                                                           | Be asked to run git/PR                                             |
| **Agents**                  | Page Shehzad, pull **existing** edge kill if credentials already exist, write an honest note.                       | Invent a contract admin; mark audited; default factory to recovery |

---

## 4 · After contain (still not an upgrade)

1. Confirm users can still **read** (`health`, `predictAddress`, `sessionStatus`).
2. Confirm a user with their own bundler/EntryPoint path is **not** locked — that is the sovereignty bar.
3. Un-kill `protocol` with a reason ≥ 12 characters, same door as contain.
4. If the hole was missing **procedure**, patch **this file**. If the hole was missing **code**, that is a different board id — do not smuggle `pause` into an incident PR.

---

## 5 · Honest residuals

1. External audit (`socket.contract-audit`) — Nitro budget. Not closable from this page.
2. Live Base Sepolia / public registry rows — Nitro RPC.
3. Paymaster **funding** — Nitro Class X. Unfunded validation already refuses.
4. `setRelayEnabled` is in-process; multi-replica share of that memory is not a door. Use the edge kill.
5. INTACHAIN (S-D2–D9) has no halt playbook. Do not invent one here.
6. Restore / key ceremony — Class X. Not claimed.

---

## Leverage

Phase A **IN** — edge `protocol` module kill already proven, `PROTOCOL_RELAY_ENABLED` already refuses relay, recovery is already user-elected, contracts already have no pause/upgrade. Horizon: this file is ops procedure (S-J3). No second admin product, no platform guardian, no greenfield kill-switch.
