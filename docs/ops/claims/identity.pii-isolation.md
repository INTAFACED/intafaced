# Claim identity.pii-isolation

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** pr-open
**owner:** nitro-agent (ZenYoda3)
**branch:** feat/identity-kyc-vault-boot
**proof:** https://github.com/Phantom-X-007/intafaced/pull/2203
**updated:** 2026-08-16

Production-wire `bootKycVault(sql, env.IDENTITY_KYC_DOC_KEY)` on `svc-identity` index and spread vault into `createIdentityRouter` when the key parses. Missing key → vault null, document procedures named-refuse. Never invent a key. Live vendor webhook stays Class X.

**Scope:** `services/svc-identity/src/index.ts` · `services/svc-identity/src/kyc/boot-vault.reachable.test.ts` (+ this claim).
**Do not touch:** LIVE-LANES · features.mjs · compose restamp · #2032 `promise-falsify-public-doors.test.ts` · Vue / Shehzad chain · vendor webhooks.
