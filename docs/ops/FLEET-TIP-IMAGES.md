# Fleet tip images (D26-P2-04)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** law for the local and staging run path.  
**Board:** D26-P2-04 — running fleet = tip images.  
**Leverage:** existing `Dockerfile` + `docker-compose.apps.yml` (staging ADR: consume the unit; do not invent a second image strategy).  
**Proof:** `pnpm fleet:tip-images` (`tooling/scripts/fleet-tip-image.mjs`). Also ratcheted from `workspace-sync` so `pnpm verify` / CI gates see drift.

---

## The decision

> **The process that is running is the image built from the git tip you meant, or it is a refuse.** Hot-patching a container and calling `compose up` without `--build` is how yesterday's bytes keep taking money. Pulling the unqualified name `intafaced/app:dev` from Docker Hub because it was missing locally is how a stranger's image becomes the fleet.

Two run paths, one image unit:

| Path                        | Command                                                                                   | Why                                                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local / operator laptop** | `pnpm platform:up` → `docker compose -f docker-compose.apps.yml up -d --build`            | `--build` makes the shared `intafaced/app:dev` (and vendor-shell) from **this tree**.                                                                                   |
| **Staging host**            | Pull GHCR **digest** → `docker tag` to `intafaced/app:dev` → inspect → `up -d --no-build` | `--no-build` so a missing local image cannot rebuild from whatever happens to sit on the host disk. Digest is the bytes; the tag is only the name compose already uses. |

Neither path is “compose up and hope.” Neither path is a new Dockerfile kit, a second SPA image, or deploying `01_wallet_rpc`.

---

## Why `--build` locally and `--no-build` on staging are the same law

They look opposite. They answer the same question: **where do the bytes come from?**

- Locally the source of truth is **this checkout**. `--build` is how the fleet becomes tip.
- On staging the source of truth is **the digest the workflow pulled from GHCR**. `--no-build` is how the fleet stays that digest. Building on the host would silently replace reviewed bytes with whatever tree is on disk.

If you invert them you get the two failure modes this mountain exists to kill:

1. Local `up` without `--build` → stale layers, “I merged but the box didn’t.”
2. Staging `up` with `--build` (or Hub-pull of the unqualified name) → unreviewed or namesquatted bytes.

---

## The namesquatting trap (load-bearing)

`docker-compose.apps.yml` names `intafaced/app:dev`. That name is **unqualified**. Docker Hub is the default registry. This project does not control `docker.io/intafaced/app`.

If that tag is **absent locally**, `compose up` will fetch Hub. The log looks like a normal pull. The fleet is then not ours.

**Local mitigation:** `pnpm platform:up` always `--build`, so the name is created from this Dockerfile before compose needs it.

**Staging mitigation** (already in `.github/workflows/staging-deploy.yml`, threat model §6):

1. `docker pull ghcr.io/<repo>/app@sha256:…`
2. `docker tag` → `intafaced/app:dev` (name never missing → compose never searches Hub)
3. `docker image inspect` — local tag must be the pulled digest, else refuse
4. `docker compose -f docker-compose.apps.yml up -d --no-build`

Vendor shell is the same shape (`intafaced/vendor-shell:dev`), second image, still not a second strategy: its Dockerfile lives with the vendored tree because that lockfile is not the pnpm workspace.

---

## Operator runbook (local)

From a worktree on the tip you intend to run:

```bash
cp .env.example .env   # if you do not already have the two fleet secrets
pnpm platform:up       # MUST be --build. Do not invent a no-build alias for local.
pnpm platform:ps       # every svc-* / web / admin healthy; migrate Exited (0)
```

To throw away stale containers **and** rebuild:

```bash
pnpm platform:reset    # down -v, then up -d --build
```

Do **not**:

- `docker compose -f docker-compose.apps.yml up -d` without `--build` as the everyday command
- `docker pull intafaced/app:dev` from Hub to “save a build”
- retag a random local image as `intafaced/app:dev` and `up --no-build` on a laptop
- add a second monorepo runtime Dockerfile / compose stack for “the real fleet”
- bring `01_wallet_rpc` into this compose file

Workspace packages stay in the image via Dockerfile COPY + `tooling/ci/workspace-sync.mjs`. If you add a service and skip compose or COPY, that gate already fails — this mountain does not replace it.

---

## Proof

```bash
pnpm fleet:tip-images
```

Fails if `platform:up` loses `--build`, if the compose `x-app` image is no longer `intafaced/app:dev` with `dockerfile: Dockerfile`, or if staging’s remote `up` is no longer `--no-build` after the digest tag.

---

## What this does not do

- Buy or SSH to a staging host (Class X).
- Pin infra images in `docker-compose.yml` by digest (named residual in the staging threat model).
- Claim the running laptop already matches origin/main — you still have to `platform:up` after fetch.
