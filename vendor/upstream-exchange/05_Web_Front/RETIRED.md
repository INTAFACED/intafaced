# RETIRED: legacy Vue customer site

**Status:** retired as of 2026-10-13, by Nitro's decision.

This directory is the old Vue 2 customer site. It was replaced by the React customer app, `apps/customer` (#4511). The code stays in the tree for reference. The site itself is no longer built or deployed, and no longer served.

## What stopped

- **Staging build and deploy.** `.github/workflows/staging-deploy.yml` no longer builds this directory. The `vendor-shell` image slot now builds `apps/customer/Dockerfile`.
- **Compose.** `docker-compose.apps.yml` already served `apps/customer` in the `vendor-shell` slot on :8090. Nothing here is served.
- **Doctrine gates (`pnpm gates`).** `shell-i18n`, `shell-golden`, `fabricated-money` and `lang-duplicate-key` were deleted. `shell-brand` and `marketing-language` no longer walk this directory. `brand` no longer walks it.

## What no longer ships from this tree

The public invitation app (`apps/invitation`) no longer imports anything from this tree. It owns verbatim copies of what it used to bundle from here, under `apps/invitation/src/`:

- `assets/js/outreach-intake.js`, `outreach-review.js`, `outreach-public-info.js`, `outreach-draft-storage.js`, `outreach-countries.js`
- `assets/js/ix-wire.js` and `assets/js/auth-refusal.js` (required by the transport)
- `config/intafaced.js`
- the hero images, logo and Inter fonts under `assets/`

The three golden tests moved with them. The copies in this tree are now dead weight; deleting them is part of the separate repo move.

Gates that cover the copies:

- `invitation-outreach-golden` runs the golden tests in `apps/invitation/src/assets/js/` and fails if it finds none.
- `brand` reaches them through its ordinary walk of `apps/`; it no longer walks anything under this directory.
- `vendor-shell` (hazard scan over all of `vendor/`) and `secrets` still read this tree.

## Other things that depend on it

- `NOTICE` records third-party licences for files under this directory.
- `tooling/uiproof/dod-gate.mjs` and a few `tooling/` scripts still name files here as evidence.

The six modules have been moved out (see above). Deleting the tree is a separate decision, not part of the retirement.
