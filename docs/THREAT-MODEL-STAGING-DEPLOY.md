# Threat model — the staging deploy workflow

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Subject:** `.github/workflows/staging-deploy.yml`, and nothing else.
**Board:** D26-P3-01 (the workflow). Fiat / wallet_rpc / vendor Java live under **D26-P3-02** → [`THREAT-MODEL-CURRENT.md`](THREAT-MODEL-CURRENT.md).
**Law it sits under:** [`adr/2026-08-08-staging-deploy-path.md`](adr/2026-08-08-staging-deploy-path.md) (Accepted 2026-08-08).
**Doctrine it is consistent with, and does not restate:** [`OWNER-ACTIONS-WALLET-RPC-SECRETS.md`](OWNER-ACTIONS-WALLET-RPC-SECRETS.md) · the header of `tooling/ci/secret-scan.mjs` · [`SECURITY-WHEN-PLAIN.md`](SECURITY-WHEN-PLAIN.md).

---

## 0 · Scope, and the honest bit first

This is the threat model of **one workflow file**. It is written because that file will one day hold credentials that can reach a running copy of a money platform, and the day it does is a bad day to start thinking about it.

**It is not D26-P3-02.** The board asked there for a living threat model of the _fiat plane, `wallet_rpc`, and the vendored Java surface_. That work now lives in [`THREAT-MODEL-CURRENT.md`](THREAT-MODEL-CURRENT.md). This file stays the deploy-path slice only. Claiming P3-02 done from this workflow would be the "route exists ≠ done" move the board exists to prevent.

**Nothing here has been tested against a host.** There is no staging host; buying one is Class X money. Every mitigation below is reasoned and, where it was mechanically checkable, checked — the trigger self-check and the container-state classifier were executed against fixtures, `actionlint` passes, every embedded script passes `bash -n`. None of that is the same as a deploy having happened. **No deploy has happened.**

### What is actually at risk

Ranked, because a threat model that treats all assets alike produces a checklist instead of a decision.

| #   | Asset                                                                  | Why it ranks here                                                                                                                                                           |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **The four transport secrets** — host, user, ssh private key, host key | Together they are shell on the staging host. Disclosure is irreversible (§4).                                                                                               |
| 2   | **The staging host itself**                                            | Runs the fleet. Reachable. A foothold there is a foothold behind whatever the host can reach.                                                                               |
| 3   | **The fleet's own runtime secrets**                                    | Edge secret, internal service secret, database password, pay-rail keys. **Deliberately not in this workflow** (§2) — which is most of why it ranks third rather than first. |
| 4   | **The registry**                                                       | Can publish an image the host will run. Write is scoped to one job (§3).                                                                                                    |
| 5   | **The repository**                                                     | A token that can write `contents` or `actions` can change what the _next_ deploy does. Denied (§3).                                                                         |

### The trust boundaries, in one table

| Boundary                   | Trusted side                           | Untrusted side                                                                                            | What crosses it                        |
| -------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Dispatcher → workflow      | the `on:` block, the environment rules | the dispatcher's `confirm` and `image_digest` inputs, and **the dispatched ref's copy of this file** (§5) | two strings, both validated            |
| Runner → action code       | our steps                              | every third-party action, and its transitive dependencies                                                 | whatever the action chooses to do (§1) |
| `image` job → `deploy` job | —                                      | —                                                                                                         | two digests, shape-validated           |
| Runner → staging host      | our command                            | the host key presented on connect                                                                         | one ssh session (§7)                   |
| Host → registry            | —                                      | —                                                                                                         | an image pull, by digest (§6)          |
| Job log → the world        | —                                      | **this repository is public**                                                                             | anything a step prints (§4)            |

---

## 1 · A compromised action in the chain

**The claim being defended:** an action that runs in a job holding deploy credentials can do anything that job can do — read every secret in that job's environment, exfiltrate them over the network, alter the artefact being deployed, and print nothing unusual in the log.

That is not a hypothetical class of bug. It is the _design_ of GitHub Actions: an action is arbitrary code, running in the job, with the job's environment. `tj-actions/changed-files` in March 2025 is the reference case — the upstream tags were repointed at a commit that dumped runner memory into the build log, and every workflow that referenced it by tag picked the new code up on the next run, with no diff in any consumer repository and no review anywhere.

### Why SHA pinning is the mitigation and not a nicety

A version tag is a **mutable pointer in someone else's repository**. `@v4` is a promise about semantics made by a person who can, at any time and for any reason including having their own account stolen, point it at different bytes. The review you did was of the bytes; the pin was of the name. Those are not the same object, and the gap between them is entirely under the upstream owner's control.

A 40-character commit SHA is content-addressed: it _is_ the bytes. Moving it is not a permission problem, it is a hash collision problem.

So: **every action reference in this workflow is a commit SHA**, with the human-readable version in a trailing comment. This matches what every other workflow in this repo already does and is not a new rule.

### And the stronger mitigation: there is almost no chain

`actions/checkout` is the **only** action this workflow uses, at the same commit every other workflow here already pins. Registry login, the image builds, the push, the ssh transport and the health assertion are the CLIs that are already on the runner.

This is deliberate, and it follows a posture this repo has already written down — `supply-chain.yml` says it outright: _"a workflow installed to reduce third-party trust should not begin by adding some"_, and `gitleaks.yml` uses the gitleaks binary rather than `gitleaks-action` for the same reason. The obvious alternatives were each rejected on this basis:

| Rejected                            | What it would have been given                                         |
| ----------------------------------- | --------------------------------------------------------------------- |
| `docker/build-push-action`          | a third party in the job that publishes the image the host will run   |
| `docker/login-action`               | a third party handling the registry credential                        |
| `appleboy/ssh-action` and relatives | **a third party handling the ssh private key and the remote command** |

The last one is the one that matters. The convenient way to write an ssh deploy step is to hand a stranger's JavaScript your private key.

### Residual risk, stated

Pinning `actions/checkout` to a SHA proves the bytes are the bytes. It does **not** prove the bytes are benign — nobody in this repo has read them, and the same is true of every other workflow here. Pinning converts "trusting a mutable pointer" into "trusting a fixed artefact once reviewed"; the review is still owed. It is also worth naming that `docker buildx` and `ssh` on the runner are GitHub's supply chain, not ours, and pinning cannot reach them at all.

---

## 2 · What the workflow's credentials can reach — and the secrets that are not there

The most important sentence in this document: **this workflow holds four transport credentials and not one credential that can move value.**

The fleet's own runtime secrets — `EDGE_PRINCIPAL_SECRET`, `INTERNAL_SERVICE_SECRET`, the database password, every pay-rail and wallet key — are **not** GitHub Actions secrets and are **not** passed by this workflow. They live in an owner-provisioned `.env` on the host, and `docker-compose.apps.yml` already refuses to start the fleet without them: `${EDGE_PRINCIPAL_SECRET:?missing …}` is a hard stop, not a default.

This is a design decision with a security consequence and it is worth being explicit about the alternative. The obvious way to write a deploy workflow is to make CI the source of truth for the environment: put all forty runtime values in GitHub secrets and have the deploy step write the `.env`. Do that and **this workflow becomes the most privileged object in the organisation** — a single file whose compromise yields every secret the platform has, reachable by anyone who can edit a workflow or slip a malicious action into any job of it.

Keeping it out means:

- doctrine §9 prefers a vault; the ADR permits Actions secrets for staging as a **named deviation**; and the deviation is held down to the transport, which is the smallest form it can take.
- a full compromise of this workflow yields **shell on staging** — which is bad, and is not the same as _disclosure of every fleet secret_. The blast radius is a host, not the platform.
- rotating a fleet secret does not touch GitHub at all.

### The four, and why each is a secret rather than a variable

`STAGING_SSH_HOST` · `STAGING_SSH_USER` · `STAGING_SSH_PRIVATE_KEY` · `STAGING_SSH_KNOWN_HOSTS`

Only the third is a credential in the strict sense. Host, user and host key are secrets anyway because **this repository is public** and there is no reason to publish the address of a machine running a pre-production copy of a money platform. Free reconnaissance is still reconnaissance.

They belong in **environment** secrets scoped to `staging`, not repository secrets. A repository secret is readable by every job in every workflow that names it; an environment secret is readable only by a job that declares `environment: staging` and has passed its protection rules. Same value, materially smaller surface.

### Fail loudly, never skip

An unset secret in GitHub Actions expands to the **empty string** — it does not error. That is how a deploy step "succeeds" against nothing, or brings up a fraction of a stack. So the deploy job's first step tests all four for emptiness and exits non-zero naming the missing variable, before the transport is configured and before anything is touched.

There is **no `:-` fallback anywhere in the file**, and this is the same rule `secret-scan.mjs` enforces on service configuration for the same reason: a value read from the environment _with no default_ means the thing refuses to start rather than starting against something you did not mean. A deploy that invents a default for a credential is a deploy against an unknown host.

Today, with no host and no secrets, this step is the workflow's entire observable behaviour: dispatch it and it stops here, naming what the owner has not provided. **That is the correct behaviour of this file today, not a stub.**

---

## 3 · What the workflow's token can do, and what it must not

`permissions: {}` at the top of the file. That is a deny-all: the `GITHUB_TOKEN` gets no scopes, and every job must name what it needs. Without that line the token inherits the repository default, which is frequently still read/write across contents, packages, issues, pull requests and deployments — a set of powers a deploy has no use for and an attacker has a great deal of use for.

| Job         | Scopes                              | Why                                                               |
| ----------- | ----------------------------------- | ----------------------------------------------------------------- |
| `preflight` | `contents: read`                    | reads the tree, checks ancestry. Holds no credential of any kind. |
| `image`     | `contents: read`, `packages: write` | builds and pushes. **Holds no staging credential.**               |
| `deploy`    | `contents: read`                    | reads the tree, then talks to the host. **Publishes nothing.**    |

### The split is the control

`packages: write` exists on `image`, which cannot reach the host. The staging secrets exist on `deploy`, which cannot publish an image. Neither job can do both halves of "build a malicious image and put it on the host". A compromise of the build step gets a registry that is world-readable on a public repo anyway, and no key.

### What is deliberately absent from `deploy`

Naming these is the point of the section, because each is an escalation that a plausible-looking one-line diff would grant:

| Not granted                                 | What granting it would allow                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `contents: write`                           | push a commit, move a tag. A deploy that can write the repo can arrange its own next input.                                    |
| `actions: write`                            | **rewrite this workflow.** The single worst one: it makes every control in this file advisory.                                 |
| `packages: write`                           | replace the image after it was built and verified.                                                                             |
| `id-token: write`                           | mint an OIDC identity and exchange it with a cloud provider — an authentication path that does not appear in this file at all. |
| `deployments: write`, `environments: write` | write deployment status; in general, touch the protection machinery that is the attended gate.                                 |

### What no scope can reach

`GITHUB_TOKEN` cannot read the repository's secrets, cannot alter environment protection rules, and cannot approve its own deployment. Those are owner powers and stay owner powers regardless of what any workflow file says.

---

## 4 · Log exposure — a deploy that prints a secret has published it

**This repository is public. Its Actions logs are world-readable.** Anyone, unauthenticated, can open a run and read every line every step printed. Treat the log as a publication channel, because that is what it is.

GitHub masks known secret values in log output. **Do not design around that.** Masking is a string match on the exact value, and it loses to every transformation: base64, a value split across two lines, JSON-escaped, hex, a value substring, and — the common one — a secret that arrived from somewhere GitHub was never told was a secret, such as a value read out of the host's `.env` over ssh.

### The specific ways this workflow could have leaked, and what stops each

| The way                                                 | Stopped by                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `env` / `printenv` / `set -x` in a step holding secrets | no step does either; the secret-bearing steps are short and explicit                                                                                                                                                                                                                                                           |
| `docker compose config` on the host                     | **removed on purpose.** It renders the _fully resolved_ fleet configuration — every interpolated `${VAR}`, i.e. every fleet secret — and it was in an earlier draft of this file as an `APP_ENV` cross-check. One stray `set -x` from the job log. The comment in the workflow says so at the call site that no longer exists. |
| `docker login -p "$TOKEN"`                              | `--password-stdin`, so the credential is never an argument in a process list or a trace                                                                                                                                                                                                                                        |
| the private key in a step argument                      | written to a file under `RUNNER_TEMP` at `0600`, referenced as `-i <path>`. Under `RUNNER_TEMP` and **not** the workspace, so a later step that archives or uploads the checkout cannot sweep it up.                                                                                                                           |
| the key surviving the job                               | `rm -rf` in an `if: always()` step                                                                                                                                                                                                                                                                                             |
| presence checks printing the value                      | the check prints the **name** only, and tests with `-z`                                                                                                                                                                                                                                                                        |
| a remote command echoing the environment                | the remote heredocs print status lines and container states, never variables                                                                                                                                                                                                                                                   |

### Consistency with existing doctrine, which is the point

This is the same rule `OWNER-ACTIONS-WALLET-RPC-SECRETS.md` is built on, applied to a different channel. That page's central finding is that **disclosure is irreversible**: _"a committed secret is disclosed forever by git history. Rewriting history does not help… The only remedy that works is to make the value useless."_

A secret in a public Actions log is the same object. Deleting the log does not undo it — it was readable, it is cached, and it may be mirrored. **The remedy is rotation, and rotation is Class X: it needs a human with authority over the account.** So a leaked staging key is not an agent's incident to close, and the file it would be recorded against is `docs/BOARD-CLEAR-HUMAN-BLOCKERS.md`, per the ADR.

And the corollary from the same page, which is why the four secrets in §2 have no values in this repository and were not generated by anybody writing this workflow: **"A key that an agent generated is a key an agent had."**

---

## 5 · How a fork or an untrusted branch could reach a dispatch

### Forks cannot. Structurally.

| Trigger               | Fork-reachable?                                                                                                                     | Present?           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `pull_request`        | runs against the fork's code, but with a **read-only** token and **no** access to secrets or environments                           | no                 |
| `pull_request_target` | runs with a **privileged** token and **can** see secrets, against a base-branch workflow — the classic privilege-escalation trigger | **no, and never**  |
| `workflow_dispatch`   | requires **write** permission on this repository. A fork has none. There is no unauthenticated path to it.                          | yes, and only this |
| `push` / `schedule`   | unattended                                                                                                                          | **no** — ADR G5    |
| `repository_dispatch` | needs a token with write; a leaked PAT reaches it                                                                                   | no                 |

So the fork question has a short answer: **the only trigger present is one a fork cannot reach**, and the two triggers that have historically leaked secrets to fork-controlled code (`pull_request_target`, and `pull_request` combined with an untrusted checkout) are absent.

The `no-unattended-trigger` step in `preflight` re-reads the `on:` block **from the checkout being deployed** on every run and fails if `push`, `schedule`, `pull_request`, `pull_request_target` or `repository_dispatch` has appeared. This was tested both ways: it passes on the file as committed, and fails with the ADR citation when a `push:` trigger is spliced in. A comment saying "no push trigger" is worth nothing against a future edit; a step that fails the run is worth something.

### Untrusted _branches_ are the real question, and the answer is partly uncomfortable

`workflow_dispatch` lets the dispatcher pick **any branch in this repository**. And under ADR condition **G5**, the operator and the agent swarm _share one GitHub identity_ — roughly sixty agent PRs a day merge under it. So "only a trusted human can dispatch" is not a claim this repo can make today. Anyone or anything holding that token can push a branch and dispatch it.

Two controls, and they are not equal.

**The in-file control: only merged commits may be deployed.** `preflight` fails unless the dispatched commit is an ancestor of `origin/main`. A branch pushed five seconds ago cannot reach the host even from an identity allowed to dispatch, because its _content_ never went through a pull request. This is deliberately stricter than the ADR requires.

**The honest limitation, which must not be buried:** for `workflow_dispatch`, GitHub runs **the dispatched ref's copy of the workflow file**. So an actor who can push a branch can push a branch _in which the ancestry check has been deleted_, and dispatch that. **Every control written in this file can be edited away by anyone who can dispatch it.** The trigger self-check has the same hole — it reads the file it was edited in.

That is not a flaw to be fixed inside the file, because it cannot be. It is the reason the real control lives outside:

**The control that cannot be edited away: environment protection rules.** `deploy` declares `environment: staging`. Deployment branch rules, required reviewers and wait timers are **environment settings held in repository configuration**, and no workflow file can grant itself an exemption. With the environment restricted to `main` and reviewers attached, a modified branch's `deploy` job never receives the secrets at all — the branch rule is evaluated before the job runs, by GitHub, outside the file.

So the layering is: **environment rules are the security boundary; the in-file checks are defence in depth that catches mistakes and makes a malicious edit show up as a diff.** Stated in that order because the reverse would be a false claim.

> **⚠ OWNER, AND CURRENTLY UNTRUE:** the `staging` environment **does not exist**. Until it is created and given a `main`-only deployment branch rule plus required reviewers, `environment: staging` is an unprotected label, and the only thing making this workflow attended is that a human has to click Run. **This is the single highest-value action on the list in §9**, and an agent may not do it.

### Input handling

Two inputs cross the boundary, and both are attacker-controlled if the dispatcher is.

- `confirm` — must equal `deploy-staging` exactly. Not a security control; a control against the wrong button.
- `image_digest` — interpolated into a command that runs **on the staging host**, so it is validated against `^sha256:[0-9a-f]{64}$` before use. Anything else aborts.

Neither is interpolated into a shell script as `${{ }}`. **Every** `${{ }}` value in this workflow is bound to an environment variable and referenced as `"$VAR"`. `${{ }}` is substituted as _text_ before the shell parses the line, so a value containing `"; curl …` becomes a command rather than a string — the standard Actions script-injection vector. Some of the interpolated values here (`github.repository`, `github.actor`, a resolved SHA) are constrained by GitHub and would have been safe inline; binding all of them uniformly means the claim can be made about the whole file rather than checked value by value, and stays true when someone adds a step.

---

## 6 · The registry, and the unqualified image name

`docker-compose.apps.yml` names `intafaced/app:dev`. That reference is **unqualified**, and docker resolves unqualified names against **Docker Hub** — `docker.io/intafaced/app:dev`. Nobody in this project controls that namespace.

Which means: if that tag is absent locally when `docker compose up` runs, compose will helpfully fetch it from whoever has registered the name, and start the fleet from a stranger's image. Nothing about the compose file, the log, or the deploy would look wrong. This is namesquatting, and it is a real and quiet way to own a host.

**The ordering in the deploy step is the mitigation, and it is load-bearing rather than tidy:**

1. `docker pull ghcr.io/<repo>/app@sha256:…` — the immutable digest, from a registry derived from `github.repository`. A digest is the bytes; a tag can be moved to different bytes after review.
2. `docker tag` it to `intafaced/app:dev`, so the name compose wants is **never missing**, so compose never goes looking for it.
3. `docker image inspect` and **assert** the local tag resolves to the digest that was pulled, refusing to start if not. This is the step that turns the mitigation from a hope into a check.
4. `docker compose up -d --no-build` — so a missing image can never silently become a rebuild from whatever source happens to be on the host's disk.

Both images are handled this way: the shared monorepo runtime, and the vendored trading shell, which is Vue 2.5 / webpack 3 with its own lockfile and its own Dockerfile deliberately outside the pnpm workspace.

Residual, stated: the infrastructure images in `docker-compose.yml` (Postgres, Redis, NATS, Grafana and friends) are pulled by tag, not digest, and this workflow does not change that. It is a pre-existing property of the deployment unit, it is the same on every developer's laptop, and quietly re-pinning the fleet's infrastructure from inside a deploy PR would be a change to something another lane owns. Named, not fixed. `litellm` is already pinned by digest, so the pattern exists in the file if someone wants to finish it.

---

## 7 · The transport

`ssh`, with a key written at `0600` under `RUNNER_TEMP`, and:

`-o StrictHostKeyChecking=yes` · `-o UserKnownHostsFile=<the secret>` · `-o IdentitiesOnly=yes` · `-o BatchMode=yes`

**`StrictHostKeyChecking=no` does not appear in this file, and that is the whole point of the paragraph.** It is what almost every deploy snippet on the internet does, because it makes the first run work. What it means is: _hand the private key and the deploy to whatever machine answers on that address._ DNS is not an authentication mechanism, and neither is an IP. That is a man-in-the-middle with no detection and no log line.

So `STAGING_SSH_KNOWN_HOSTS` is a **required** secret and the run fails without it. The owner has to capture the host key once, out of band, which is the cost of the control and is the correct cost.

`IdentitiesOnly=yes` stops ssh offering any other key the agent happens to hold. `BatchMode=yes` makes it fail rather than block on a prompt, so a misconfiguration is a red job and not a job that hangs until the timeout.

**Rejected: `StrictHostKeyChecking=accept-new`.** It is the tempting middle option and it is trust-on-first-use — it authenticates whoever gets there first. On a host that has not been created yet, "first" is a race an attacker can enter.

### What the workflow sends, and what it does not

`rsync` of `docker-compose.yml`, `docker-compose.apps.yml` and `tooling/infra/` — the compose files plus exactly the paths they bind-mount (`postgres-init`, the otel collector config, tempo, prometheus, the grafana provisioning tree). `preflight` fails if any of them has moved, so that is discovered before the transport rather than halfway through it.

**Not the repository.** The images carry the application. Rsyncing a checkout onto a host is how a stale file becomes authoritative, and it would put the whole tree — including `vendor/` — on a machine that has no use for it.

Which connects to a hard existing rule: `docs/OWNER-ACTIONS-WALLET-RPC-SECRETS.md` **§A4** says do not deploy `01_wallet_rpc` against real value; it has never been compiled, ships 31 unverifiable jars, and signs withdrawals with no chain id so a testnet signature is also a valid mainnet one. `wallet-rpc-mainnet-scan.mjs` rule **M7** makes that executable: _no workflow step may build or boot a module there_, and rule **M6** says the same for compose. This workflow deploys the compose fleet, which defines no such service, and mentions neither the tree nor Maven. The gate proves that on every CI run rather than leaving it to this paragraph — which is the right arrangement, because a paragraph is not a control.

---

## 8 · Partial failure — and yes, a half-deployed stack is worse than a failed one

The question in the brief deserves a direct answer: **a half-deployed staging stack is worse than a failed deploy, and the reason is the migration.**

`docker-compose.apps.yml` runs a `migrate` service that executes every service's `db:migrate` and exits; everything with a schema waits on `service_completed_successfully`. So the ordering is: **the schema moves first, then services start.** By the time a service can fail to come up, the database has already changed.

That single fact drives the three decisions below.

### Why there is no automatic rollback

Re-pointing containers at the previous image does **not** un-apply a migration. It runs last week's code against this week's schema. The failure modes are worse than the one being recovered from and much quieter: a column the old code does not know about, a constraint it violates on write, a table it reads with the wrong shape. On a platform whose §0.6 rule is that no module holds its own balance, the shape of a ledger table is not a detail.

So on failure the workflow **stops, says so, and leaves the stack where it stopped**, with an explicit error naming what was _not_ rolled back. Rollback stays a deliberate re-dispatch with `image_digest`, by a human who has decided the schema tolerates it. An automatic rollback here would be a machine making a schema-compatibility judgement it cannot make.

### Why `cancel-in-progress: false`

Every other workflow in this repo uses `cancel-in-progress: true`, which is right for a check: cancelling a stale CI run costs a re-run. Cancelling a **deploy** halfway leaves migrations applied, some containers on the new image and some on the old, and no record of which. Making the second dispatcher wait is strictly cheaper.

### Why the concurrency group is a constant

`${{ github.workflow }}-${{ github.ref }}` — the group the rest of the repo uses — is _wrong here_, and subtly so. Two dispatches on two different refs land in two different groups and therefore **run at the same time**, against one host, racing over the same containers and the same database. Two concurrent `migrate` containers against one Postgres is a genuinely bad afternoon. The group is the constant `staging-deploy`, so there is one deploy at a time regardless of ref.

### Health is asserted rather than assumed

`compose up -d` returns when containers are _created_, not when services answer. A deploy that reports success on container creation is the "route exists ≠ works" failure this repo has a doctrine section about. So the workflow polls container state and fails the job unless every container is `running`+`healthy`, `running` with no healthcheck, or `exited` with code **0**.

That last clause is the one that matters and it is why state is read with `docker inspect --format` over `compose ps -q` rather than `compose ps --format`: `migrate` is _supposed_ to exit, and it is supposed to exit **zero**. "Exited" alone cannot distinguish a completed migration from a failed one, and a failed migration that reads as success is the worst outcome this step can produce. Compose only promises `table` and `json` for `ps --format`, and `json` would need `jq` on the host, which this workflow does not get to assume. The classifier was executed against fixtures covering a healthy service, a service with no healthcheck, `migrate` exited 0, **`migrate` exited 1**, an unhealthy service, a starting service and a crash-looping one; each landed in the right bucket.

### Residual, stated plainly

There is **no pre-deploy database backup** and this workflow does not take one, because a backup policy on a host that does not exist is an invented answer — retention, location and whether staging data is disposable are owner decisions (§9). Until one exists, a failed migration on staging is recovered by rebuilding staging. That is tolerable for staging and would **not** be tolerable for production, which is a §1 Kubernetes path this workflow does not touch.

---

## 9 · What this workflow deliberately cannot do, and who owns each

The most useful section, because everything here is a place where an agent could have invented an answer and did not.

| #   | Cannot                                                   | Why                                                                                                                                                                                                                                                                                                                                                                                                             | Owner                                                 |
| --- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | **Deploy without a human**                               | no `push`, no `schedule`; self-checked each run                                                                                                                                                                                                                                                                                                                                                                 | by design — ADR G5                                    |
| 2   | **Deploy production**                                    | staging only; prod is the §1 Kubernetes path and is not referenced                                                                                                                                                                                                                                                                                                                                              | Nitro / Class X                                       |
| 3   | **Create or provision the host**                         | host purchase is Class X money; the ADR does not buy a host                                                                                                                                                                                                                                                                                                                                                     | **Nitro (Class X)**                                   |
| 4   | **Create any secret value**                              | none appear, none were generated. _"A key that an agent generated is a key an agent had."_                                                                                                                                                                                                                                                                                                                      | **Nitro (Class X2)**                                  |
| 5   | **Create the `staging` environment or attach reviewers** | environment protection is repository configuration, not a file                                                                                                                                                                                                                                                                                                                                                  | **Nitro — highest-value open item (§5)**              |
| 6   | **Set branch protection on `main` (G1)**                 | ADR flip condition for reconsidering merge-to-staging                                                                                                                                                                                                                                                                                                                                                           | Nitro                                                 |
| 7   | **Rotate a leaked credential**                           | rotation is an act on a live system needing a wallet or a vendor login                                                                                                                                                                                                                                                                                                                                          | **Nitro — see `OWNER-ACTIONS-WALLET-RPC-SECRETS.md`** |
| 8   | **Weaken `APP_ENV`**                                     | `APP_ENV=staging` is exported into the remote shell, where compose gives shell env precedence over `.env`, and asserted. Sanctions screening and pay-rail sandbox rules that refuse to boot without their blocklists stay enforced. ADR: setting `APP_ENV=dev` to force a boot is forbidden. `INTERNAL_SERVICE_BODY_BIND=require` is forced the same way (#4701 refuses any other value in production posture). | by design                                             |
| 9   | **Reach the fleet's runtime secrets**                    | not passed, not stored here; owner-provisioned `.env` behind `${VAR:?}` guards                                                                                                                                                                                                                                                                                                                                  | Nitro provisions                                      |
| 10  | **Build or boot `01_wallet_rpc`**                        | §A4; enforced by `wallet-rpc-mainnet-scan` M6/M7, not by this document                                                                                                                                                                                                                                                                                                                                          | Nitro + security review                               |
| 11  | **Deploy an unmerged commit**                            | ancestry check — subject to the §5 limitation                                                                                                                                                                                                                                                                                                                                                                   | by design                                             |
| 12  | **Publish from the deploy job**                          | `contents: read` only                                                                                                                                                                                                                                                                                                                                                                                           | by design                                             |
| 13  | **Rewrite itself or the repo**                           | no `contents: write`, no `actions: write`                                                                                                                                                                                                                                                                                                                                                                       | by design                                             |
| 14  | **Act as a kill switch**                                 | ADR: rollback is not a §14.6 kill switch; that is a separate lever                                                                                                                                                                                                                                                                                                                                              | `OPS-KILL-SWITCH-RUNBOOK.md`                          |
| 15  | **Take or restore a database backup**                    | no retention policy exists to implement                                                                                                                                                                                                                                                                                                                                                                         | **Nitro (§8)**                                        |
| 16  | **Roll the vendored shell back**                         | one digest input cannot name two images; guessing the matching shell digest gives you a shell and an API from different commits                                                                                                                                                                                                                                                                                 | by design; warned in the log                          |

### Named gaps — owner decisions this PR refused to invent

Per the brief: a workflow with a named gap beats one with an invented answer.

| #      | Decision                                                                                                                                                                                                                                                                                                 | Why it is not an agent's                                                                                                                      | Consequence today                                                                                                                                                                   |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** | **Create the `staging` environment; attach required reviewers and a `main`-only branch rule.**                                                                                                                                                                                                           | repository configuration; it is the only control a workflow edit cannot bypass (§5)                                                           | the attended gate is a human clicking Run, and nothing more                                                                                                                         |
| **D2** | **GHCR package visibility, and how the host authenticates to pull.** Public package → the host pulls anonymously and the workflow needs nothing more. Private → the host needs its own **read-only** registry credential, provisioned out of band.                                                       | it is a disclosure decision, and inventing a fifth secret name for a design that may not need one adds a required secret that fails every run | the deploy assumes the host can pull. If the package is private, step "Pull, verify and start" fails on the host with a docker auth error — loudly, which is the acceptable failure |
| **D3** | **Does staging share any secret with production?** The recommendation is a flat **no**, and it is a recommendation, not a ruling. A shared value makes a staging host — lower-hardened, more people, more agents — a production credential store, and every §4 disclosure becomes a production incident. | it is a doctrine ruling about the fiat plane                                                                                                  | unresolved. The workflow neither implements nor prevents sharing, because it holds no fleet secret at all (§2)                                                                      |
| **D4** | **Backup / retention before a migration runs** (§8)                                                                                                                                                                                                                                                      | needs a host, a storage location and a data-sensitivity call                                                                                  | no backup is taken                                                                                                                                                                  |
| **D5** | **Whether the ancestry restriction should be relaxed** to allow a feature branch on staging                                                                                                                                                                                                              | a product-velocity call with a security cost; it should not be relaxed before **D1**                                                          | main-only                                                                                                                                                                           |
| **D6** | **Vault for staging secrets**, retiring the Actions-secrets deviation                                                                                                                                                                                                                                    | ADR flip condition                                                                                                                            | four Actions secrets, deviation named                                                                                                                                               |

---

## 10 · Review triggers

Not "living document" as a decoration. Re-read this page when any of the following happens, because each invalidates something asserted above:

| Event                                    | What it invalidates                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| the host is purchased                    | §7, §8 — everything untestable becomes testable, and untested becomes negligent |
| the `staging` environment is created     | §5's warning, D1                                                                |
| any trigger is added to the workflow     | §5 entirely                                                                     |
| any action is added                      | §1 — the "almost no chain" claim                                                |
| a fleet secret moves into GitHub Actions | §2 — the central claim of this document                                         |
| `permissions:` gains a scope             | §3                                                                              |
| branch protection G1 lands               | ADR flip condition; §5, D5                                                      |
| a secret appears in a log                | §4 → rotation, Class X, `BOARD-CLEAR-HUMAN-BLOCKERS.md`                         |
| production deploy is designed            | out of scope here; §1 Kubernetes path                                           |

---

## 11 · What is proven, and what is not

Because the difference is the only part of a threat model that can be dishonest.

**Checked mechanically:**

- `actionlint` 1.7.7 — clean on this workflow and on all six pre-existing ones.
- All 15 embedded `run` scripts pass `bash -n`.
- The `no-unattended-trigger` step: passes on the committed file; **fails** when a `push:` trigger is spliced in. Both directions executed.
- The container-state classifier: seven fixtures, including a **failed `migrate`**, each classified correctly.
- `secret-scan`, `secret-scan` mutation suite (13/13), `gitleaks`, `pnpm format:check`, and the full doctrine gate list.

**Reasoned, not executed:** every claim about what happens on a staging host. There is no host.

**Not verified at all, and stated as such:**

- **No deploy has ever run.** Not once, not against a test host.
- `shellcheck` is not installed on this machine, so `actionlint`'s shell-linting integration did not run. Bash syntax was checked; shell _semantics_ were not.
- The remote commands have never executed on any machine. `docker compose up --no-build`, the `docker inspect` templates and the rsync layout are read from documentation and from this repo's own compose files, not from a run.
- GHCR has never been pushed to from this repository.
- Nothing here is production-ready, and this workflow is not a production deploy path.

The honest summary: **this is a reviewable, gate-clean, statically-validated workflow and its threat model. It is not a working deploy, and it must not be described as one until someone has dispatched it against a real host and read the log.**
