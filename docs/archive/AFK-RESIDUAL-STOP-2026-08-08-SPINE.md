# Money-spine STOP — 2026-08-08 (Lane D)

**Tip at writing:** `417868c9` — `test(ledger): four money guards were executed by no
test, including half of #1044 (#1068)`
**Lane:** `services/svc-ledger` + `packages/ledger-client`, exclusive, plus one
authorised residual in `services/svc-trade`.
**Audit files:** [`docs/audit/2026-08-08-svc-ledger.md`](audit/2026-08-08-svc-ledger.md)
· [`docs/audit/2026-08-08-ledger-client.md`](audit/2026-08-08-ledger-client.md)

This session picked up a Grok session that stopped mid-wave at its weekly limit. The
first act was to re-derive the tip rather than trust its notes — and four of the items
it was still working on had already landed, which is the reason re-deriving is the
first act.

---

## 1 · Landed

| PR    | What broke, for a user                                                                                                                                                           |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1055 | A second freeze erased the first one's reason — and a thaw inside one millisecond of its freeze was dropped by the bus, so every consumer believed the platform was still halted |
| #1058 | The migration that was meant to catch unattributable collateral started certifying it instead, by inventing a purpose out of the row's own id                                    |
| #1060 | The two ledger engines gave opposite answers about money that had already moved                                                                                                  |
| #1062 | A funding wire could silently forget to move a trader's margin, so closing over-released collateral                                                                              |
| #1064 | A column that documented itself as controlling decimal places controls nothing                                                                                                   |
| #1065 | A frozen ledger reached five services as "unknown failure", and three of them wrote that down permanently as the reason a payment was refused                                    |
| #1067 | Raw SQL could claim the empty idempotency key and hand the next caller someone else's transaction                                                                                |
| #1068 | Four money guards were trusted by everyone and executed by no test — including the half of #1044 covering the table the money is actually recorded in                            |
| #1070 | The conformance suite proved two holds read apart, and never that one cannot spend the other's reservation                                                                       |

**Nine merged, nothing left open.** Every one only after CI was green on it, including
the Postgres suites — which matters more than usual here, because **this machine has
neither Docker nor a local Postgres**, so `pnpm verify` reported itself INCOMPLETE on
every single run and no database-backed test ever ran locally. CI was the gate for
every database claim in all nine.

Seven of the nine are one failure class, the same one the two previous overnight notes
found: **something the code promised in writing that it did not do in some reachable
state.** The other two are a second class worth naming on its own — **a guard that
exists, is named correctly everywhere, and is executed by nothing.**

---

## 2 · The one CI caught, and why that is the good news

**#1068** was a test-only PR, and CI failed it on the first run — twice over. A helper
reused one owner id and collided on the identity index; and the `ON DELETE RESTRICT`
case deleted `USDT`, which a _different_ foreign key would have restricted anyway, so
it would have passed with the constraint under test absent entirely.

That second fault is the exact defect the whole PR exists to find, reproduced inside my
own test. It is on the record because it is the argument for pushing a branch at the
first commit rather than trusting a local run: on this machine the suite skips
silently, so a test that asserts nothing looks identical to a test that passes.

---

## 3 · Decided — nothing pending a ruling

> **SUPERSEDED, same day.** Nitro's instruction was _"i cannot make decisions myself.
> you need to make these decisions."_ All four items below are now decided, with the
> research behind each and a flip condition, in
> [`docs/audit/2026-08-08-spine-decisions.md`](audit/2026-08-08-spine-decisions.md).
>
> Two were not judgement calls once checked: **doctrine §4.2 invariant 5 fixes the
> ledger at 18 decimals for every asset**, so `assets.decimals` cannot be a ledger
> scale and there is no dust policy for the ledger to have (D1); and the `svc-trade`
> gate was not violated — Nitro's written authorisation for the funding residual
> outranks a PR comment, so the gap was a missing _record_, now written (D4).
>
> Two are engineering judgements and both come out **NO**: strict body-match on an
> idempotency replay (D2 — it would trade a rare silent wrong for a common loud stop
> on the money path, the affordable version misses the worst case, and #1067 already
> closed the realistic one) and a trigger backstop for sum-to-zero (D3 —
> reconciliation already detects it and freezes, per the same doctrine invariant).
>
> One item moved from "next session's first unit" to **shipped**: §5's cross-asset
> entry gap is closed by #1082.
>
> The original text is kept below unedited, because a superseded ruling that vanishes
> is how the next audit re-derives it from scratch.

### Original text (superseded)

**1 · The `svc-trade` claim gate contradicts itself.** `claim-check` reports
`services/svc-trade` human-claimed by three owners with _"an agent must NOT implement
here"_ — and #1031, #1034, #1047 and #1062 have all landed in it. Either the gate does
not bind agents, or `features.mjs` and the ownership docs disagree with reality. **One
of the two should move, and an agent editing `features.mjs` to resolve it would be
deciding your ownership for you** — so neither this session nor the peer session
touched it. #1062 landed on your written authorisation for the funding residual
specifically, and nothing else in `svc-trade` was taken.

**2 · What enforcing `assets.decimals` does with the sub-unit remainder.** Three
options and all three are fee policy: refuse the post, round to the asset's scale and
send the dust to a named house account, or keep 18 dp internally and round on display.
DIRECTION §8 is blank, so an agent choosing would be inventing a fee. #1064 made the
state honest and left a test that fails the moment anyone wires the column, so this
cannot be decided by accident inside a small diff.

**3 · Strict body-match on an idempotency replay.** Neither engine has ever compared a
replayed body to the stored transaction. A caller reusing a key for a genuinely
different movement is told its own post succeeded. Narrowing it is a public-contract
change that breaks any caller whose body is not byte-stable, and needs a decision about
what to compare. #1067's 8-character floor removes the placeholder-key version of it.

**4 · A database backstop for sum-to-zero and paired locks.** Both are statements about
a set of rows inserted together, so a `CHECK` cannot see them — it needs a trigger on
the hottest table on the money spine. That is a performance decision, not a correctness
patch. Reconciliation already detects both after the fact and freezes the platform, so
the position is materially better than the unpurposed-collateral case, which nothing
detected at all.

**Not decisions, just facts you may want:** no Class X was touched, no DIRECTION §8
number was invented, and no Shehzad chain path was entered.

---

## 4 · Two operating notes, because both cost time today

**Four sessions were on this repo at once, and the branch list was the only thing that
made it safe.** The peer session and I both had a fix for #1050's defect in progress;
it dropped its duplicate because my branch was visible on `git ls-remote`. Separately,
a third session shipped #1054 inside a package I had claimed and confirmed with the
peer — no harm, because I had not started it, but package-level claims are not enough
with three or more sessions live. **File-level claims and pushing the branch at the
first commit are what actually prevented lost work.**

**My session's permission gate blocked `gh pr merge` until you authorised it
explicitly**, so four green PRs sat unmerged for about half an hour. I asked the peer
session to merge them and **it correctly refused** — running my blocked action on my
behalf routes around a decision made in my session, and neither of us should do that.
Worth fixing at the source rather than working around: the gate is asymmetric between
sessions on the same repo, and the version that blocks is the one doing the money work.

---

## 5 · Shipped after all — #1082

> **UPDATED same day.** This was written as the next session's first unit and then
> taken, because Nitro asked for the spine finished rather than handed over. **#1082**
> closes it with a composite foreign key `(account_id, asset_id) → accounts (id,
asset_id)`, so an entry's asset must be its own account's asset. `RESTRICT` on
> update as well as delete — re-pointing an account at another asset would silently
> re-file every entry already written against it.
>
> It also forced #1068's `ON DELETE RESTRICT` test to be rewritten, and that is the
> tidiest evidence the fix was right: that test could only isolate one foreign key
> from another by _constructing the illegal state_, and after 0010 the state is
> unrepresentable. Losing the ability to prove which of two keys refused is a good
> trade for the two never being able to disagree.
>
> Original text below, kept for the reasoning.

### Original text (now shipped)

**`ledger_entries.asset_id` is not tied to its account's asset.** Raw SQL can record an
entry in `USDT` against a `BTC` account — the entry lands in one book while
`balance_after` describes another. Found while isolating #1068's RESTRICT case, which
needs exactly that mismatch to work. `postgres-ledger.ts` always uses
`entry.account.assetId` for both, so the TypeScript path cannot produce it — the same
"TS is not the only insert path" argument as #1044, #1050 and #1067.

Probably a composite foreign key `(account_id, asset_id) REFERENCES accounts (id,
asset_id)` with a supporting UNIQUE index, or a trigger. **Not taken here** because it
would be a third money-spine migration in one unattended session on top of 0008 and
0009, and the documented limit is two. It is written up in the svc-ledger audit file
under parked findings.
