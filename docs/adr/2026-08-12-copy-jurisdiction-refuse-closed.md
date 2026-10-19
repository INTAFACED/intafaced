# ADR: copy served-jurisdiction list — refuse-closed until the owner publishes

**Status:** **Accepted — 2026-08-12 (mechanism).** Seals refuse-closed **shape**. **2026-08-15:** the 2026-08-14 “owner published allowlist” note is **withdrawn as product law** — copy geo stays refuse-closed in all regions until a **counsel-supplied** list exists. See [`2026-08-15-copy-jurisdiction-refuse-closed.md`](2026-08-15-copy-jurisdiction-refuse-closed.md) (D26-P0-15 content seal · `CLASS-X-SANCTIONS`).
**Decision owner:** repo owner. **Written by:** Denon.
**Law:** `DIRECTION-2026-07-31.md` (removed) §8 item 10; `SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md` (removed) (served-jurisdiction answer); `OWNER-DECISION-PACKET-2026-08-09.md` (removed) §A3.
**Board:** `trade.copy` · D26-P0-15 on `DENON-HARD-PARALLEL-BOARD-2026-08-09.md` (removed).
**Code:** `services/svc-trade/src/copy/` — `TRADE_COPY_JURISDICTION_LAW` · `trade.copy_jurisdiction_blank` · `trade.copy_jurisdiction_blocked`.

---

## The decision

> **There is no in-repo default geo allowlist baked into source.** Follow is refuse-closed until counsel supplies a served-jurisdiction list and it is published as `TRADE_COPY_JURISDICTION_LAW`. A 2026-08-14 example array is **not** that list (`CLASS-X-SANCTIONS`). Compose has no default. Blank host stays refuse-closed. Agents must not author or grow a country table.

This is the same shape already Accepted for `leader_share_bps`: unset is not zero and not a placeholder — it is a closed door that says why.

---

## Why this is a ruling, not a leftover

`SPEC-SOVEREIGN…` calls the jurisdiction answer **the single highest-leverage answer**. Serving copy into a region is a product/compliance act. An engineer-authored ISO list is counsel and owner content dressed as code. `OWNER-DECISIONS-OPEN.md` (removed) already closed the adjacent sanctions case the same way: **engineers do not draft jurisdiction lists**.

D26-P0-15’s done bar is **list or refuse-closed**. The owner has not published a list. Therefore the sealed answer is **refuse-closed**, with a single publish path when they do.

---

## What is sealed (agents implement; do not re-litigate)

1. **Blank / unpublished law → refuse.** Empty, whitespace, or `{ "published": false }` for `TRADE_COPY_JURISDICTION_LAW` yields unpublished law. `follow` throws `trade.copy_jurisdiction_blank` with `COPY_JURISDICTION_RESIDUAL`. No fallback region, no “world except sanctions,” no matrix borrow from `packages/config` business tiers.

2. **Published allowlist is owner-only content.** Shape:

   ```json
   { "published": true, "allowedRegions": ["…"] }
   ```

   Region codes are uppercase on parse. **No region string may be committed as a product default.** Test fixtures may use codes; production defaults may not.

3. **Published empty array = serve none.** `{ "published": true, "allowedRegions": [] }` is a deliberate owner “launch nowhere” — every follow fails `trade.copy_jurisdiction_blocked`. It is not an invitation to invent a seed list.

4. **Off-allowlist region → blocked, not blank.** When law is published, a follower region absent from the list refuses `trade.copy_jurisdiction_blocked`. Blank residual is only for unpublished law.

5. **Sanctions / business matrix are not this list.** `INTAFACED_SANCTIONS_REGIONS` and `JURISDICTION_MATRIX` stay their own authorities. Copy may not treat them as a substitute served-jurisdiction table.

---

## What remains owner-open (not inventable here)

- The actual region codes and the date they go live (publish via env / config authority, not source).
- Whether marketing may name those regions before the allowlist is live (honesty: no).
- Interaction with counsel sanctions content (Class X) — orthogonal; both can refuse.

`leader_share_bps` and other fee-share rates remain **D26-P0-02** / DIRECTION §8 — this ADR does not publish rates.

---

## What agents may do without asking again

- Keep and deepen refuse paths, desk status honesty, and tests that blank law never admits a follow.
- Wire `TRADE_COPY_JURISDICTION_LAW` from deploy config when the owner supplies JSON.
- Cite this ADR + residual string on any new copy entry that screens region.

## What agents must not do

- Commit a default `allowedRegions` array in env examples, compose, or source “for convenience.”
- Infer allowlist membership from KYC tier, shell locale, IP headers, or the business jurisdiction matrix.
- Mark `trade.copy` launch-complete while jurisdiction law is unpublished.

---

## Proof on tip

- Parser + require: `services/svc-trade/src/copy/fee-share-law.ts`
- Follow screen: `assertCopyRegionAllowed` in `follows.ts`
- Desk honesty: `CopyService.deskStatus()` reports `jurisdictionPublished: false` and names DIRECTION §8 residual when blank
- Env default: `TRADE_COPY_JURISDICTION_LAW` empty string → unpublished
