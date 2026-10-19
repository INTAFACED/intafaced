# ADR: `p2p:moderate` scope mint stays refuse / owner-gated (PKT-C8)

**Status:** **Accepted — 2026-08-15.** Owner sign-off. Agents do not invent who moderates.
**Decision owner:** repo owner (Denon). **Written by:** Denon.
**Packet:** PKT-C8 — [`docs/ops/owner-ruling-packet.json`](../ops/owner-ruling-packet.json).
**Packet prose:** `OWNER-DECISION-PACKET-2026-08-09.md` (removed) §8.
**Prior pack note:** [`2026-08-14-remaining-p0-money-law.md`](2026-08-14-remaining-p0-money-law.md) §PKT-C8 (same refuse; this ADR is the dedicated home).
**Dispute law:** [`2026-08-04-p2p-escrow-and-dispute-law.md`](2026-08-04-p2p-escrow-and-dispute-law.md) — a human adjudicates; the timer never does.
**Tracker:** `p2p.disputes` in `tooling/tracker/features.mjs`.

---

## The decision

> **Do not mint `p2p:moderate` onto sessions.** Scope mint stays **refuse / owner-gated** under DIRECTION §3 (grants or widens a scope). Agents must not invent who moderates, must not invent user ids, and must not auto-rule.

This is settled. Agents and engineers implement it; they do not re-litigate it. This ADR does **not** name a moderator.

---

## What is already shipped (mechanism — do not re-open in `svc-p2p`)

The `p2p.disputes` tracker note (DONE 2026-08-13) already records the mechanism on tip:

- open / list / backlog / resolve; `opened_via`; `resolutionNotes`
- empty `P2P_MODERATOR_USER_IDS` → **`p2p.moderation_unreachable`**
- API keys cannot rule
- SQL invariant 0003 — **no auto-ruling**
- money only via existing escrow release/refund recipes
- pin: `disputes-tracker-pin.test.ts`

Residual named there and **still not this ADR:** `apps/admin` Vue (`nitro-frontend-all`); who-moderates Class X env allowlist (do not invent ids); `chat_thread_id`; events outbox.

This packet does **not** edit `services/svc-p2p`. It does **not** touch Vue or `apps/admin`.

---

## Owner rulings (PKT-C8)

### 1. Scope mint stays refuse / owner-gated

Minting `p2p:moderate` would grant or widen a session scope. DIRECTION §3 keeps that carve-out with the owner. The 2026-08-14 pack seal stands: moderation is **`admin:compliance` or a natural-person id on `P2P_MODERATOR_USER_IDS`**. Waiting on a new session scope does not unblock a missing human; inventing the scope would.

**Agents may not** add `p2p:moderate` to `SESSION_SCOPES`, grant it, or treat “the split” as free craft.

### 2. Empty allowlist remains `p2p.moderation_unreachable`

An empty `P2P_MODERATOR_USER_IDS` is not a soft default and not a reason to mint a scope so someone can pretend a console is staffed. The API keeps returning **`p2p.moderation_unreachable`**. Filling the list is Class X / operator content. This ADR names **no user ids**.

### 3. No auto-ruling

Dispute law already forbids a timer or job disposing of value. Tracker SQL invariant 0003 pins **no auto-ruling**. Escalate-and-hold stays; machines do not pick a winner.

---

## What this unblocks / what it does not

**Unblocks:** agents may keep honouring the allowlist path and the unreachable code without waiting for a `p2p:moderate` mint.

**Does not unblock:** naming who is on the list; minting the scope; Vue dispute console; auto-ruling; dual-edit of `svc-p2p` from this packet.

---

## What agents must not do

- Invent moderator user ids or seed `P2P_MODERATOR_USER_IDS`.
- Mint, grant, or widen `p2p:moderate`.
- Add auto-ruling, timeout-as-adjudicator, or a job that clicks resolve.
- Edit `services/svc-p2p` under this tracker id.
- Craft Vue / `apps/admin` (`nitro-frontend-all`).
