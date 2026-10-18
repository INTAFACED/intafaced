# OWNER ACTIONS — wallet RPC secrets

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

> **Land status 2026-08-04:** code-path fixes ship with the wallet-rpc-auth land PR. Rotation + ADR below remain human/Class X.

**Date:** 2026-08-02. **Raised by:** the `fix/wallet-rpc-auth` branch.
**Companion:** [`A1.4-WALLET-SECRETS-PERIMETER-2026-07-30.md`](A1.4-WALLET-SECRETS-PERIMETER-2026-07-30.md) §2, §4, §5.

Everything on this page needs a **human with authority over a chain account or a
third-party account**. None of it can be done by an agent, and none of it was attempted.

**No secret value appears in this document.** Items are referenced by file and key.

---

## Why these are yours and not the branch's

A committed secret has two halves. **Getting it out of the code path** is an engineering
change and it is done — the values now come from the environment, and the services refuse
to start without them. **Making the old value worthless** is a rotation, and rotation is an
act on a live system: it needs a wallet, a signature, or a vendor console login.

The thing that makes rotation non-optional here is that a committed secret is **disclosed
forever by git history**. Rewriting history does not help — the objects exist in every
clone, every fork, and every backup. The only remedy that works is to make the value
useless.

An agent must not rotate these, must not invent replacements, and must not "temporarily"
generate one to make a service boot. A key that an agent generated is a key an agent had.

---

## A1 — ECT withdrawal signing secret · **do this first**

|              |                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Where**    | `01_wallet_rpc/ect/src/main/resources/application.properties` → `coin.withdraw-wallet` (before this branch; now `${ECT_WITHDRAW_WALLET_SECRET}`) |
| **What**     | The seed that signs every ECT withdrawal. Correct Ripple-family format.                                                                          |
| **Reaches**  | `WalletController.withdraw` → `EctApi.sendFrom` → POSTed as the JSON `secret` field to `coin.rpc`, **in cleartext over plain HTTP**.             |
| **Controls** | Everything at `coin.withdraw-address`.                                                                                                           |
| **Status**   | Disclosed. Assume every holder of a repo clone has it.                                                                                           |

**Remediation, in order:**

1. **Check the balance at `coin.withdraw-address`** (the address is in the same properties
   file and is public). If it is non-zero, this is an incident, not a chore.
2. **Sweep any balance to a new address** whose key was generated **off this machine and
   outside this repository**, before doing anything else.
3. **Generate the replacement secret outside the repo.** Never paste it into a file in the
   tree, a commit message, a PR body, or a chat.
4. **Set `ECT_WITHDRAW_WALLET_SECRET`** in the deployment environment only.
5. **Decide whether `coin.rpc` stays plain HTTP.** Today the secret is POSTed unencrypted.
   Rotating the key while continuing to send the new one in cleartext buys one round.
   Either terminate TLS in front of the node or keep the whole path on a private network.

**Already done for you, so you do not have to sequence it:** `EctWithdrawSecretConfig`
refuses to start if the variable is unset, **and refuses to start if it is set to the old
disclosed value** (matched by SHA-256, so the value itself is not in the tree). The likely
mistake — copying the old literal out of git history to make the service boot again — is
blocked.

---

## A2 — second ECT secret, in a deleted `main()`

|             |                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Where**   | `01_wallet_rpc/ect/…/component/EctApi.java` — `main()`, **now deleted**                                                                                |
| **What**    | A _different_ hard-coded wallet secret, plus a source account, in a developer scratch harness that shipped.                                            |
| **Reaches** | It called `sendFrom` directly — a signed 10-ECT transfer against a hard-coded third-party IP. The only thing stopping it was nobody running the class. |
| **Status**  | Disclosed. Separate from A1: **rotating A1 does not cover this account.**                                                                              |

**Remediation:** same shape as A1 — check the source account named in that method (recover
it from git history if needed), sweep anything it holds, and treat the key as burned. There
is no environment variable to set: the code path is gone, not relocated.

---

## A3 — ACT node RPC credential · decision, not necessarily action

|            |                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------ |
| **Where**  | `01_wallet_rpc/act/src/test/java/ActClientTest.java`                                             |
| **What**   | `http://<user>:<weak-password>@<public-ip>:8900/rpc` inline in a `main()`.                       |
| **Status** | Almost certainly upstream's node, not ours. Not run by surefire — it is a `main`, not a `@Test`. |

**Deliberately left in the tree.** Deleting the line changes nothing: it is in history either
way, and it is not on any code path. The only question is whether that node is ours, which
only you can answer. If it is: rotate it. If it is not: nothing to do, and it stays as
evidence of what this vendored tree ships with.

---

## A3b — the withdrawal signature carries no chain id · **needs a JDK, not an owner**

|            |                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `01_wallet_rpc/eth-support/…/service/PaymentHandler.java:158` and `:193`                                                           |
| **What**   | Both ETH-family withdrawal paths sign with the two-argument, pre-EIP-155 `TransactionEncoder.signMessage(rawTx, credentials)`.     |
| **Effect** | A withdrawal signed against a testnet is **also a valid mainnet transaction**, and anyone who can see it can replay it to mainnet. |
| **Status** | **UNFIXED, deliberately.** Specified in full, not applied.                                                                         |

On this page because it is the reason "just point it at a testnet" is not
available to you as a mitigation, and because it is the one of the three
`01_wallet_rpc` criticals that an agent must not fix. Adding a chain id changes
the bytes that get signed; there is no JDK, JRE or Maven on the host, so the
change could not be compiled, let alone checked against a known-answer signed
transaction. On a withdrawal path that is how money gets stranded by a change
that looks obviously right.

The exact diff, the chain-id source, both call sites, the wrong fix that looks
right (`ChainId.NONE`), and the fixture tests that must pass first are in
[`SPEC-EIP155-WALLET-RPC-WITHDRAWAL-SIGNING.md`](SPEC-EIP155-WALLET-RPC-WITHDRAWAL-SIGNING.md).
It also flags a blocker to check before any code is written: web3j is pinned at
3.3.1, whose chain-id parameter is believed to be a `byte`, which cannot express
most modern testnet chain ids at all.

**Not urgent, and not yours.** It is latent — nothing in this repo can build or
boot the module — and it sits behind the A4 review and a working reactor build.

---

## A4 — do not deploy `01_wallet_rpc` against real value yet

Not a secret, but it belongs on this page because it is the constraint the rest sits under.

The [vendored-exchange ADR](adr/2026-07-28-vendored-exchange-integration.md) makes a
security review a **precondition of adoption**, and that review has not happened: 878 Java
files, 31 unverifiable committed `.jar` binaries on the classpath of services that hold
custody, and no JDK on this host, so **none of this has ever been compiled or run.**

The `fix/wallet-rpc-auth` branch closed one specific hole found in passing — six modules
serving withdrawal endpoints with no authentication. **It is not that review, and it should
not be read as clearance.** Treat every module in `01_wallet_rpc` as untrusted until
somebody has read it.

---

## What is already enforced, so you do not have to remember it

| Guard                                                                          | Effect                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RpcSecurityConfig` in all 13 bootable modules                                 | No `WALLET_RPC_AUTH_TOKEN` (or one under 32 chars) → the service **does not start**.                                                                                                                             |
| `EctWithdrawSecretConfig`                                                      | No `ECT_WITHDRAW_WALLET_SECRET`, or the old disclosed one → ECT **does not start**.                                                                                                                              |
| `tooling/ci/wallet-rpc-auth-scan.mjs` (wired into `pnpm gate` / `pnpm verify`) | A module that can boot without the guard on its classpath fails CI. So does an unread `rpc.auth-token`.                                                                                                          |
| Same scan, rule W3                                                             | Any future compose entry publishing a `01_wallet_rpc` port off `127.0.0.1` fails CI.                                                                                                                             |
| `tooling/ci/secret-scan.mjs`                                                   | `withdraw-wallet` keys must be `${VAR}` or a keystore filename. The ECT literal now fails the gate.                                                                                                              |
| `tooling/ci/wallet-rpc-mainnet-scan.mjs`                                       | Nothing in this repo may build, containerise, compose or boot a module here (M5–M7), and no new mainnet constant may be added. 38 existing ones are frozen by exact text **and by how many times each appears**. |
| `tooling/ci/wallet-rpc-mainnet-scan.mjs` (gate id `wallet-rpc-mainnet`)        | A4 above, made executable. See below.                                                                                                                                                                            |

Nothing in `01_wallet_rpc` publishes a port today — no compose file defines one of these
services at all. W3 exists so that stays true by accident-proofing rather than by memory.

### A4 was prose until 2026-08-04

Everything above is about **secrets**. None of it was ever about **which chain**, and A4 — the
constraint the whole page sits under — had no gate at all. What actually kept this tree off
mainnet was incidental: no Dockerfile, no compose service, no CI job, an unresolvable module in
the reactor pom, and `${...}` placeholders that decide whether a service **starts**, not what it
talks to. Supply the environment, point `coin.rpc` at a mainnet node, and every gate on this page
still printed clean.

`wallet-rpc-mainnet-scan.mjs` closes that. It fails the build on a **new** mainnet network
selector, endpoint, start height, address or keystore name anywhere in the tree, and it turns the
three accidental absences into stated invariants: no Dockerfile, no compose service, no CI job may
build or boot any module here. The 38 mainnet constants already in the tree are frozen by exact
text — not by count, so one cannot be swapped for another — and each carries a written reason
naming what it is and what you would have to do about it.

Two of those 38 are worth reading before anything here is ever deployed, because neither is
fixable by configuration:

- `eth-support/.../EtherscanApi.java` hardcodes `https://api.etherscan.io/api` — Ethereum
  **mainnet** — and `PaymentHandler` broadcasts every ETH and ERC-20 withdrawal there a **second
  time**, after sending it to `coin.rpc`. Aiming the node at a testnet does not make the withdrawal
  a testnet withdrawal; it makes the mainnet copy the one that lands.
- Both withdrawal paths sign with the two-argument `TransactionEncoder.signMessage(...)`, the
  pre-EIP-155 form that carries **no chain id**, so the signature is valid on every EVM chain at
  once.

Together those mean "just point it at a testnet" is not an available mitigation for this tree. The
only thing standing between it and mainnet is that nothing can boot it — which is now enforced
rather than merely true.
