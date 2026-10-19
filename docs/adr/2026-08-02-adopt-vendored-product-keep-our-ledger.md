# ADR: adopt the vendored product, keep our ledger

**Status:** **Accepted — 2026-08-02.** Owner decision, stated and confirmed.
**Decision owner:** repo owner. **Written by:** Denon.
**Supersedes in scope:** nothing. **Depends on:** [`2026-07-28-vendored-exchange-integration.md`](2026-07-28-vendored-exchange-integration.md) (Accepted, Option B).

---

## The decision, in the owner's words

> **Yes for the product. No for the book.**
>
> Take their shell, their screens, their OTC and admin workflows, their business logic, and their wallet RPC as the starting point. Keep our ledger as the single place balances live, and have their money controllers call it through an adapter instead of writing `member_wallet`.

This is settled. Agents and engineers implement it; they do not re-litigate it.

---

## Why this is not a compromise

The two systems are better at different things, and the line between them is unusually clean.

### Where ours is better, and it is not close

- **The ledger.** Theirs is a mutable `balance` column with an `AFTER UPDATE` trigger recording before/after values. That is an **audit log**: it says _when_ a balance changed and cannot say whether the change was legitimate, nor reconstruct the correct value. Ours is double-entry, hash-chained and replay-reconcilable — **84/84 including zero drift across 200 sequential posts and 50 concurrent ones.** A category difference, not a quality difference.
- **Precision.** `decimal(18,8)` against `numeric(38,18)`. Anything crossing their boundary truncates, and our own conformance suite asserts round-tripping to 18 places.
- **Proof.** **1,805 passing tests** across our money core.
- **Currency.** Java 8 / Spring Boot 1.5.9 is 2017 and end-of-life. **31 committed `.jar` binaries** sit on the classpath of custody-handling services and cannot be verified against any upstream. The repo contains **no schema** — tables come from `ddl-auto=update`, which is precisely how environments silently diverge.

### Where theirs is better, and that is not close either

- **The UI.** 74 finished screens against our partial one.
- **Feature breadth.** A complete OTC desk with adverts and appeals. A 58-controller admin console. CMS, support chat, statistics and finance reporting, fiat recharge and withdrawal approval workflows. **We have essentially none of this finished**, and five of these capabilities have no tracker row at all — which is why they keep being rebuilt by accident.
- **Wallet RPC.** Working BTC/ETH/USDT/EOS custody integration. **We have none.** Building it is months.

**"Robust" and "never had a user" are both true of their stack.** `member` 0 rows, `member_wallet` 0, `exchange_order` 0. It is complete and untested by reality — which is an argument for adopting its _shape_, not for trusting its _guarantees_.

---

## What this obliges

### ADOPT AS-IS

Everything that does not write a balance: shell and screens, OTC and admin workflows, CMS, support, statistics and finance reporting, admin RBAC scaffolding.

**Stop rebuilding these.** Five have no tracker row, and that absence is the mechanism by which they keep getting rebuilt — so the rows get created as part of adoption.

### ADOPT AND ADAPT

Every controller reaching `MemberWalletService` / `MemberTransaction` / `MemberWalletDao`. **Keep the controller and its business logic** — the workflow, the states, the approval steps are the valuable part and they are not what is wrong. **Redirect only the balance write** to `ledger-client` through an adapter.

The four mutators — `increaseBalance`, `decreaseBalance`, `freezeBalance`, `thawBalance` — are the exact seam. Each maps to an existing ledger recipe; that mapping is the core of the work queue.

### REPLACE

**The balance subsystem, and so far only that.** `ledger.*` remains the single book, per the 2026-07-28 ADR. `member_wallet` becomes a read-only projection.

### WALLET RPC — adopted, with a hard precondition

`01_wallet_rpc` handles **private keys** for BTC/ETH/USDT/EOS. Adoption is the right call: we have no chain custody and building it is months of work.

**A security review is a precondition of adoption, not a follow-up.** Nobody has read those files. The 2026-07-28 ADR already says nothing in it should touch a chain holding value until someone has. It sits on a classpath carrying 31 unverifiable binaries.

**Until that review is complete and its findings addressed, `01_wallet_rpc` does not touch a chain holding real value.** Running it against a testnet to learn its shape is fine and encouraged.

---

## What must be true before any of this is testable

The Java stack cannot be evaluated while it is down, and it is down for **three separate reasons** — fixing one brings back nothing:

1. The MongoDB container was **never recreated** after `mongo:4.4` was committed; it still runs `mongo:6`, so `market` dies on `OP_QUERY`.
2. `ucenter` dies on a **Redis AUTH mismatch**, not on Mongo.
3. `otc` and `exchange-api` are **absent from the compose file entirely** and cannot be started at all.

These are now blocking work rather than untidy.

~~**`custody-scan` walks `.ts`/`.tsx` only — it has never read a line of Java.**~~ **Closed 2026-08-03 — and the framing was corrected on the way.**

The premise was right: adopting Java money code while nothing gates it makes the doctrine unenforceable exactly where the money is. The instruction it implied was wrong. `custody-scan` is a **Protocol Plane** gate, and the custodial services sit outside it on purpose. Java dual-book belongs to `vendor-java-money-scan.mjs` and `dual-book-door-scan.mjs`, which already walk all 882 Java files and already run in CI and the DoD gate. Spec DB-4 says "custody-scan **or successor**"; the successor is where this landed. Full reasoning: the 2026-08-03 correction block in the [2026-07-28 ADR](2026-07-28-vendored-exchange-integration.md).

What the widening found bears directly on ADOPT AND ADAPT above. The DAO route and the HTTP-door route were **already shut**. A third route was open and gated by nothing: mutating a managed `MemberWallet` entity, which Hibernate flushes to `member_wallet` at commit without emitting an `UPDATE` anyone could grep for. **27 sites.** Seven are held off only by a `= null` line, and three of those live in a Kafka consumer and two Spring event listeners — **code no HTTP interceptor can reach.** All 63 known write sites now sit on a counted ratchet in `vendor-java-money-scan.mjs`, each with a written reason; that list is the work queue for the seam described above.

**Update 2026-08-04 — the ungated grade is closed.** The eight sites with no runtime gate at all (three in `core:MemberApplicationService`, one in `wallet:MemberConsumer`, two each in `admin:OrderEvent` and `otc-api:OrderEvent`) were registration and promotion reward **mints**. ADOPT AND ADAPT says redirect the balance write — but no reward recipe exists to redirect them to, so there was nothing to adapt them into and they were **deleted**, together with the wallet and reward services those classes injected only in order to mint. The surrounding workflow — KYC status, inviter tree counters, wallet creation at registration, transaction counters — is untouched. Ratchet: **63 → 55** across 26 files, still clean. Grade D is now empty by construction: a new entry there means a new ungated mint, not old debt.

Two of those eight sat after an unconditional `return;` in the same block. That is an unreachable statement, which JLS §14.21 makes a **compile error, not a warning** — so `core` has not compiled since the disabling edit landed, and no build of these jars has ever contained it. Fixed here; a sweep of all 870 Java files found no third instance. Any plan that rebuilds the vendor jars should assume this was the first thing standing in its way.

---

## Why the front-end half of this went wrong, recorded so it is not repeated

The vendored shell was **never deployable** — no `dist`, no Dockerfile, in no compose file. One developer put **48 commits** into it without ever seeing it render, while a separate app added two days before the shell was vendored stayed on `:3000` as the de-facto product **because it was the only one that started.**

Nobody decided that. It is what happens when the intended thing cannot be run and the unintended thing can.

Fixed in #412 (Dockerfile, nginx, compose on `:8090`) and gated by `workspace-sync` check 7: a user-facing app either appears in compose or carries a written `# no-deploy:` reason. **Silence is what is forbidden.**

---

## Open, and owner-gated

Per `DIRECTION-2026-07-31.md` (removed) §8: the security review's scope and who performs it; whether `apps/web` retires, becomes the admin/marketing surface, or has its working trade terminal ported into the Vue shell; and any decision to run `01_wallet_rpc` against real value.
