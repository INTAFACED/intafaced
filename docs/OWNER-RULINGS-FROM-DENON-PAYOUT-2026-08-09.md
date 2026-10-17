# Owner rulings — Denon affiliate payout handoff (shapes + recommended defaults)

**Status:** **Accepted — 2026-08-15 (PAYOUT-01 v1 law).** Table defaults clicked; no owner override. Magnitudes remain D26-P0-02.  
**Seal ADR:** [`adr/2026-08-15-payout-01-affiliate-handoff-seal.md`](adr/2026-08-15-payout-01-affiliate-handoff-seal.md).  
**Source:** PR #1505 ship notes · Nitro takeover 2026-08-09.  
**Tip index:** `PAYOUT-01` in [`ops/owner-ruling-packet.json`](ops/owner-ruling-packet.json) (D26-P0-18 packet completeness).

| #   | Decision                                                      | Accepted default (v1)                                                                         | Why                                                                                      | If you change it                                               |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | **Max commissionable hops** (`MAX_PAYOUT_TIER_DEPTH`)         | **5** (same as referral tree write cap)                                                       | Extra hop multiplies house fee outflow                                                   | Raise/lower constant only after written law                    |
| 2   | **Fee pool source module** (`AFFILIATE_PAYOUT_SOURCE_MODULE`) | Keep **`"identity"`** named constant + override param                                         | Trade fees may land in `houseFees("trade")`; no column yet — Denon refused inventing one | Real producer needs a source-module column on accrual/FeeEvent |
| 3   | **Atomic multi-leg payout**                                   | **Accept replay-safe-by-key for now** (crash = partial tree; re-run completes, no double pay) | Full atomic needs multi-beneficiary ledger recipe (owner carve-out)                      | Ask for recipe only if partial-pay mid-crash is unacceptable   |
| 4   | **Multi-beneficiary recipe**                                  | **Do not invent** until you order it                                                          | Money shape                                                                              | New recipe PR after your go                                    |

**Not on this card (Class X / later):** notify email-push-SMS credentials · live mark source for price watches · publishing commission bps tables.

**Already banked without your click:** payout engine refuse-closed on unpublished rates · #1504 alert sweep · #1494 support audit/grounding/case file · #1502 empty-denominator gate.
