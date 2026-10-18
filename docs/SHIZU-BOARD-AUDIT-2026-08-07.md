# Shizu (Shehzad) — board audit + GitHub state

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Date:** 2026-08-07 · **Written for:** Nitro (plain language, no code)
**Re-derived from:** `origin/main` @ `bfce4c41` (#923), `gh pr list`, `gh issue list`, GitHub API
**Status:** this is the evidence behind the board delta that ships in the same PR. §13 records exactly what that PR changed.

> ⚠️ The local checkout was **160 commits behind** `origin/main` when this audit ran. Every fact below was re-read from `origin/main`, not from the stale local copy.

---

## 1 · GitHub state right now (the whole repo, one screen)

| Thing              | State                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------- |
| Repo               | `Phantom-X-007/intafaced`, private, default branch `main`                                |
| Tip                | `dd18c9a8` — "free-TRK waves 200–202 public-order-status/option-type/ws-channel honesty" |
| Merged PRs         | **856**                                                                                  |
| Open PRs           | **2** — #923 (ZenYoda3, vendor docs), #904 (Phantom-X-007, security pin)                 |
| Open issues        | **23** — all auto-generated placeholders from the tracker; only one has a human assignee |
| Who writes code    | ZenYoda3 (200 of the last 250 PRs), Phantom-X-007 (47), dependabot (3)                   |
| **Shizu's PRs**    | **Zero open. Four ever merged:** #226, #227, #228, #346                                  |
| Shizu's last merge | **#346 (pay gateway), merged 2026-08-06 — yesterday**                                    |

**Plain reading:** the repo is being driven almost entirely by agents on Nitro's side. Shizu has no lane in flight today. His last piece of work was the pay PR that has now been merged and handed back — so his slate is fully clear for the chain board.

---

## 2 · What Shizu owns (the law, as it stands on main)

Decided 2026-08-04 and binding on `main` in three files:

- `docs/GITHUB-OWNERSHIP-SHEHZAD.md` — who may code what
- `docs/SHEHZAD-BLOCKCHAIN-TASK-BOARD-2026-08-03.md` — his task board
- `docs/THREE-WAY-DISTRIBUTION-2026-08-04.md` — the three-way split
- plus `docs/LIVE-LANES.md` (lane `shehzad-protocol-chain` = **HUMAN**) and `.github/CODEOWNERS`

**He owns:** everything on-chain / self-custody — smart-account contracts, AMM, lending, escrow, router, merchant contracts, launch/token factories, the DEX self-custody surface, the venue contracts the indexer reads, the canonical bridge, and the whole INTACHAIN L1 path.

**He does not own:** the vendor shell / front end (Nitro human lane), custodial pay/bank/futures (reclaimed for Nitro agents), Denon's open integrity PRs, and Class X (production keys, mainnet go-live, licence/sanctions content — Nitro human).

**Enforcement is real, not just prose:**

- `CODEOWNERS` requests his review on `services/svc-protocol/` and `services/svc-dex/` — verified working (`codeowners/errors` returns empty, and he has push access).
- 20 tracker rows carry `owner: shehzad002`, which makes them off-limits for agents.
- `AGENTS.md` + `CLAUDE.md` auto-load the "never implement Shehzad chain mountains" rule into every cold agent session, with a CI check that fails if someone deletes it.

**Answer to your question — yes, he has free hands, and it is written down:** the board says in its own words _"You design PR DAGs. Rows below are outcomes + Done bars, not micro-tickets. Spec freely, plan completely, ship with proof."_ The only gate on that freedom is **one plan/ADR PR before the big L1 implement** (item S-D0), so you and Denon can see the attack order before he spends weeks. That is the right shape.

---

## 3 · His current task board — full scope, plain language

The board holds **~45 outcomes across 11 tiers**. Every one is written as "outcome + what proves it's done", not as a ticket.

### Tier A — Protocol P0 (the near-term value, seeds already on main) — 8 items

| ID   | In plain words                                                                          | Today's real state                                                      |
| ---- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| S-A1 | Make passkey smart accounts production-ready + write the adversarial audit package      | Contracts exist and compile, 31 tests against a dev chain. Not audited. |
| S-A2 | AMM (swap pools) honest — compile, prove mint/swap on a chain, invariant tests          | **Compile is already fixed** (his own #228). Proof + invariants remain. |
| S-A3 | On-chain P2P escrow — lock → release → refund → dispute timer, no stranded funds        | Nothing built. Doctrine only.                                           |
| S-A4 | Lending markets — collateral in contracts, LTV from oracle marks, liquidation keepers   | Nothing built.                                                          |
| S-A5 | Sovereign router — best of order-book vs pool, without inventing prices                 | Nothing built.                                                          |
| S-A6 | Merchant contracts — zero-KYB, merchant's own account, platform never touches the money | Nothing built.                                                          |
| S-A7 | Launch / token factory honest — real deploy proof, `audited:false` until a real audit   | **Largely shipped and proven on a dev chain.** No audit.                |
| S-A8 | Pin the contract compiler toolchain so builds are reproducible                          | Partly done (solc pinned, CI runs contracts). No fuzz/gas suites.       |

### Tier B — Crypto rails (5 items)

Crypto deposit/withdraw acceptance on-chain · hot-wallet + mnemonic security posture · how IFC appears on EVM without double-minting · on-chain buyback/burn observability · canonical bridge design + threat model.

### Tier C — Venue contracts feeding the indexer (3 items)

A **real** venue contract (today only a dev fixture exists) · reorg-safe event surface · a documented event matrix so the WS feed can be built later.

### Tier D — INTACHAIN L1 (10 items) — the big mountain

Plan-first handshake · which EVM rails for v1 · INTACORE module map (on-chain order book, margin, finality targets) · validator + staking architecture · the CometBFT/Cosmos chain itself · INTAEVM · node-ops service · bridge service · Rust matching core · progressive decentralisation schedule.

### Tiers E–K — the rest (19 items)

- **E** Sovereign card contract half — just-in-time funding from a smart account (3)
- **F** On-chain rank/reputation attestations, zero PII (3)
- **G** Launchpad / meme factory / NFT / RWA registry (4)
- **H** Mining share protocol + epoch allocation API (2)
- **I** DEX self-custody surface (2)
- **J** Audit factory — audit pipeline, adversarial suites, incident runbooks (3)
- **K** Six ADRs he writes freely (oracle policy, upgradeability, multi-chain topology, testnet faucet, cross-plane identity, protocol-plane market ids)

**Suggested order on the board:** plan PR → rails ADR → smart-account audit package → AMM honesty → escrow + merchant → lending + router → launch factory → real venue contracts → card contracts → INTACHAIN → continuous audit.

---

## 4 · AUDIT — is this the best set, and is anything missing?

**Verdict: the board is strong and unusually well-shaped for a senior chain engineer — outcomes not tickets, honest "done" bars, explicit freedom to spec. But there are 12 real defects.** Four are collision risks that could cost him a week of duplicated work; three are genuine missing capabilities a senior chain engineer would expect to own; the rest are staleness and a doctrine contradiction.

### A · Blockchain work sitting UNCLAIMED in the tracker (agents can legally grab it)

The board _says_ these are his. The tracker — which is the thing agents actually check before starting — has **no owner** on them. An agent doing the correct check today would read "free" and start building.

| Row                         | What it is                                                          | On his board?              |
| --------------------------- | ------------------------------------------------------------------- | -------------------------- |
| `socket.contract-toolchain` | Foundry/fuzz/gas-snapshot suite in CI                               | Yes (S-A8)                 |
| `socket.contract-audit`     | External audit of the account + factory contracts                   | Yes (S-J1)                 |
| `socket.clob-contracts`     | A real venue contract (today: a dev fixture with no access control) | Yes (S-C1)                 |
| `socket.indexer-stream`     | Live book/tape feed out of the indexer                              | Partly (S-C3)              |
| `blueprint.attestations`    | On-chain rank attestations, zero PII                                | Yes (Tier F)               |
| `bank.sovereign-card`       | Self-custody card, on-chain JIT half                                | Yes (Tier E)               |
| `indexer.readmodels`        | Chain → database read models                                        | Deliberately shared — fine |

**Fix applied (see §13):** owners set, with two deliberate exceptions where a blanket owner would have been the wrong answer — `bank.sovereign-card` (custodial half is genuinely agent work; its note already splits the row) and `socket.indexer-stream` (the transport is agent work, the event surface it carries is his). Both now say so in the row itself rather than relying on someone remembering.

### B · Blockchain work in the tracker that is NOT on his board at all

These are real, senior, unclaimed chain items. None appears anywhere in the 45 board rows.

1. **`socket.p256-verifier` — the passkey signature verifier contract.** This is the missing piece that makes "passkey smart accounts" actually work on-chain: the account already routes contract owners through the ERC-1271 standard, but the contract that verifies a passkey's P-256 signature does not exist. Arguably the highest-value single item in the whole protocol suite, and it is on nobody's list.
2. **`socket.userop-differential-test` — check our transaction-hash maths against the live standard contract.** The service computes the hash a user signs, and it has only ever been checked against itself. If it disagrees with the real EntryPoint, users sign one thing and the chain executes another. Small job, serious failure mode.
3. **`socket.mpc-custody` — MPC custody for self-custody wallets.** Ownerless, unmentioned.
4. **`socket.dex-execution` — actually executing an order against a quoted venue.** The DEX quotes and routes but cannot execute; this needs a credential vault (§27) and an order-management service (§28) that **does not exist in the repo**. That is a whole service, and it is on nobody's board.
5. **`socket.dex-fee-source` — authoritative per-venue fees.** Fees are currently _configured guesses_, and the settlement cost is a declared understatement of zero. Understating it means quoting users a better price than they get.

### C · Capabilities that exist NOWHERE — not tracker, not board

Searched the whole tracker on main. These words appear **zero times**:

1. **Paymaster / gas sponsorship.** The transaction format already carries paymaster fields, but nothing decides who pays gas. Without this, every user needs the chain's native token in hand before their passkey account can do anything — which quietly kills the retail sovereignty story.
2. **Bundler operations.** There is an optional bundler URL in config and no decision behind it: public bundler (a dependency and a censorship surface) vs self-hosted (ops we own). Nobody owns that call.
3. **Price oracle rail.** Lending (S-A4) and liquidations _require_ oracle marks, and there is no oracle feature anywhere in the product map — only a "write an ADR about it" line. That is a build item pretending to be a spec item.
4. **Deployed-address registry + explorer verification.** Every contract address in config defaults to zero. There is no tracked artefact saying "these addresses, on this chain, verified against this source". That is the first thing anyone integrating — or auditing — will ask for.

### D · One doctrine contradiction he could waste a week on

- **Board S-A1** invites him to spec _"recovery, multi-sig guardians"_.
- **Tracker `socket.social-recovery`** says the opposite, in doctrine language: _"deliberately absent: a guardian is a second party who can take the account, and the platform must never be one."_

He should not discover that conflict halfway through a design. Pick one and write it down.

### E · Staleness on the board

1. **Board §7 tells him to "finish or hand off #346".** #346 **merged yesterday (2026-08-06)**. That section is done and should be struck, or he will burn time re-opening a closed question.
2. **Plane labels are wrong on two of his rows** — `launch.launchpad` and `launch.rwa` are tagged fiat plane (`F`) while being on-chain contracts he owns, so they render as Fiat Plane on the board he reads. (`mining.pool` looks like a third but is not: the share/epoch protocol is his while minting stays custodial in `svc-token`, so `F` is the honest label — corrected from my first pass, and the row now says why.) The tracker's `plane` is display-only; the custody scanner reads `packages/config/src/modules.ts`, so this is a readability fix, not a safety one.
3. **CODEOWNERS covers `svc-protocol` and `svc-dex` only.** The venue-contract work (Tier C) lives under `services/svc-indexer/`, and the future `svc-chain` / `svc-bridge` do not exist yet — so PRs touching his own indexer-contract mountain will not request his review.

### F · One blocker that is YOURS, not his

**`socket.dex-venue-set` — nobody has decided which venue this platform quotes.** The DEX code is finished and correctly refuses to serve a price, because all three of its venue sources are dark. One of the three needs **no code, no chain and no credentials** — just one config row naming a public exchange's order book. It was checked against both accepted ADRs and the routing spec: none of them even mentions this question. That decision sits with you, and until it is made the DEX and the indexer both stay honestly dead.

### G · What the board gets RIGHT (so it doesn't get "fixed" into something worse)

- Outcomes with proof bars, not micro-tickets — the correct register for a senior hire.
- A collision wall listing exactly what he must not touch, so parallel work does not thrash.
- One communication gate (plan/ADR PR before the L1 build) rather than an approval queue.
- "Honest §13 socket over fake Done" — he is allowed to declare something not built rather than fake it.
- A cold-start block his own agents can paste, and a one-breath message you can send him.

---

## 5 · What I'd change, in priority order

| #   | Change                                                                                                  | Why it matters                                          |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | Set `owner: shehzad002` on the six ownerless chain rows (§4A)                                           | Stops an agent legally starting his work tomorrow       |
| 2   | Add the five missing tracker items to the board (§4B) — especially the **passkey verifier contract**    | The single highest-value protocol item is on no list    |
| 3   | Answer the **guardians/recovery** contradiction (§4D)                                                   | Prevents a week spent on something doctrine forbids     |
| 4   | Add four new rows: paymaster/gas policy, bundler decision, oracle rail, deployed-address registry (§4C) | Real holes; two of them block Tier A items              |
| 5   | Strike board §7 (#346 is merged) and fix the three plane labels (§4E)                                   | Board should not send him at a closed question          |
| 6   | Extend CODEOWNERS to `services/svc-indexer/` and pre-add `svc-chain` / `svc-bridge` (§4E)               | He gets review requests on his own mountain             |
| 7   | **Your call:** decide the DEX venue (§4F)                                                               | Unblocks two services that are currently correctly dead |
| 8   | Optional: create ~8 GitHub issues for his tiers and assign them to him                                  | See §6                                                  |

---

## 6 · The GitHub-visibility question, answered honestly

**Is his freedom "in GitHub"? Yes — but only in files, not on GitHub's own surfaces.**

What is genuinely in the repo and auto-loads for any agent: the board, the ownership law, LIVE-LANES, CODEOWNERS, the tracker owner fields, and the enforcement checks in CI. That is the part that actually stops collisions, and it works.

What he would see if he opened the GitHub **Issues** tab instead:

- 23 open issues, all auto-generated from the tracker, **none assigned to him**
- Exactly **one** issue for his entire mountain — #11, smart accounts — unassigned, and its instructions still say _"say so in Telegram"_
- **Zero** issues for AMM, lending, escrow, router, merchant contracts, launch, DEX, bridge, or any chain row
- Milestones exist per phase — **Phase 4P (INTACHAIN) and Phase 5P have zero issues in them**
- No GitHub Project board

**So:** a chain engineer opening this repo through GitHub's UI sees nothing addressed to him. He only finds his 45-item runway if he reads `docs/`. The board's cold-start block does tell him exactly which files to open, and the one-breath message in §7 of the board names the file path — so if you send him that message, he lands correctly. If you expect him to find it by browsing GitHub, he won't.

**Cheapest fix if you want it visible:** one issue per tier (8 issues), assigned to `shehzad002`, each linking the board section. Not required for correctness — the files are the law — but it is the difference between "he has a board" and "GitHub shows him his board."

---

# PART TWO — added 2026-08-07 after reviewing the two messages sent to Shehzad

## 7 · Is "a lot missing and a lot changing"? No. Calibration.

**The ownership decision is correct and must not move.** Sole mountain = Protocol Plane + INTACHAIN, enforced in four places that agents actually read (tracker owner fields, CODEOWNERS, LIVE-LANES, auto-loaded agent law with a CI check). That split is the right one and nothing in this audit argues against it.

**What is wrong is the accounting around it, in two ways:**

1. **Incomplete** — 11 chain items exist that are on nobody's list or on no owner (Part One §4A/4B/4C).
2. **Stale in one specific, expensive way** — the board and your message point him at work that is _already merged_ (§8 below).

So: **one delta, not a rewrite.** Nothing you told him about who owns what needs to be retracted.

---

## 8 · Your two messages vs. the current truth of `main`

### ✅ Correct and still binding — do not resend or soften

| What you said                                                                     | Verified                                                                         |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Sole mountain = Protocol Plane + INTACHAIN                                        | True in tracker (20 rows), CODEOWNERS, LIVE-LANES, and the agent auto-load law   |
| The three doc links                                                               | All three exist on `main` at those exact paths — the links work                  |
| P0 EVM rails → P1 CometBFT + CLOB + INTAEVM + bridge → P2–P3 rust core/validators | Matches the board §2 Tier D and the definitive build §17 sequencing              |
| "You design PR DAGs · ADR/plan PR before large implement"                         | Matches board S-D0 and the ownership doc's communication gate                    |
| Not yours: vendor shell, Denon open PRs, Class X                                  | Matches LIVE-LANES and the collision wall                                        |
| Bar: CI green, one concern per PR, no invent, proof in PR body                    | Matches board §4                                                                 |
| Asking for a confirm-back                                                         | Right call — and he has **not** replied (no comments, no PRs, no branches since) |

**His lock has actually held.** Since 2026-08-04, nothing has been implemented into `svc-protocol` / `svc-dex` / `svc-indexer` by agents. The only commits touching those paths are repo-wide chores: dependency bumps, a telemetry provider registration, and a typecheck fix. No agent has built his mountains.

### ❌ Stale — will confuse him if he reads it today

1. **The whole #346 instruction is dead.** You told him "finish clean OR hand off … preferred clean close: you close #346 (or leave archived)." **#346 was merged on 2026-08-06 by Phantom-X-007**, with a comment stating _"your source lands unmodified — every line of payment-service.ts, router.ts, schema.ts, the migrations, the tests and card-sandbox-e2e.mjs is yours as written; only the board files were touched."_ You cannot close a merged PR. He owes nothing there.

2. **Three documents still describe #346 as an open obligation:** board §7, `GITHUB-OWNERSHIP-SHEHZAD.md` §"#346 disposition", and the `shehzad-346-handoff` row in LIVE-LANES ("HANDOFF ASSERTED 2026-08-04").

3. **A stranded branch is still on the remote:** `feat/protocol-amm`, last touched 2026-07-29, now 797 commits behind. Its content already landed. It will read to him as live work-in-progress. Delete it.

---

## 9 · THE EXPENSIVE ONE — you are pointing him at work that is already merged

This is the finding that matters most, and it is not in Part One.

Your message says _"Start: S-D0 plan/ADR PR then S-A1 smart-accounts audit package."_ That start is fine. But **Tier A of the board reads as eight greenfield items, and four of them are substantially built — by Nitro's own agents, before the lock:**

| Board item                      | What the board asks for                      | What is ALREADY on `main`                                                                                                          |
| ------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **S-A2 AMM honesty**            | "Compile clean · mint/swapExactIn proof"     | **Both done.** Compile fixed by his own #228; pool factory + mint/swap proven on a real dev chain by agents in #264 and #288       |
| **S-A7 Launch / token factory** | "CREATE2 deploy proof · refuse zero factory" | **Done and proven end-to-end on a dev chain.** Only the audit remains                                                              |
| **S-A8 Toolchain pin**          | "One pinned compiler · CI green"             | **Done.** Compiler pinned, contracts compile and run against a dev chain in CI. Missing: fuzz/invariant suites and gas snapshots   |
| **S-A1 Smart accounts**         | "Production-ready + audit package"           | Contracts, factory, session keys, dev chain and a CREATE2 cross-check all landed (#210). The _audit package_ is the real remainder |

**Why the board hides this:** his six `protocol.*` tracker rows carry ownership stamps as their only note — _"HUMAN Protocol Plane @shehzad002. Agents babysit only."_ — and nothing about what exists. Other rows in the same file carry paragraphs of evidence. So the one place he would look to check state tells him nothing.

**The genuinely greenfield Tier A work is four items:** escrow (S-A3), lending (S-A4), router (S-A5), merchant contracts (S-A6).

**Risk if unfixed:** a senior chain engineer spends his first week rebuilding an AMM proof that merged eight days ago. That is the fastest way to lose a good contractor's trust, and it would be our error, not his.

---

## 10 · What is blocking him that is NOT his to solve

A contractor who hits an owner-gated wall and stalls looks slow. These must be named on his board as _waiting on Nitro_, so he routes around them instead of sitting on them.

| Blocker                                  | Whose call      | What it blocks                                           |
| ---------------------------------------- | --------------- | -------------------------------------------------------- |
| **Which venue the platform quotes**      | **Nitro**       | The DEX and the indexer both stay honestly dead          |
| **Which EVM chain P0 deploys to**        | Nitro + him     | Every "deployed address" item; he can propose in the ADR |
| **Money for an external contract audit** | **Nitro**       | S-A1 / S-J1 can never reach "audited: true"              |
| **Testnet/mainnet funding + RPC access** | **Nitro**       | Anything past a local dev chain                          |
| **Class X — mainnet keys, go-live**      | **Nitro human** | Already stated in your message. Correct                  |
| **Guardian / social recovery: allowed?** | **Doctrine**    | S-A1's recovery design (see contradiction, Part One §4D) |

---

## 11 · Your unspoken needs, inferred

You asked me to work out what you actually need. These are the requirements behind the request that you did not state:

1. **You need to correct the board without undermining your own authority.** You just sent a firm ownership message. A second message that reads as "we got it wrong" costs you standing with a senior contractor. **The delta must read as additive — "here is what landed since, and here is more runway" — not as a retraction.** Nothing about ownership changes; only the state of play and the size of his surface.

2. **You need him never sent at merged work.** Ranked above completeness. A missing task costs a conversation; a rebuilt task costs trust and a week.

3. **"The right way" = ownership that a machine enforces, not ownership you announce.** Right now six chain rows say "free" in the tracker while the board says they are his. The layer that stops collisions disagrees with the layer that grants ownership. Full ownership means the same fact in all four places agents read.

4. **You need his freedom bounded by proof, not by approval.** Free hands + no oversight is how vapor "done" enters a chain codebase — the most expensive kind, because it is money. The board already solves this correctly with proof bars and honest §13 sockets. **Do not loosen that in the name of giving him room.** Freedom over _what and how_; strictness over _what counts as done_.

5. **You need his blockers to be visibly yours.** §10. Otherwise idleness looks like his fault and you find out late.

6. **You need GitHub to work as the shared surface, because three parties use it.** The docs-as-law approach works for agents (they auto-load it). It does not work for a human contractor or Denon, who read GitHub's own screens. That is why his 45-item runway being invisible in the Issues tab is a real gap, not a cosmetic one.

7. **You need to see progress without reading code.** Today the only way to know what Shizu has done is to read a PR list. One issue per tier, assigned, gives you a progress view you can read at a glance.

8. **You do not want the scope trimmed to make it tidy.** You said "without compromising." So the fix adds the eleven missing items and keeps every existing one. Nothing gets cut to make the board look neat.

9. **You need this to be one exchange, not a negotiation.** He has not confirmed back yet. The delta should reach him _before_ he starts, so his first PR is aimed correctly — not as a correction after he has begun.

---

## 12 · How to move — the recommendation

**One PR to `main`, then one short message. In that order.** The PR first, so the message points at a corrected board rather than promising one.

### PR — "Shizu board delta 2026-08-07" (docs + tracker + CODEOWNERS, no product code)

| #   | Change                                                                                                                                                  | Fixes            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1   | **Tracker:** add an evidence note to `protocol.smart-accounts` and `protocol.amm` naming exactly what merged (#210, #264, #288) and what remains        | §9 — the big one |
| 2   | **Board:** new section "Already landed — do not rebuild", restating Tier A's real remainder                                                             | §9               |
| 3   | **Tracker:** `owner: shehzad002` on the six ownerless chain rows                                                                                        | Part One §4A     |
| 4   | **Board:** add the five unlisted tracker items — passkey verifier contract, transaction-hash differential check, MPC custody, DEX execution, DEX fees   | Part One §4B     |
| 5   | **Board + tracker:** four new rows — gas sponsorship (paymaster), bundler decision, price-oracle rail, deployed-address registry                        | Part One §4C     |
| 6   | **Board:** resolve the guardian contradiction — doctrine wins; he may design user-elected guardians where the platform is never one, or the item closes | Part One §4D     |
| 7   | **Board + ownership doc + LIVE-LANES:** strike every #346 instruction; it merged 2026-08-06 with his source intact                                      | §8               |
| 8   | **Board:** new "Waiting on Nitro" section listing the six owner-gated blockers                                                                          | §10              |
| 9   | **CODEOWNERS:** add `services/svc-indexer/`, and pre-add `services/svc-chain/` + `services/svc-bridge/`; **fix three wrong plane labels**               | Part One §4E     |
| 10  | **Delete the stranded `feat/protocol-amm` remote branch**                                                                                               | §8               |

### GitHub visibility (same PR or right after)

Eleven issues, one per tier (A–K), each assigned to `shehzad002`, each linking its board section and filed under the matching phase milestone — Phase 3P, 4P and 5P currently hold **one issue between them**.

### Then one message to Shehzad — short, additive, no retraction

Content, in this order: (1) #346 is merged, your source landed unmodified, nothing owed; (2) what is already on main so you do not rebuild it — AMM proof, launch factory, toolchain, smart-account foundations; (3) your real greenfield front: escrow, lending, router, merchant contracts, plus these newly-named items; (4) these blockers are mine, not yours, and here is where they stand; (5) unchanged: sole mountain, ADR-before-P1, proof bars, Class X.

**Note on your original confirm-back:** keep it. It is still the right ask, and he has not answered it.

---

## 13 · What the PR that carries this document actually changed

Recorded here so the claim in §12 can be checked rather than trusted.

### `tooling/tracker/features.mjs`

| Row                               | Change                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `protocol.smart-accounts`         | Evidence note added: what is on main (#210, #193, #128, userop hashing) and the six things that actually remain              |
| `protocol.amm`                    | Evidence note added: compile fix #228, factory #264, **mint/swap proven on a real chain #288**; remainder is invariants + LP |
| `socket.contract-toolchain`       | Owner set · **stale claim corrected** — it still said the AMM pool was undeployable eight days after #228 repaired it        |
| `socket.contract-audit`           | Owner set · marked as having an owner-gated half (audit budget is Nitro's)                                                   |
| `socket.userop-differential-test` | Owner set · failure mode stated (sign one operation, execute another)                                                        |
| `socket.p256-verifier`            | Owner set · named S-A9 · records that "passkey smart accounts" is not yet true **on-chain**                                  |
| `socket.social-recovery`          | Owner set · **doctrine contradiction resolved** — platform is never a guardian; user-elected guardians only                  |
| `socket.mpc-custody`              | Owner set                                                                                                                    |
| `socket.clob-contracts`           | Owner set, with the contract/adapter split stated so the adapter stays agent residual                                        |
| `socket.dex-fee-source`           | Owner set (S-I3)                                                                                                             |
| `socket.dex-execution`            | Owner set (S-I4) · records that closing it needs a Venue Vault **and a service that does not exist**                         |
| `socket.dex-venue-set`            | **Owner set to `Nitro`** — an unowned decision reads as unclaimed engineering, and this one is neither                       |
| `blueprint.attestations`          | Owner set — the board claimed it while the tracker said `ready` and free                                                     |
| `socket.indexer-stream`           | Deliberately left unowned, with the transport/event-surface split written into the row                                       |
| `launch.launchpad`, `launch.rwa`  | Plane corrected `F` → `P`                                                                                                    |
| `mining.pool`                     | Plane deliberately kept `F`, with the reason recorded                                                                        |
| **4 new rows**                    | `socket.paymaster-policy` · `socket.bundler-policy` · `socket.price-oracle` · `socket.deployment-registry` — all owner-set   |

`docs/TRACKER.md` regenerated; `tracker --check` passes.

### `docs/SHEHZAD-BLOCKCHAIN-TASK-BOARD-2026-08-03.md`

Delta banner · **§0.5 Waiting on Nitro** (six owner-gated blockers) · **§1.5 Already on main — do not rebuild** (the four Tier A items, with PR numbers and what actually remains) · **S-A9–S-A13** added to Tier A · **S-I3, S-I4** added to Tier I · recovery doctrine note replacing the guardian invitation · S-J3 aligned to it · attack order re-sequenced (it opened on AMM, which is proven; and it never contained the oracle that lending depends on) · §7 rewritten as CLOSED · §8 one-breath message rewritten · two rows added to the implicit-requirements table.

### Other files

- `docs/GITHUB-OWNERSHIP-SHEHZAD.md` — #346 section settled; M1 row updated; CODEOWNERS description corrected; cold-agent checklist line fixed
- `docs/LIVE-LANES.md` — `shehzad-346-handoff` lane closed; his lane row widened with the newly-owned rows; free-work item 6 updated; board-update entry added
- `.github/CODEOWNERS` — `svc-indexer` added (Tier C was invisible to him), `svc-chain` / `svc-bridge` pre-added, this audit doc added
- Remote branch `feat/protocol-amm` (2026-07-29, 797 commits behind, content already landed) deleted

---

# PART THREE — the scope was still not complete (2026-08-07, second pass)

## 14 · The correction I owed

Part One §4 checked the board against the **tracker**, and against the tracker it was complete. It was not complete against the **law**.

This repo runs a gate that walks the definitive build and asks "does every named capability have a task behind it?" On 2026-08-07 it answered: **39 do not.** Those are recorded as gaps and frozen by name so the number cannot quietly grow — the repo knew. But _counted_ is not _assigned_: a chain engineer reading his board could not see any of them.

**Nine of the thirty-nine were blockchain work.** They are now rows with owners, and their gap entries are closed in the same PR. Gaps went **39 → 30**; tracker rows **139 → 148**.

| Law capability            | New tracker row            | Owner      | Why it matters                                                                                            |
| ------------------------- | -------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| §33 crew vaults           | `protocol.crew-vaults`     | shehzad002 | Turns an existing, finished social object into a balance sheet. The **exit split** must be designed first |
| §34 legacy vaults         | `protocol.legacy-vaults`   | shehzad002 | **Collides with the never-a-guardian rule.** An ADR settles it, not a PR — added as S-K7                  |
| §26 stealth handles       | `protocol.stealth-handles` | shehzad002 | The receiving half of privacy. **Cannot be retrofitted once addresses are public**                        |
| §35 launch trust layer    | `launch.trust-layer`       | shehzad002 | The law calls trust "the moat in meme season". The anti-rug architecture was missing, unrecorded          |
| §36 treasury yield vaults | `launch.treasury-yield`    | shehzad002 | The licence blocker was recorded for one half of the RWA pair and not the other                           |
| §27 Venue Vault           | `connect.venue-vault`      | shehzad002 | `venue.aggregation` has said "Venue Vault absent" in its own note since 2026-08-02 with no row behind it  |
| §25 custody operations    | `ops.custody`              | **split**  | Multi-sig contract + hot-wallet perimeter his; tiering and console agent; real keys Class X               |
| §25 fundraising           | `launch.fundraising`       | **none**   | Fiat-plane product. Its on-chain legs are his; the module is not                                          |
| §25 structured issuance   | `launch.structured`        | **none**   | Same. The entry itself asked for a socket row, and now has one                                            |

**Board:** new **Tier L** carries the six that are his, with S-K7 added to force the inheritance ADR before any vault code.

**The thirty that remain are not chain work** — trading engines (`execution.*`), quant and strategy tooling, mobile apps, CRM/marketing, tax, alerts, business banking, prediction markets, B2B infra. Whether those get owners is a product-scope question for Nitro and Denon; it is not a hole in the chain owner's board, and closing them here would have widened him past his own sole-mountain law.

## 15 · What "complete" now means, precisely

Shizu's scope is complete against **both** axes the repo can check: every tracker row that is chain work has an owner, and every law capability that is chain work has a tracker row. Anything still missing would have to be missing from the definitive build itself — which no tool in this repo can detect, and which is the honest limit of this audit.
