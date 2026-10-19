# ADR: audited / insured / guaranteed — owner seal or ban

**Status:** **Accepted — 2026-08-16 (D26-P0-16 sealed).**  
**Decision owner:** repo owner (Denon). **Written by:** Denon.  
**Board:** D26-P0-16 — “Audited / insured / guaranteed” language ban surface.  
**Packet:** `OWNER-DECISION-PACKET-PART-TWO-2026-08-09.md` (removed) §P0-16.  
**Law:** `DIRECTION-2026-07-31.md` (removed) §8.9.  
**Gate:** [`tooling/ci/marketing-language-scan.mjs`](../../tooling/ci/marketing-language-scan.mjs) (`packages/config/src/marketing-language.ts`).  
**Does not invent:** that any product, fund, deposit, contract, or yield is audited, insured, or guaranteed.

---

## The decision

> **Product copy may not describe anything to a user as audited, insured, or guaranteed unless that line (or the line immediately above) carries `OWNER-SEAL(§8.9)`. The default is a ban. The gate is the proof. This seal is not an audit, not an insurance policy, and not a yield guarantee.**

This is settled. Agents do not write those words into user-facing copy to make a screen look finished.

---

## Why this ADR exists

#1749 already landed the scan. The packet row still pointed at the open-shape human packet, so a later craft PR could treat D26-P0-16 as “gate exists, invent the claim.” The owner seal is: **words stay banned until a real owner line is sealed**; the machine check is `marketing-language-scan`.

Honest negation and status fields stay allowed (`not audited`, `audited: false`, i18n keys that only _label_ the honesty field). Affirmative copy (`fully audited`, `insured deposits`, `guaranteed yield`) without the marker is refuse.

---

## What is sealed

1. **Ban + seal.** DIRECTION §8.9 is product law. `OWNER-SEAL(§8.9)` on the claim line or the previous line is the only exception the gate honours.
2. **Where it walks.** Locale catalogues: `packages/i18n`, vendor shell `05_Web_Front/src/assets/lang`, vendor admin `04_Web_Admin/src/locale` (the tree that actually exists; `assets/lang` under admin is also walked if present). Not every TypeScript comment that says “guaranteed by the primary key.”
3. **No invented claim.** Sealing this row does not assert an audit happened, that deposits are insured, or that returns are guaranteed. P0-17 (insurance _fund_ listing) is a different ruling and is not marketing copy.
4. **Vue leftover stays HUMAN.** Hardcoded strings under `nitro-frontend-all` are not rewritten here. The scan reads catalogues; it does not craft Vue.

---

## What remains residual (not this PR)

- Vue / shell craft that still says the words in comments or unkeyed copy — `nitro-frontend-all` (HUMAN).
- A real insurance policy, auditor engagement, or licence statement — Class X (Nitro human + counsel). Do not paste a partner insurer into product copy.
- Dual-edit of `shell-brand-scan.mjs` — sibling #2016 (D26-P2-14).

---

## What agents may do without asking again

- Keep the marketing-language gate green. Extend the walk only when a **locale catalogue** tree is skipped.
- Rewrite unsealed affirmative copy to honest negation, or drop the ban word.

## What agents must not do

- Add `OWNER-SEAL(§8.9)` to invent an audit, insurance, or guarantee that does not exist.
- Mark a product “audited” / “insured” / “guaranteed” because a template key exists.
- Treat this ADR as permission to close Class X insurance or counsel work.
