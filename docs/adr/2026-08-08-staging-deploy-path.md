# ADR: staging deploy path — parameterised workflow, not prod Kubernetes

**Status:** **Accepted — 2026-08-08.** Owner decision (Nitro green light on axis plan A3).
**Decision owner:** repo owner. **Written by:** resume agent (axis C4).
**Spec id:** axis A3 / C4. **Class:** X2 for real credentials; this ADR is product/ops law only.

---

## The decision

> **Staging is a single parameterised host path, not production.** Production remains the doctrine §1 Kubernetes path. Staging deploys **only** via `workflow_dispatch` until branch protection (OWNER-GITHUB-CONFIG G1) is set. Deploy-on-merge-to-main is **forbidden** while the operator and the swarm share one GitHub identity (G5).
>
> **Consume the existing Docker unit.** `Dockerfile` + `docker-compose.apps.yml` are the deployment unit. Rebuild not redesign (Phase A fleet/images). Do not invent a second image strategy.
>
> **`APP_ENV=staging` is a fail-closed policy switch**, not a label. Sanctions screening and pay-rail sandbox rules that refuse to boot without required blocklists **must stay enforced**. Setting `APP_ENV=dev` on a reachable staging host to make it boot is **forbidden**.
>
> **Secrets:** doctrine §9 prefers vault. GitHub Actions secrets are an explicit **named deviation** for staging only until a vault path exists. Real staging credentials are Class **X2** — append `docs/BOARD-CLEAR-HUMAN-BLOCKERS.md` (removed); never invent placeholder secrets in the repo.
>
> **Rollback** is redeploy previous image tag. That is not a §14.6 kill-switch. Kill-switch remains a separate lever.
>
> **Host purchase** (provider, size, DNS) is Class X money — this ADR does not buy a host. A workflow with nowhere to deploy is a file until the host exists; that is accepted.

---

## D26-P3-01 — workflow match

**Implemented by:** [`.github/workflows/staging-deploy.yml`](../../.github/workflows/staging-deploy.yml), removed on 15 Nov 2026 and restored on 23 Nov 2026 from commit `9ef9844c1d` for the hosted beta (#10210), with its pins `packages/config/src/staging-deploy-body-bind-pin.test.ts`, `packages/config/src/compose-app-env-required-pin.test.ts` and the staging checks in `tooling/scripts/fleet-tip-image.mjs`. Its `posture` input deploys the beta posture (amendment of 23 Nov, below) by default, or plain staging. Threat model remains sibling **D26-P3-02** (`docs/THREAT-MODEL-STAGING-DEPLOY.md`) — this ADR does not rewrite it.

| ADR rule                                                                                  | How the workflow matches                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Staging deploys **only** via `workflow_dispatch`                                          | `on:` is `workflow_dispatch` only. No `push`, `schedule`, `pull_request`, `pull_request_target`, or `repository_dispatch`.                                                                                                                                           |
| Deploy-on-merge-to-main is **forbidden** while operator and swarm share one identity (G5) | Same surface. Preflight step `No unattended trigger` re-reads the `on:` block on every run and fails if those keys appear.                                                                                                                                           |
| Documented exception (G1 branch protection)                                               | **Not wired.** Flip conditions below re-open merge-to-staging as a later decision. G1 landing does **not** add a `push:` trigger. Dispatch-only stands until an explicit PR.                                                                                         |
| **`APP_ENV=staging` fail-closed**                                                         | Deploy job names `env.APP_ENV: staging`. The runner asserts that value before ssh. The remote shell asserts again and starts compose with `APP_ENV=staging`, which wins over a host `.env`. Setting `APP_ENV=dev` to force a boot is unreachable from this workflow. |
| Attended GitHub environment named `staging`                                               | Deploy job `environment: staging`. Reviewers / wait timer / branch allow-list are owner settings (Class X), not this file.                                                                                                                                           |
| Host purchase and real credentials are Class X2                                           | No host, domain, URL, or IP in the workflow. Missing transport secrets fail closed **by name**. No secret **values** in the repo.                                                                                                                                    |

---

## What this unlocks

- Agents may open a **parameterised** `workflow_dispatch` deploy workflow that targets staging host vars/secrets.
- Agents must **not** wire deploy-on-merge-to-main until G1 is true.
- Agents must **not** weaken `APP_ENV` policy to force a boot.
- Product lanes stay unblocked while the host is purchased.

---

## What this does not decide

- Cloud provider or instance size (recommend later; owner picks).
- Vault vs long-lived Actions secrets for prod.
- Kubernetes prod topology (already doctrine §1).

---

## Flip conditions

- G1 branch protection on `main` lands → re-open whether merge-to-staging is safe.
- Host exists + secrets in place → workflow becomes a capability, not a file.
- Vault path for staging secrets → retire Actions-secrets deviation.

---

## Implementation order after this ADR

1. Parameterised workflow file only (`workflow_dispatch`).
2. Owner buys host + stores secrets (Class X2).
3. One manual dispatch smoke.
4. Only then consider promote paths.

---

## Amendment, 23 Oct 2026: temporary Try-it runs (owner decision 48)

The owner chose a free, temporary way for people to click through the app before any host is bought: the `Try it` workflow (`.github/workflows/try-it.yml`, `tooling/scripts/try-it.mjs`). Removed on 15 Nov 2026: its last run was 23 Oct (project-state #2553, layer 8); restore both, and the `docs/LOCAL-TEST-STACK.md` section, from commit `9ef9844c1d`.

- **What it is.** A run started by hand on GitHub's runner. It boots the local test stack exactly as Real-app journeys does: the labelled dev/TEST profile with the screening stand-in, TEST money only, and no partner credentials. It puts a password gate in front of the Customer app and opens a temporary Cloudflare quick-tunnel link to it. The run ends after at most about 5 h 45 min, and its data goes with it.
- **What the owner accepted.**
  - The link's random address shows in the public Actions log.
  - The dev profile is reachable while the run lasts.
  - The protection is the `TRY_PASSWORD` secret, which only an admin sets and no agent sees. Wrong guesses are rate-limited.
  - TEST-only money, and the end of the run.
- **What does not change.** This is not a staging host. A permanent or always-on host still follows this ADR in full: `APP_ENV=staging` stays fail-closed, and setting `APP_ENV=dev` on a reachable host to make it boot stays forbidden. `Try it` is `workflow_dispatch` only, is not a deploy, and has no `push`, `schedule` or `pull_request` trigger.

## Amendment, 23 Nov 2026: the beta posture, staging on TEST networks only (owner decision)

The owner chose a beta mode for real test networks: it keeps staging's protections, and only test networks are allowed (#10217).

- **What it is.** `APP_ENV=staging` plus `INTAFACED_BETA_POSTURE=test-networks`. It is still staging: production posture holds (`packages/config/src/production-posture.ts`: no dev keys, no published passwords, real generated secrets, S2S body binding required), blank owner values still refuse, and screening still fails closed (`INTAFACED_SCREENING_FAIL_CLOSED=off`, a TEST KMS key and TEST business blocks still refuse to boot).
- **What it opens.** Only TEST networks and labelled TEST stand-ins: a TEST venue (simulator, testnet, partner sandbox; `refuseTestVenueOutsideTest`), the TEST sign-in wallet provider (`TEST:test`, loopback only), and the labelled TEST sanctions list. Each keeps its TEST label; nothing is renamed to read as real.
- **What it refuses.** `assertBetaPosture` (`packages/config/src/beta-posture.ts`) runs in every service's `loadEnv` and refuses to boot when: the switch has any other value; it is set under any `APP_ENV` but `staging`; any `*_CHAIN_ID` is not a listed public testnet (`BETA_TESTNET_CHAIN_IDS`); any URL setting points at a mainnet endpoint; or any bank or card partner setting (`BANK_*_PARTNER`, `_ISSUER`, `_SCHEME`) names anything but `none`, `off`, `test` or a `*-sim` stand-in. Test: `packages/config/src/beta-posture.test.ts`.
- **What does not change.** Everything this ADR forbids for real money still holds. Setting `APP_ENV=dev` on a reachable host stays forbidden; the beta switch is the only way to run TEST networks on one. Plain staging, without the switch, refuses every TEST network as before. The switch never runs in `prod`.
- **How it is deployed.** The staging deploy's `posture: beta` (its default) exports `INTAFACED_BETA_POSTURE=test-networks` beside `APP_ENV=staging` on the host, and `docker-compose.apps.yml` forwards it to every service; `posture: staging` clears it. Every other rule of the workflow is unchanged.
- **Not yet opened.** The tester profile's seed (`docker-compose.apps.yml` `seed`) and the other local stand-ins that check `APP_ENV` dev or test directly still refuse under the beta posture.
