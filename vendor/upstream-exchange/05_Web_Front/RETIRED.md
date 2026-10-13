# RETIRED: legacy Vue customer site

**Status:** retired as of 2026-10-13, by Nitro's decision.

This directory is the old Vue 2 customer site. It was replaced by the React customer app, `apps/customer` (#4511). The code stays in the tree for reference only. It is not built, deployed or gated any more.

## What stopped

- **Staging build and deploy.** `.github/workflows/staging-deploy.yml` no longer builds this directory. The `vendor-shell` image slot now builds `apps/customer/Dockerfile`.
- **Compose.** `docker-compose.apps.yml` already served `apps/customer` in the `vendor-shell` slot on :8090. Nothing here is served.
- **Doctrine gates (`pnpm gates`).** `shell-i18n`, `shell-golden`, `fabricated-money` and `lang-duplicate-key` were deleted. `shell-brand`, `brand` and `marketing-language` were narrowed so they no longer walk this directory.

## What still depends on this tree

Do not delete the directory without moving these first:

- `apps/invitation` imports images and fonts from `src/assets/` here (see `apps/invitation/vite.config.ts`).
- `NOTICE` records third-party licences for files under this directory.
- `tooling/uiproof/dod-gate.mjs` and a few `tooling/` scripts still name files here as evidence.

Deleting the tree is a separate decision, not part of the retirement.
