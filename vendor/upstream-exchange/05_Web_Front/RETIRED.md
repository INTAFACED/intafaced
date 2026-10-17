# RETIRED: legacy Vue customer site

**Status:** retired as of 2026-10-13, by Nitro's decision.

This directory is the old Vue 2 customer site. It was replaced by the React customer app, `apps/customer` (#4511). The code stays in the tree for reference. The site itself is no longer built or deployed, and no longer served.

## What stopped

- **Staging build and deploy.** `.github/workflows/staging-deploy.yml` no longer builds this directory. The `vendor-shell` image slot now builds `apps/customer/Dockerfile`.
- **Compose.** `docker-compose.apps.yml` already served `apps/customer` in the `vendor-shell` slot on :8090. Nothing here is served.
- **Doctrine gates (`pnpm gates`).** `shell-i18n`, `shell-golden`, `fabricated-money` and `lang-duplicate-key` were deleted. `shell-brand` and `marketing-language` no longer walk this directory. `brand` walks it only for the six files below.

## What moved out

On 2026-10-17 (decision D-135, vendor slim) the public invitation app (`apps/invitation`) took its six JavaScript modules, the two modules they need (`ix-wire.js`, `auth-refusal.js`), the golden tests, images and fonts into `apps/invitation/src/vendored/`. The `invitation-outreach-golden` and `brand` gates now read them there. Images, audio, tests and the Docker files were deleted from this tree; the pages, goldens and config stay only because `tooling/tracker/features.mjs`, `tooling/uiproof/` and `NOTICE` name them as evidence.

## Other things that depend on it

- `NOTICE` records third-party licences for files under this directory.
- `tooling/uiproof/dod-gate.mjs` and a few `tooling/` scripts still name files here as evidence.

Deleting the rest of the tree needs the tracker evidence and the uiproof scripts retired first.
