# ADR: copy geo stays refuse-closed until counsel supplies the list (D26-P0-15)

**Status:** **Accepted — 2026-08-15.** Seals **D26-P0-15** as **refuse-closed in all regions** until a **counsel-supplied** served-jurisdiction list exists. Supersedes the 2026-08-14 “owner published allowlist” note on [`2026-08-12-copy-jurisdiction-refuse-closed.md`](2026-08-12-copy-jurisdiction-refuse-closed.md). That earlier ADR’s **mechanism** (blank law refuses; no source default) still holds. The 2026-08-14 example array is **not** counsel law.
**Decision owner (list content):** Nitro + counsel — Class X (`CLASS-X-SANCTIONS`). Engineers never draft the list.
**Shape owner (this document):** Denon.
**Law:** `DIRECTION-2026-07-31.md` (removed) §8; `OWNER-DECISIONS-OPEN.md` (removed) §2 (engineers do not draft jurisdiction lists); `OWNER-DECISION-PACKET-2026-08-09.md` (removed) §A3 copy fee-share refuse pattern; packet index `CLASS-X-SANCTIONS` / `D26-P0-15` in [`ops/owner-ruling-packet.json`](../ops/owner-ruling-packet.json).
**Board:** `trade.copy` · D26-P0-15. Lane: `denon-d26-p0-15-copy-geo`.
**Code (cite only — this PR does not edit it):** `COPY_FEE_SHARE_RESIDUAL` / `COPY_JURISDICTION_RESIDUAL` in `services/svc-trade/src/copy/` — same refuse-closed shape as unset `leader_share_bps`.

---

## The decision

> **Copy trading stays refuse-closed in all regions until counsel supplies a served-jurisdiction list. Engineers never draft that list. There is no agent-authored country table.**

D26-P0-15’s done bar is **list or refuse-closed**. Counsel has not supplied a list (`CLASS-X-SANCTIONS` remains Class X). Therefore the sealed product answer is **refuse-closed everywhere**, not a seeded allowlist.

This is the copy fee-share residual pattern applied to geo: unset is not “world except a guessed blocklist,” not zero, and not a convenience array in an example file. A seeded list in-tree is indistinguishable from a decided one three months later — which is how an invented country table becomes policy nobody (and no counsel) chose.

---

## What is sealed

1. **All regions closed until counsel list.** Follow / copy geo screening stays refuse-closed for every region while no counsel-supplied list exists. Agents must not open a region by inventing membership.

2. **List content is Class X.** The served-jurisdiction table is counsel/Nitro (`CLASS-X-SANCTIONS`). Agents do not author ISO codes, “market-comp CEX copy” subsets, OFAC-shaped catalogues, or “not worldwide” stand-ins. Test fixtures may use placeholder codes; those fixtures are not product law.

3. **No agent-authored country table.** Do not commit a default `allowedRegions` array as product default in source, compose, or env examples “for convenience.” An example file that ships a country array is not a counsel list and must not be treated as published law.

4. **Fee-share residual is the model.** Same honesty as `COPY_FEE_SHARE_RESIDUAL`: blank DIRECTION §8 → refuse and name the residual (`COPY_JURISDICTION_RESIDUAL` / D26-P0-15). Do not borrow `INTAFACED_SANCTIONS_REGIONS` or the business jurisdiction matrix as a substitute served-copy table.

5. **Sanctions content stays separate and still Class X.** Mechanism for sanctions boot lists was already closed for engineering (`OWNER-DECISIONS-OPEN.md` (removed) §2). Copy geo does not fill that socket with craft.

---

## What remains owner-open (not inventable here)

- The actual counsel-supplied region set and the date it may go live (env / config authority after counsel, never source seed).
- Whether any region may be named in marketing before that list is live (honesty: no).
- `leader_share_bps` and other fee-share magnitudes — **D26-P0-02**, not this ADR.

---

## What agents must not do

- Draft or grow a country / ISO table for copy geo.
- Treat a prior `.env.example` array as counsel-supplied law.
- Edit `services/svc-trade/src/copy/**` in order to “complete” this ruling — the refuse-closed mechanism is already the product path; this ADR is the geo **content** seal.
- Mark `trade.copy` launch-complete on geo while the counsel list is absent.

---

## Leverage

Phase A IN: existing `svc-trade` copy refuse-closed shell + `ledger-client` fee-share when rates are published. Horizon: `trade.copy` is **LAW** until counsel list (Class X) — not greenfield geo. No Vue. No second SPA. No second money book.
