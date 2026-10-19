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

**Implemented by:** [`.github/workflows/staging-deploy.yml`](../../.github/workflows/staging-deploy.yml). Threat model remains sibling **D26-P3-02** (`docs/THREAT-MODEL-STAGING-DEPLOY.md`) — this ADR does not rewrite it.

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
