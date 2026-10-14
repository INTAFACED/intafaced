# ADR: PKT-C9 — four token magnitudes remain owner-only and unset

**Status:** accepted  
**Status note:** **Accepted — 2026-08-15.** Owner decision, stated.
**Decision owner:** repo owner (Nitro publishes magnitudes). **Written by:** Denon.
**Packet id:** PKT-C9.
**Cites (does not rewrite):** [`2026-08-04-token-economics-outcomes.md`](2026-08-04-token-economics-outcomes.md) (D-S-14 — whose the numbers are; no figure).
**Distinct from:** D26-P0-04 (authority store + seed↔DB drift + claim-before-burn). That sitting is already on tip. **This ADR does not re-open or rewrite it.**
**Does not invent:** bps, supply cap, epoch reward, APY, burn split, lock multipliers, or any other magnitude.
**Does not edit:** `services/svc-token`, Vue, P0-04 packet/ADR files.

---

## The decision

> **The four token parameter families — emission, buyback, burn, staking — stay owner-only. All four magnitudes are unset. Unset means refuse-closed. Agents never seed numbers.**

D-S-14 already decided **whose** they are (the owner, via `token_params`) and **deliberately decided no number**. PKT-C9 seals the remaining product question: may an agent fill a figure so a surface can go live? **No.** A missing magnitude is not a placeholder, a zero, a dash, or a copy of a source constant.

---

## The four named params (all unset)

These are families, not a licence to invent the sub-fields D-S-14 enumerated. No value is published here.

| Named param  | Status    | What refuse-closed means until the owner writes `token_params`                                    |
| ------------ | --------- | ------------------------------------------------------------------------------------------------- |
| **emission** | **unset** | No published epoch reward, supply cap, halving interval, or mining/governance split.              |
| **buyback**  | **unset** | No published buyback rate, window length/cadence, or fee→buyback percentage.                      |
| **burn**     | **unset** | No published burn split or user-facing burn total as an economic outcome.                         |
| **staking**  | **unset** | No published APY, access-tier magnitudes, lock multipliers, or fee-discount steps as live policy. |

Seeds in source (if any exist) are **not** these numbers. Copying a seed into a user-facing figure, a new constant “so tests pass,” or a comment that treats a seed as committed policy is inventing.

---

## Refuse-closed (done bar)

| Situation                                            | Correct answer                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| All four magnitudes unset (today)                    | **Refuse-closed.** Name the residual. Never a plausible figure.              |
| A surface asks for supply, burn total, APY, or fee-% | **Say it is not set.** Never a zero, never a dash. (D-S-14 refuse table.)    |
| An agent needs a number to ship                      | **Stop.** Do not seed. Do not copy economics constants into live copy.       |
| Owner later writes `token_params`                    | Engineering may then publish **that** store. Still no second book in source. |

This seal does **not** require a red CI gate that blocks unrelated merges until four figures exist. D-S-14 already rejected that failure mode. The product rule is refuse-closed on the door, not an unconditional red on `main`.

---

## What this does not decide (P0-04)

P0-04 is authority and drift: `token_params` is the live store; seeds are not commitments; claim-before-burn; drift refuse. **Leave that ADR and that packet row alone.** PKT-C9 is only the four magnitudes remaining unset.

---

## What agents may do without asking again

- Keep user-facing token economics refuse-closed while these four stay unset.
- Honour D-S-14 and P0-04 mechanisms already on tip.
- Wait for an owner write into `token_params` before any published figure.

## What they must not do

- Seed emission, buyback, burn, or staking magnitudes.
- Invent bps, supply, APY, or a 40/60 split.
- Treat `economics/*.ts` constants as live policy.
- Edit `svc-token` under this packet.
- Rewrite P0-04 files to “finish” this sitting.
