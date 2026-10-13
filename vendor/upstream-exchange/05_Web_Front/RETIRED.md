# RETIRED: legacy Vue customer site

**Status:** retired as of 2026-10-13, by Nitro's decision.

This directory is the old Vue 2 customer site. It was replaced by the React customer app, `apps/customer` (#4511). The code stays in the tree for reference. The site itself is no longer built or deployed, and no longer served.

## What stopped

- **Staging build and deploy.** `.github/workflows/staging-deploy.yml` no longer builds this directory. The `vendor-shell` image slot now builds `apps/customer/Dockerfile`.
- **Compose.** `docker-compose.apps.yml` already served `apps/customer` in the `vendor-shell` slot on :8090. Nothing here is served.
- **Doctrine gates (`pnpm gates`).** `shell-i18n`, `shell-golden`, `fabricated-money` and `lang-duplicate-key` were deleted. `shell-brand` and `marketing-language` no longer walk this directory. `brand` walks it only for the six files below.

## What still ships from this tree

The public invitation app (`apps/invitation`) still bundles six JavaScript modules from `src/` here (aliased in `apps/invitation/vite.config.ts`):

- `assets/js/outreach-intake.js`
- `assets/js/outreach-review.js`
- `assets/js/outreach-public-info.js`
- `assets/js/outreach-draft-storage.js`
- `assets/js/outreach-countries.js`
- `config/intafaced.js`

It also imports images and fonts from `src/assets/`.

Gates that still cover them:

- `invitation-outreach-golden` runs the golden tests next to the modules (`outreach-intake`, `outreach-review`, `outreach-draft-storage`) and fails if it finds none.
- `brand` scans exactly those six files.
- `vendor-shell` (hazard scan over all of `vendor/`) and `secrets` still read this tree.

## Other things that depend on it

- `NOTICE` records third-party licences for files under this directory.
- `tooling/uiproof/dod-gate.mjs` and a few `tooling/` scripts still name files here as evidence.

Do not delete the directory without moving the six modules out first. Deleting the tree is a separate decision, not part of the retirement.
