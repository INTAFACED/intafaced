# ADR: the launch money model

**Status:** Proposed. **Date:** 2026-11-10. **Area:** packages/ledger-client, svc-ledger, every service that posts or shows money.

## Decision

At launch INTAFACED holds no customer money (OWNER 226). The custodial layer stays built and switched off (`LEDGER_CUSTODY_LAYER`, off unless set to `on`).

1. **The ledger records only INTAFACED's own money:** income earned, amounts owed to us, amounts we owe, and where our own funds sit. With the switch off, a post that touches a customer account is refused (`ledger.custody_layer_off`).
2. **A customer's figure is never posted.** Balances, margin, positions, fills, holds and fees belong to the chain, the venue or the partner that holds the money. They are read from that source and shown with its name and its as-of time. An unknown or stale figure is shown as such, never as zero.
3. **A customer's money moves only by an instruction the customer signs, or one the partner carries out for them.** One intent has one key, stored before sending and sent once. An answer that is not definite is read back by its key, never sent again blind.
4. **Every post is caused by one outside fact or one decision of ours, and its idempotency key identifies that fact for our account:** the venue, the venue account and the venue's own globally unique id. The same fact posts once.
5. **Income is posted when earned and again when collected,** as two posts on two facts.
6. **Nothing is posted to make two figures agree.** A difference between the ledger and an outside record is a break row for a person. A correction is an approved, linked reversing post.
7. **A reconciliation states what it compared:** how many records and through what time. Nothing compared is "nothing to compare", never "matched". An unreadable source is "unknown".

Sign convention, for a reader used to accounting textbooks: in this ledger a debit adds to an account's balance and a credit subtracts, for every account type (`packages/ledger-client/src/client.ts`). Only `treasury` accounts, which stand for the outside world, may go below zero.

## What this supersedes

For the launch build, this ADR is read first. An earlier ADR that says customer balances live on our ledger describes the custodial layer and carries a "Later: custody" banner. Rules that never depended on custody stay in force: money only through `packages/ledger-client` recipes, no money in a `number`, business keys, append-only entries, and lookup before retry.

## What it does not decide

Switching custody on. That adds customer accounts, the custodial recipes and a holdings reconciliation to this model and changes none of the rules above.
