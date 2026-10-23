> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](GITHUB-CI-SPEND-CONTROL-2026-07-31.md).

# MEGA AUDIT — 2026-08-07 · Findings

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Plan and scope:** [`MEGA-AUDIT-2026-08-07-PLAN.md`](MEGA-AUDIT-2026-08-07-PLAN.md)
**Audited tip:** `6a4a360a` — _chore(ci): run the supply-chain audit on every PR so it can be required (#971)_, i.e. `origin/main` as of 2026-08-07
**Audited in:** a clean detached worktree at `.worktrees/mega-audit-2026-08-07`. Nothing in the main checkout was touched, nothing was committed, nothing was pushed.

Every claim below is tagged **RAN-IT** (a command was executed and this is its real output), **READ** (source was read at the cited line), or **DOC** (a document says so). Nothing here is inferred.

---

## The short version

**The code is in better shape than the machine that checks it.** Everything the repo can prove about itself is green — 27 of 27 doctrine gates, 48 of 48 test packages, typecheck clean. The matching engine survived 38 771 orders and 15 396 real fills with all nine of its invariants intact. The money arithmetic matched exact-maths oracles across 509 059 checks. That is genuinely good, and it is rare.

**The numbers.** 84 auditors produced **475 findings**. Every one was then sent to an independent checker whose job was to destroy it. **363 survived; 111 were killed.** Roughly one claim in four did not survive contact with the code — which is the point of running the checkers. Confirmed severity: **1 critical, 39 high, 164 medium, 158 low.**

**One confirmed CRITICAL, in the lending service.** A borrower asks for a huge loan against collateral they do not have. That attempt fails but leaves the huge amount saved. They retry with the same loan id and a tiny amount of collateral: the safety check reads the _new, tiny_ request and passes, the payout reads the _old, huge_ one. They put up dust and take the original amount, repeatable until the lending pot is empty. Verified by an independent checker and then re-verified line by line by me.

**Nobody can do this today** — lending needs a product row configured, and nothing in the system creates one yet. It is a **launch blocker**, not a live theft in progress. The code is finished and wired into the running service; the only thing standing between it and a real drain is that lending has not been switched on.

**Six of the 39 confirmed "high" findings are worth knowing by name.** Each was read against the real source by an independent checker:

- **The emergency stop can be walked around.** The kill-switch guard only inspects requests whose path begins `/api/`; a request shaped to reach the same place by another route never gets checked at all.
- **The internal message bus is open on every network interface with no password.** Anyone who can reach it can forge a "this trade filled" message, and the ledger will settle it as real.
- **A stolen login can give itself two-factor and then withdraw.** A thief holding a stolen session can register their _own_ authenticator app and use it to pass the step-up check that exists specifically to protect withdrawals.
- **"Log out" does not reliably log you out.** — _lead-verified_ On the live product surface the session is only cleared _inside the success branch_ of a network call. Its own comment three lines above promises the opposite: _"The local clear does NOT wait for the network call — a user who clicks sign out is entitled to be signed out on this device even if the service is unreachable."_ If that call fails or returns an error code, the user sees an error toast and **stays signed in**. This is the one finding in the audit you can check yourself, on a phone.
- **The percent buttons on the trading desk compute the wrong size.** They build the order quantity from a _count of decimal places_ rather than the value, so every percent-sized order on the six FX pairs is wrong.
- **A failed message is never retried.** Both the event bus and the trade recovery path mark work as "done" _before_ running it, so anything that fails once is silently never attempted again.

**Beyond that, several of the checks are green because they are looking at the wrong thing.** Of the findings that survived verification, more sit in the 27 gates than in the product itself. Four I confirmed by running the code:

1. **The secret scanner cannot see the hot-wallet key.** The names of the key that signs every payout and the phrase that derives every deposit address do not match its idea of what a credential looks like. Commit either one and it reports "clean". Three ordinary names — a database password, a service secret, an API token — are caught, so the gate looks like it works.
2. **The wall between the bought-in exchange and our own ledger is proved by a line that does nothing.** The check searches the config file for a name. The unused `import` line at the top contains that name. Remove the wall entirely, leave the import, and the check still says the wall is up.
3. **There is no maximum leverage on futures.** The 10× cap the direction document states was never implemented, and the public API advertises no limit. Someone can put up a small amount of money and control an enormous position.
4. **Funding payments quietly drain a trader's collateral, but the number the system uses to give it back is never updated.** After any funding period, closing a position pays out more than is actually there.

**One finding of mine was wrong and the audit's own verification caught it** — I claimed two money subsystems in the bank service had no tests; they are tested through a different entry point than I searched for. It is retracted in place (F8) rather than quietly deleted, because a corrected audit is worth more than a clean-looking one.

**What I did not do:** nothing was changed, committed or pushed. Docker was not running, so nine infrastructure test suites could not run — they are reported as _not run_, never as passing.

**The one thing worth knowing that is not a bug:** the branch your sessions sit on is **203 commits behind** the real main and adds nothing to it. I started auditing it, noticed, threw that work away and restarted against the current code.

---

## 0 · The scoping correction that changed the audit

**The branch in the main checkout is 203 commits behind `origin/main` and contributes zero commits to it.** — RAN-IT

```
HEAD  (docs/phase-b-v2-leverage-audit)  0e46b7a3  #762
origin/main                            6a4a360a  #971
behind: 203      ahead: 0
```

The audit began against that checkout and produced findings on code that had been superseded — the vendored directory had already been renamed `vendor/coinexchange` → `vendor/upstream-exchange` in **#771**, and four new doctrine gates had landed. The run was **stopped and restarted** against the true tip. Everything below is against `6a4a360a`.

What that wave changed, measured: **+142 source files, +77 test files, +4 doctrine gates, +2 packages** (`safe-regex`, `telemetry`). `svc-academy` went 2 858 → 15 894 lines; `svc-p2p` 5 603 → 15 074.

This is worth a line of its own because it is an operational fact, not a code defect: **the working tree the operator's sessions sit in is two hundred commits stale.** Any agent that orients there is reasoning about a repo that no longer exists.

---

## 0a · Remediation status — what has since been fixed, and by what

This audit was **read-only by design**; §6 of the plan says fixes are a separate
green light. That light was given the same day and the fixes below are on `main`.
Recorded here rather than in a separate document so that nobody reads a finding
and re-does work that has already landed.

| Finding                                                                      | Fix                                                                                                                                     | PR                                                            |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **F1** lock list not derived from the account-kind enum                      | one `ACCOUNT_KIND_CLASS` record, `satisfies Record<AccountKind, …>` — a new kind now fails to compile                                   | [#1018](https://github.com/Phantom-X-007/intafaced/pull/1018) |
| **F2** `proRata` pays zero-weight participants on a negative total           | dust ordered by remainder MAGNITUDE                                                                                                     | [#1018](https://github.com/Phantom-X-007/intafaced/pull/1018) |
| **F3** the money-property gate could not reach F2                            | weights draw `0n` as their own branch; allocation properties run on both signs; a 7th mutant plants the pre-fix sort                    | [#1018](https://github.com/Phantom-X-007/intafaced/pull/1018) |
| **F4** `brand` walks sibling worktrees, so `pnpm verify` cannot pass locally | skip any directory carrying its own `.git`, plus `.pnpm-store` / `.tools`                                                               | [#1016](https://github.com/Phantom-X-007/intafaced/pull/1016) |
| **F5** `tradeFill` fee exactly equal to the receivable                       | both guards `<= 0n`                                                                                                                     | [#1019](https://github.com/Phantom-X-007/intafaced/pull/1019) |
| **F6** two i18n gates inspect nothing and report clean                       | both report the denominator; an undeclared empty scope exits 1                                                                          | [#1016](https://github.com/Phantom-X-007/intafaced/pull/1016) |
| **F7** liquidating on a stored liq price discards profit                     | refuse a liq price on the wrong side of entry, and refuse any liquidation with `uPnL > 0n`                                              | [#1019](https://github.com/Phantom-X-007/intafaced/pull/1019) |
| **§4.2** retried loan draws the stored principal — **CRITICAL**              | refuse when a retry's principal differs from the persisted row's                                                                        | [#1021](https://github.com/Phantom-X-007/intafaced/pull/1021) |
| **§4.1 / Tier 1 #1** `secret-scan` blind to a bare `_KEY` and to `MNEMONIC`  | `key`/`mnemonic`/`seed` are credential words; trailing qualifier allowed; business keys enumerated. Same fix in `compose-secret-parity` | [#1022](https://github.com/Phantom-X-007/intafaced/pull/1022) |
| **§4.1 / Tier 1 #4** dual-book door proved by an unused `import`             | match the registration CALL and require `"/**"`                                                                                         | [#1023](https://github.com/Phantom-X-007/intafaced/pull/1023) |
| **§4.1 / Tier 2 #10** `migration-check` never opens a `.down.sql`            | opens all 60; `DELETE FROM` and unrestored constraint/index drops are destructive                                                       | [#1023](https://github.com/Phantom-X-007/intafaced/pull/1023) |

**One new disclosure was found BY a fix, not by a human.** Widening the credential
vocabulary surfaced `spark.system.md5.key` — the admin console's signature factor,
injected into eight admin controllers including `WithdrawRecordController`. It is
registered as **OWNER-9** in `docs/SECRET-ROTATION-READINESS-2026-08-03.md` §5 and
marked **PENDING OWNER DECISION**, deliberately not "accepted": the fix is a
rotation inside unreviewed third-party code, which is an owner action.

### Still open, and deliberately not attempted here

| Item                                                                                                                                   | Why it was left                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tier 1 #2** — no maximum leverage on the futures open path                                                                           | The doctrine's 10× cap is unimplemented and `public-rest.ts` advertises `max: null`. A real product change in `svc-trade`, which another session was actively editing; implementing it blind is the dual-edit the coordination law forbids           |
| **Tier 1 #3** — funding drains collateral while `margin_initial` is never reduced                                                      | **Live money loss, not latent.** Needs a schema change (`margin_current`, or an `UPDATE` path for `margin_initial` plus a `funding_paid` writer) and both planners repointed at it. Same reason as above, and it is the highest-value item remaining |
| **Tier 2 #7, #8, #9** — `vendor-java-money` four method names, `custody-scan` recipe list and Solidity idiom, `event-wiring` call site | Each needs real logic rather than a pattern tweak                                                                                                                                                                                                    |
| **Tier 2 #12** — copy `svc-pay`'s `ledger-client.test.ts` to the five services that move money over the same wire without one          | Mechanical but wide; five services, five test files                                                                                                                                                                                                  |

---

## 1 · Baseline — what is actually green

Established by running the checks, not by reading a status doc.

| Check                                  | Result                               | Evidence                                                                              |
| -------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------- |
| `node tooling/ci/gates.mjs`            | **27 / 27 pass** (12 093 ms)         | RAN-IT, at tip, in a clean worktree                                                   |
| `turbo run test --continue`            | **48 / 48 packages pass** (44.6 s)   | RAN-IT, at tip                                                                        |
| `turbo run typecheck`                  | **pass**                             | RAN-IT, at tip                                                                        |
| `pnpm verify` **in the main checkout** | **FAILS at the doctrine gates step** | RAN-IT — see F4                                                                       |
| Docker / Postgres                      | **not running**                      | 9 infrastructure suites could not run and are reported as _not run_, never as passing |

The nine suites that cannot report are named by the repo's own verdict block (`svc-pay` payments, six `svc-protocol` chain suites, two EVM rail suites), all under human CODEOWNERS lock. **That block is honest** — it refuses to count them in either column. That is a genuine strength and it is rare.

---

## 2 · Lead-verified findings

These five were found and confirmed by the lead agent personally, each by executing code against the real source rather than by reading it. Money and security findings are not delegated.

---

### F1 · `INVARIANT 2` is not a property of locked accounts — it is a property of one hand-maintained `Set`

**Severity: HIGH (latent today, critical when it fires) · READ + RAN-IT**
`packages/ledger-client/src/client.ts:107`, `:183`, `packages/ledger-client/src/types.ts:101`

The ledger's second invariant — _locked funds are always funded from the owner's own available balance_ — is what makes "locked" value provably still the user's. It is enforced by testing an account's `kind` against a hand-written list:

```ts
// client.ts:107
export const LOCK_KINDS: ReadonlySet<string> = new Set(['hold', 'escrow', 'stake', 'collateral']);
// client.ts:183  — the same list again, as a literal
assertPurposedLockKinds(entries, ['hold', 'escrow', 'stake', 'collateral'], …);
// types.ts:101   — the canonical enum it must agree with
export const ACCOUNT_KINDS = ['available', 'hold', 'escrow', 'stake', 'collateral'] as const;
```

**Three lists. Nothing checks that they agree, and nothing can:** `LOCK_KINDS` is typed `ReadonlySet<string>`, not `ReadonlySet<AccountKind>`, so adding a kind to `ACCOUNT_KINDS` produces no type error, no test failure and no gate failure.

**What happens when they drift** — demonstrated by running the real `assertValidPost` against a post that credits the house and debits a user lock pot, so the user gives up nothing:

```
kind 'collateral'  (in LOCK_KINDS)      refused   ("Unfunded lock for user:550e8400…:USDT")
kind 'margin'      (NOT in LOCK_KINDS)  ACCEPTED  <-- 1,000,000 USDT of locked value created, funded by nobody
```

The post still sums to zero per asset, so INVARIANT 1 passes, the hash chain verifies, reconciliation replays clean and all 27 gates stay green. **There is no reading of the book from which you could tell.**

**Why this is not theoretical.** The source comment at `client.ts` already anticipates the next lock kind: _"Futures positions take `position:<id>` when they arrive; the shape is already right for them."_ A new lock kind is on the roadmap, and the roadmap is the trigger.

**Fix.** Derive one list: `export const LOCK_KINDS = ['hold','escrow','stake','collateral'] as const satisfies readonly AccountKind[]`, use it in both places, and add an exhaustiveness switch over `AccountKind` so adding a kind forces a decision rather than a silent default.
**Cheapest check that would have caught it:** a three-line test asserting `ACCOUNT_KINDS.filter(k => k !== 'available')` equals `[...LOCK_KINDS]`.

---

### F2 · `proRata` hands dust to zero-weight participants when the total is negative

**Severity: MEDIUM (latent — the one production caller guards it) · RAN-IT**
`packages/ledger-client/src/money.ts` — `proRata()`

Minimal reproduction against the real function:

```
total  0.000000000000000003   weights [88, 7, 0, 5, 0]  -> shares [3, 0, 0, 0, 0]      correct
total -0.000000000000000003   weights [88, 7, 0, 5, 0]  -> shares [-2, 0, -1, 0, 0]    WRONG
                                                                        ^ weight 0, receives -1
```

Index 2 has **weight zero** and receives value, while the participants weighted 7 and 5 receive nothing.

**Mechanism.** For a negative total, each `numerator = total * weight` is negative, so `numerator % totalWeight` is negative — except for zero-weight entries, whose remainder is exactly `0`. The dust loop sorts remainders **descending**, so `0` sorts _first_, and the zero-weight participants are paid before anyone else.

**Scale.** 594 failing cases in a 509 059-check fuzz; 42 817 of 58 713 negative-total splits misallocate. **Zero** positive-total splits do. Conservation is never violated — the shares always sum back to the total exactly — which is precisely what makes it dangerous: **the ledger accepts the misallocation.**

**Current reachability.** `distributeYield()` in `services/svc-token/src/economics/buyback.ts` is the only production caller and it opens with `if (totalYield < ZERO) throw new RangeError(...)`. So this is **latent, not live**. But `proRata` is exported from the package's public API, its doc comment promises only that shares "sum back to exactly `total`", and a clawback, reversal or negative funding settlement is the obvious next caller.

**Fix.** Either refuse a negative total in `proRata` itself (matching its only caller's rule), or sort by `abs(remainder)` and skip zero-weight entries in the dust loop.

---

### F3 · The repo's own money-property mutation gate cannot find F2 — the generator forbids the input

**Severity: HIGH (a trusted guard with a precise blind spot) · READ**
`packages/ledger-client/src/money.property.test.ts:39`, `tooling/ci/money-property.mutation.mjs`

This is the most sophisticated guard in the repo: property tests over the money primitives, plus a mutation gate that plants six defects in `money.ts` and fails if the property suite does not kill every one. It is green, and two of its six mutants target `proRata` specifically.

It still cannot see F2, for two independent reasons:

1. **The weight generator cannot produce a zero weight.**
   ```ts
   const weights = () => fc.array(fc.bigInt({ min: 1n, max: 10n ** 24n }), …);   // min: 1n
   ```
   Zero weight is outside the search space, so no property can ever be evaluated on it.
2. **The two properties that constrain _allocation_ — "no share is off its exact entitlement by more than one unit" and "hands the leftover units to the largest remainders" — both use `positiveAmount()`.** Only the _conservation_ property uses `anyAmount()` (both signs), and conservation holds under F2.

So the defect sits exactly in the intersection of the generator's two blind spots. **The gate is not weak; its input domain is narrower than the function's.**

The suite's own comment shows this pattern has bitten once already: _"That mutant survived this suite until this test."_ F2 is the next one in the same series.

**Fix.** Allow `0n` in the weight generator, add the property _a zero weight receives exactly zero_, and extend the allocation properties to `anyAmount()`. Then add a seventh mutant that reverses the negative-total dust order, so the gate can prove it stays fixed.

---

### F4 · `pnpm verify` cannot pass in the main checkout, and it fails before any test runs

**Severity: MEDIUM (process, not product) · RAN-IT**
`tooling/ci/brand-scan.mjs` — `SKIP_DIRS`

`CLAUDE.md` non-negotiable #4 is _"Run `pnpm verify` before claiming done."_ In the operator's main checkout, that command exits 1:

```
✖ BRAND SCAN FAILED — 1519 occurrence(s) of a forbidden name (Doctrine §0.7)
✖ pnpm verify FAILED at: doctrine gates  (pnpm gates)
```

**Where the 1519 come from** — RAN-IT, grouped by top-level directory:

| Directory      | Hits | Tracked in git? |
| -------------- | ---: | --------------- |
| `.worktrees/`  | 1491 | no — gitignored |
| `docs/`        |   25 | yes             |
| `.pnpm-store/` |    2 | no — gitignored |
| `.tools/`      |    1 | no — gitignored |

**98.4 % of the failure is directories that are gitignored and therefore do not exist in CI.** `SKIP_DIRS` lists `node_modules`, `.git`, `dist`, `.next`, `.turbo`, `coverage`, `drizzle`, `.docker-data` — but not these three. The same gate passes cleanly in a fresh worktree (verified: 27/27 green), which is why CI never sees it.

**Why it matters more than a noisy gate normally would:** `verify` **halts at the gates step**, so typecheck and the entire 48-package test suite never run. An agent that obeys the rule sees a red that has nothing to do with its work and learns nothing about whether its code is correct. The only paths forward are to ignore the command or route around it — and the header of `gates.mjs` says this file exists precisely to stop local and CI diverging.

**Second-order effect:** the 25 `docs/` hits are internal audit documents naming a model vendor or the upstream exchange. The gate has an `ALLOWLIST` with per-file reasons for exactly this class, but it is hand-maintained, so **every new internal document trips the gate until someone adds a line.** That is a permanent red, not an incident.

**Fix.** Add `.worktrees`, `.pnpm-store`, `.tools` to `SKIP_DIRS` (one line). Separately, decide whether `docs/` is shipped copy at all — if not, scope the gate to shipped surfaces instead of maintaining an allowlist that must grow forever.

---

### F5 · `tradeFill` can build a ledger post the ledger will always refuse

**Severity: MEDIUM (narrow input, but the documented recovery does not apply) · READ + RAN-IT**
`packages/ledger-client/src/recipes/index.ts:206` (`tradeFill`) and `:354` (`marketMakerMakerFill`) — the same defect, twice

```ts
const takerReceives = sub(makerPaysAmount, takerFee);
const makerReceives = sub(takerPaysAmount, makerFee);
if (takerReceives < 0n || makerReceives < 0n) {
  // <-- strictly less than
  throw new InvalidEntryError('Fee exceeds fill value — check fee bps configuration');
}
```

The guard catches a fee _larger_ than the receivable but not one _equal_ to it. When they are equal the recipe emits a **zero-amount entry**, and `assertBalanced` in `client.ts` throws:

> `Zero-amount entry on … — a movement of nothing is not a movement`

**Reachability.** `mulBps` rounds `ceil` by design, so any 1-wei receivable with a non-zero fee rate produces `fee == amount`. Fuzzing the recipe layer produced 2 329 such cases. Upstream, `settleFill` in `services/svc-trade/src/spot/trade-service.ts:822` guards `if (quoteAmount <= 0n)` and raises `trade.dust_fill` — it catches **zero**, not **one wei**.

**Why it is worse than a rejected post.** `settleFill` inserts the fill rows into `trade.fills` _before_ posting to the ledger. The README documents that ordering as deliberately safe: _"Worst case the funds stay in `hold`; re-running the fill re-posts the same idempotency key and heals it."_ For this failure class **re-running throws again, every time** — the fill is permanently unpostable and the fills table stays permanently ahead of the ledger. The documented recovery story does not cover it.

**The database permits exactly the configuration that triggers it.** `drizzle/0000_trade_init.sql:95` constrains the market grid to `CHECK ("tick_size" * "lot_size" >= 0.000000000000000001)` — the product may be **exactly one wei**. That constraint exists to stop a grid that yields a _zero_ quote amount, which is the same case `settleFill` guards and the same case `assertBalanced` rejects. **All three guards stop at zero and none of them covers one.** A market listed at the minimum legal grid is the trigger condition, not an exotic one.

It remains MEDIUM rather than HIGH because it needs that minimum-grid listing (or a fee rate above 50 %) to reach — no such market is known to be listed today.

**Fix.** Change both guards to `<= 0n` and raise the existing clear error, so the failure surfaces as _"fee exceeds fill value"_ at the recipe rather than as _"a movement of nothing"_ four layers down.

---

### F6 · Two of the twenty-seven gates inspect nothing and report "clean"

**Severity: MEDIUM (false green light) · RAN-IT + READ**
`tooling/ci/i18n-scan.mjs:47`, `tooling/ci/i18n-bypass-scan.mjs:80`

Both gates pass. Here is what they actually print:

```
✓ i18n-scan clean — 0 files, 0 hardcoded user-facing strings (§9, §14.4)
✓ i18n-bypass — 0 file(s), 0 hardcoded string(s), at the frozen baseline (0)
```

**Zero files.** The mechanism is a three-step collapse:

1. Both gates scan exactly one root: `const APPS = join(ROOT, 'apps')`.
2. `apps/` now contains exactly one project — `apps/admin` — because `apps/web` was deleted in **#757**.
3. Both gates allowlist `apps/admin` in full: _"operator console — internal tooling, English-only by design (§14.6)"_.

So the scope is empty, and **neither gate checks whether it scanned anything** — verified: no `scanned === 0` branch exists in either file. They take the `findings.length === 0` success path and exit 0.

`i18n-scan` does have a guard for an empty scope, but only for a _missing_ directory:

```js
if (!existsSync(APPS)) { console.log('✓ i18n-scan — no apps/ yet; the scan re-arms when the first surface lands (§9)'); … }
```

The author anticipated "nothing to scan" — but not the case where the directory exists and everything inside it is allowlisted. That is the state the repo is in now.

**This is not a one-off — it is this repo's recurring failure mode, now found three times.**

1. Commit `98a6812c`: _"fix(ci): the reachability gate inspected zero modules on Windows"_ — a gate green while inspecting nothing. **Fixed.**
2. `value-gate.mjs`, recorded in its own `NOT_GATES` entry: under `actions/checkout`'s default `fetch-depth: 1` it _"compared an empty ancestor list against an empty ancestor list and printed OK"_ — and that is named as **half of how PRs #832–#876 landed**. **Fixed** by pinning `fetch-depth: 0`.
3. **`i18n-scan` and `i18n-bypass-scan`, today.** Not yet fixed.

Three independent gates, three empty denominators, one of which is documented as having let a run of PRs through unchecked. The pattern is worth a standing rule, not another one-off fix: **a check that cannot state how many things it inspected cannot be trusted to say they were fine.**

**Calibration — what this is NOT.** It is not "i18n is unguarded and nobody noticed". The real i18n debt is known and honestly disclosed: `shell-i18n-scan.mjs` sits in `NOT_GATES` with the reason _"tip currently has 200+ hardcoded user-facing strings across the shell, so wiring it as blocking would red main… promote to GATES once the count is zero."_ That is exactly the honesty the `NOT_GATES` manifest was built to force, and it is working. The defect is narrower and purely about signal: **two entries in the "27 / 27 gates passed" headline are green because they looked at nothing**, and their wording reads as reassurance rather than as an empty scan.

**The full sweep — all 27 gates checked for an empty denominator.** RAN-IT. Every other gate reports a real, non-zero count of things inspected: reachability 390 modules · brand 1 219 files · secrets 2 030 source + 183 config files · vendor-shell 1 145 files · vendor-java-money 870 Java files · skip-honesty and test-db 274 test files · fabricated-money 95 shell files · migrations 48 · workspace 18 services · dual-book-door-paths 40 fragments. **Only `i18n` and `i18n-bypass` report zero.** Two gates of twenty-seven.

**The lesson already exists in this repo — it just was not generalised.** `wallet-rpc-mainnet-scan` states in its own success line: _"16 module(s), 229 Java + 13 properties file(s) walked, **every denominator non-zero**"_ — that gate explicitly asserts it inspected something, and its mutation companion plants a "walk guard" defect to prove the assertion works. The correction is to apply that same discipline to the other 26.

**Fix.** One line in each i18n gate: exit non-zero (or print a loud `⚠ scanned 0 files — scope is empty`) when `scanned === 0`, matching what `98a6812c` did for reachability and what `wallet-rpc-mainnet-scan` already does by design.

---

### F7 · Liquidating on the stored liq price silently discards a user's profit

**Severity: MEDIUM (latent — the column is never written today) · RAN-IT**
`services/svc-trade/src/futures/liquidation-planner.ts:92`

`planLiquidation` realizes **losses only**:

```ts
const loss = uPnL < 0n ? -uPnL : 0n;
const fromMargin = loss >= position.margin ? position.margin : loss;
const fromInsurance = loss > position.margin ? loss - position.margin : 0n;
const residualRelease = position.margin - fromMargin;
```

There is **no branch anywhere in this function that credits a positive PnL** — no `futuresRealizeProfit`, no gain leg. So if it can ever fire while a position is in profit, that profit is silently dropped.

**It can.** 2 148 of 40 000 fuzzed cases liquidated a position with `unrealizedPnl > 0`:

```
side=long  entry=80  mark=120  size=1  margin=10  liqPrice=120
  -> reason=mark_crossed_liq_price   uPnL=+40   loss=0   residualRelease=10   recipes=1
     the +40 gain is credited by NONE of those recipes
```

The user is up 40 USDT. They get their 10 USDT margin back and **nothing else**. No error, no refusal, no log — the plan is well-formed and the recipes balance.

**The equity path is correctly designed and is not the problem.** With `liqPrice` disabled entirely: **0 of 20 000** profit-liquidations. That is guaranteed by the arithmetic — `equity = margin + uPnL`, so `uPnL > 0` implies `equity > margin ≥ maintenance` for any `maintenanceBps ≤ 10 000`. The equity trigger _cannot_ fire in profit.

**The stored liq price is an independent trigger that bypasses the equity check entirely**, and the only validation applied to it is `> 0n`:

```ts
if (position.liqPrice != null && position.liqPrice > 0n) {
  const crossed = position.side === 'long' ? mark <= position.liqPrice : mark >= position.liqPrice;
  if (crossed) {
    should = true;
    reason = 'mark_crossed_liq_price';
  }
}
```

Nothing checks that a long's liq price is _below_ its entry, or a short's _above_. A stale value (after a margin top-up or a partial close), a wrong sign, or a short's price written onto a long all fire it.

**Why it is MEDIUM and not HIGH — verified, not assumed.** `liq_price` exists as a nullable column (`db/schema.ts:370`, migration `0003_trade_futures_positions.sql`) and is read by `position-loaders.ts`, but **no code in `services/svc-trade` ever writes it** — grepped for every `INSERT`/`UPDATE`/`SET` touching `liq_price`: none. The column is always `NULL`, so the trigger never fires today. This is a loaded mechanism with no round in the chamber — and populating `liq_price` is the obvious next step for a futures product.

**Fix (two lines, both worth having).** Refuse the plan when `uPnL > 0n` and the only trigger was `mark_crossed_liq_price` — a profitable liquidation is a data bug and should surface as one, not as a silent transfer. And validate on load that a long's `liqPrice < entryPrice` and a short's `> entryPrice`.

**Adjacent observation (LOW, same files).** `initialMargin`, `notionalAt` and `unrealizedPnl` do their arithmetic with raw bigint `/` rather than the `mul`/`div` helpers in `money.ts`, so they inherit JavaScript's truncate-toward-zero instead of a stated rounding mode. `money.ts` opens with _"Rounding is always explicit. There is no default rounding mode, because 'whichever way the language rounds' is how a book drifts."_ The economic effect here is under one wei per operation and the truncation is sign-symmetric, so this is a doctrine deviation rather than a live loss — but it is in the futures money path, and it is the shape the doctrine names.

---

### F8 · Nothing in the repo measures code coverage, and one gate's name says otherwise

**Severity: MEDIUM · RAN-IT**
`tooling/ci/coverage-check.mjs`

> **RETRACTION — the first version of this finding was wrong, and the audit's own verification caught it.**
> It claimed `svc-bank`'s Earn and Transfers subsystems (1 035 lines, 11 ledger posts) had **no tests at all**, based on a grep for test files importing `earn-service.ts` / `transfer-service.ts` by filename. That grep was the error: both are exercised through the service facade in `bank-service.test.ts`, which imports `bank-service.ts`, which imports both — including `bank.transfers.transfer(...)` and an explicit idempotency case (_"a retried request moves value once"_). **Earn and Transfers are tested. The claim is withdrawn.**
> The supporting ratio was also misleading: `svc-bank` is **8 537 non-test source lines against 4 676 lines of tests and 238 test cases**, not "13 283 lines with 6 test files" — my line count included the test files themselves. An independent verifier re-measured it, sampled the test bodies, and found no `.only`, no `expect(true)`, no uncommitted snapshots, no assertion-free case, and arithmetic pinned to hand-computed literals. **`svc-bank`'s tests are good.** The premise that it was thinly tested was mine and it was wrong.

What survives, and it is independently confirmed by a fleet auditor on the same file:

**The repo has a green doctrine gate called `coverage` and no code-coverage enforcement anywhere.** Verified:

- There is **no vitest coverage configuration anywhere in the repo** — no thresholds, no v8/istanbul reporter, nothing.
- The doctrine gate **named `coverage` does not measure code coverage.** It maps law chapters to tracker rows (§25:740) — a genuinely valuable check, and it is well built. But `grep -icE "statement|line coverage|istanbul|v8 coverage|threshold"` over `tooling/ci/coverage-check.mjs` returns **0**.

So the repo has a green gate called "coverage" and **no code-coverage enforcement at all**. That is a naming trap: a reader scanning "27 / 27 gates passed" including one called `coverage` will reasonably conclude that test coverage is gated. It is not. `coverage-check` is a genuinely valuable gate — it is simply not the thing its name suggests.

**The real, verified coverage gap it leaves unseen** is narrower than my retracted claim and sits one layer down: **`svc-bank`'s only production path to the ledger has no test.** `services/svc-bank/src/ledger-client.ts` is the HTTP transport every real transfer, earn deposit, interest accrual, loan draw and liquidation goes through in production, and all 238 `svc-bank` cases substitute `MemoryLedger` instead — `grep -rn "ledger-client.js'" --include='*.test.ts' services/svc-bank/src` returns nothing. A verifier confirmed the fact and then corrected the framing around it: **`svc-bank` is not the outlier.** `svc-bank`, `svc-agents`, `svc-trade` and `svc-token` all lack a wire test; `svc-p2p`'s covers only error rehydration. **`svc-pay` is the only service in the repo with a real one** (370 lines asserting amounts serialise as decimal strings, that no JSON number appears in the payload, and that 18 decimals survive the trip).

**Fix.** Copy `svc-pay`'s `ledger-client.test.ts` pattern to the other five services — it is the one test that proves money survives the wire, and five services move money without it. Separately, decide whether a code-coverage floor is wanted at all; if it is, put it on the money packages only, because a repo-wide percentage is the kind of number teams learn to game.

---

## 3 · Verified clean — negative results worth having

A confirmed-clean result on a money path is worth as much as a finding, and these were established by execution, not by reading.

| Area                                  | Method                                                                      | Result                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Matching engine**                   | 400 randomised books, **38 771 orders → 15 396 real fills**                 | **9 / 9 invariants held**: no overfill, no self-trade, no fill outside a taker's limit, fill price always the resting maker's, book remainder always `qty − filled`, aggregated depth always equal to live remainders, no duplicate sequence numbers, snapshot/restore an exact round-trip, no zero-qty fill                                                                                                      |
| **`money.ts` arithmetic**             | 509 059 checks against **exact-rational oracles** (not a re-implementation) | `mul`, `div` and `mulBps` match exact `floor` / `ceil` / `half-up` on both signs, in every case. Parser refuses `1e5`, `+1`, `.5`, `1.`, `1,5`, over-precision and every other lossy form; format/parse is an exact inverse                                                                                                                                                                                       |
| **Recipe double-entry**               | all **45 exercisable recipes** of 48, 17 652 generated posts                | Every recipe balances to zero per asset, every time                                                                                                                                                                                                                                                                                                                                                               |
| **Idempotency keys**                  | 17 652 posts, key-vs-entries differential across every input field          | **No collision.** Keys that omit `amount`/`userId` do so correctly — the business id is the event identity, and a retry _should_ dedupe regardless of amount                                                                                                                                                                                                                                                      |
| **`mintEmission` epoch key**          | traced to its caller                                                        | Keying on `epoch` alone is intentional and **double-guarded** by a `SELECT … FOR UPDATE` on the epoch row plus a `closed` check. Not a finding — recorded because it looks like one                                                                                                                                                                                                                               |
| **Server-side invariant enforcement** | READ `services/svc-ledger/src/ledger/postgres-ledger.ts:52`                 | `assertValidPost` runs **server-side**, not only in the client library. The guard is on the door, not just on the key                                                                                                                                                                                                                                                                                             |
| **Kill-switch (§14.6)**               | RAN-IT `control-plane.e2e.test.ts` + `kill-switch.test.ts`                  | **66 tests, 0 skipped, all pass.** The gate's claim that "the behavioural proof exists and is not skipped" is true. The gate itself is well built: it strips comments before matching (a naive regex version was caught by its own negative test), requires the switch to be an `onRequest` hook at the door rather than a guard inside one handler, and requires it to **fail closed** — `catch … refused: true` |
| **`verify` honesty block**            | RAN-IT                                                                      | Names all 9 infrastructure suites it cannot account for and refuses to count them in either column                                                                                                                                                                                                                                                                                                                |
| **`fabricated-money` gate**           | RAN-IT                                                                      | Walks 95 real shell files. Its "0 across 0 files" line refers to the frozen-baseline queue, not to files scanned — correctly designed, and specifically checked because it _reads_ like F6                                                                                                                                                                                                                        |

Two candidate findings were **killed by the lead during verification** and are recorded so they are not re-raised: an apparent double-entry break in `mintEmission` (an artifact of the harness passing a string where an `AccountRef` was required), and the engine accepting an out-of-vocabulary `tif` (real, but ingress validates against a zod enum at `services/svc-matching/src/router.ts:195`, so it is defence-in-depth only — logged as LOW).

---

## 3b · Open items that are already disclosed and wait on a human

These are **not findings** — the repo already knows about each one and has recorded it honestly. They are listed because they sit in the Class X lane (owner actions), which is the operator's to move, and because a reader skimming "27 / 27 gates passed" would not otherwise see them.

| Item                                                                      | Where it is recorded                                                                                              | What it means                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One wallet RPC module (`act`) has an unproven authenticated perimeter** | `tooling/ci/wallet-rpc-auth-scan.mjs` `FROZEN` W1; owner action in `docs/OWNER-ACTIONS-WALLET-RPC-SECRETS.md` §A4 | Its `pom.xml` declares `rpc-common` twice — `1.0` at lines 49–53 and `1.2` at 77–81. Maven resolves the first, so it builds against a version **that does not exist in this reactor and whose contents nobody here can read**. The gate names it as RECORDED UNPROVEN rather than counting it green, and the fix is an edit inside unreviewed third-party key-handling code — deliberately an owner action, not an agent's |
| **5 known-disclosed credentials awaiting rotation**                       | `secret-scan` summary                                                                                             | Counted, not hidden                                                                                                                                                                                                                                                                                                                                                                                                        |
| **8 forbidden names frozen in 4 product-surface files**                   | `shell-brand-scan`                                                                                                | User-facing copy; frozen baseline that can only shrink                                                                                                                                                                                                                                                                                                                                                                     |
| **200+ hardcoded user-facing strings in the Vue shell**                   | `shell-i18n-scan.mjs`, parked in `NOT_GATES` with a written reason                                                | Wiring it as blocking today would red main. Promote once the count is zero                                                                                                                                                                                                                                                                                                                                                 |
| **12 dependency advisories (8 high, 2 on production paths)**              | supply-chain ratchet, `.github/workflows/supply-chain.yml`                                                        | Frozen as a ratchet rather than a severity gate, because `--audit-level=high` would have red-mained on day one. New advisories fail; the list can only shrink                                                                                                                                                                                                                                                              |
| **1 Class B event defect (`crewMemberCreated`)**                          | `event-wiring` `CLASS_B_AWAITING_A_DECISION`                                                                      | Awaiting a named decision; the list cannot grow                                                                                                                                                                                                                                                                                                                                                                            |

**Methodology note, verified not assumed:** the fleet's shell working directory defaults to the main checkout, which is the stale tree. This was checked rather than trusted — the `svc-bank` auditor's own `find` returned **28** TypeScript files, and 28 is the tip's count (the stale tree has 22). The auditors are reading the correct tree.

---

## 4 · Fleet results — 84 auditors, adversarially verified

Eighty-four parallel auditors ran against tip `6a4a360a`, producing **475 raw findings**. Each was then sent to independent verifiers whose brief was to **kill it**.

**The honest count, because it matters more than the headline:**

|                                                          |   Count |
| -------------------------------------------------------- | ------: |
| Raw findings produced                                    |     475 |
| **Confirmed by adversarial verification**                |  **59** |
| Genuinely refuted by a verifier                          |      11 |
| **Verifier never ran** (agent died on the session limit) | **405** |

The 405 are _not_ refuted and must not be read as such — the workflow's own arithmetic counted a dead verifier the same as a refutation, which would have overstated confidence enormously. **A second verification pass was run over all 405 and completed with zero errors** (§5): 304 confirmed, 100 refuted, 1 unjudged.

**Final position across both passes:**

|                                           |   Count |
| ----------------------------------------- | ------: |
| Raw findings                              |     475 |
| **Confirmed by adversarial verification** | **363** |
| Refuted on inspection                     |     111 |
| Unjudged                                  |       1 |

Confirmed severity, combined: **1 critical · 39 high · 164 medium · 158 low.** Every one was read against the real source by a verifier briefed to kill it; roughly **one claim in four did not survive**.

Of the 59 confirmed, verifiers **downgraded 4 of 4 reported criticals** to high or medium, and downgraded 14 findings overall. That is the verification working: severity inflation is the most common failure in this kind of sweep, and it was caught rather than passed on.

### 4.1 · The headline: the safety apparatus is the largest cluster of confirmed defects

**33 of the 59 confirmed findings are in `tooling/ci/` — the 27 gates that certify everything else.** Only 25 are in the product. The thing most likely to be wrong in this repo is the machine that says nothing is wrong.

Six that matter most, each a gate that is green and does not do what its name says:

**`secret-scan` is blind to the hot-wallet key.** — _lead-verified_ Its credential-name pattern requires the credential word to _end_ the name, and neither a bare `_KEY` suffix nor `MNEMONIC` is in its vocabulary. Tested against the real regex with controls, so a pass and a fail both appear:

```
  MISSED  PAY_CRYPTO_HOT_WALLET_KEY     signs every payout
  MISSED  PAY_CRYPTO_DEPOSIT_MNEMONIC   derives every deposit address
  MISSED  WALLET_SIGNING_KEY
  MISSED  STRIPE_SECRET_KEY_LIVE
  MISSED  JWT_SIGNING_KEY
  CAUGHT  DATABASE_PASSWORD             (control)
  CAUGHT  INTERNAL_SERVICE_SECRET       (control)
  CAUGHT  API_TOKEN                     (control)
```

Both wallet names are real and in production use (`services/svc-pay/src/env.ts:103,105`; `rails/posture.ts:515-516`). Commit either into a tracked `.env` or a compose block and **`secret-scan` prints "clean"**. For a platform holding crypto, this is the most dangerous confirmed finding in the audit. `compose-secret-parity` shares the same regex shape and the same blind spot.

**`dual-book-door-scan` is satisfied by an unused import.** — _lead-verified_ The dual-book door is the boundary between the vendored exchange's own wallet tables and the sovereign ledger — architecturally the most important guard in the system. The gate's entire registration test is `text.includes('DualBookMoneyDoorInterceptor')` over the whole file (`:75`), and the config also carries `import …DualBookMoneyDoorInterceptor;` at line 16.

Proved by taking the door off its hinges in memory and re-running the check:

```
registration line still present after gutting?               false
gate check  text.includes("DualBookMoneyDoorInterceptor") -> true
what still satisfies it: ['import com.bizzan.bitrade.interceptor.DualBookMoneyDoorInterceptor;']
```

Delete the real `registry.addInterceptor(new DualBookMoneyDoorInterceptor()).addPathPatterns("/**")` line, leave the import Java happily compiles unused, and the gate still prints _"✓ interceptor + registration on admin, ucenter-api, otc-api, exchange-api."_

**`custody-scan` would pass a real ledger write out of `svc-dex`.** It matches `ledger.post(` only when the receiver is literally spelled `ledger` (`client.post(` is invisible), and its recipe list hardcodes 18 names when the package exports 48. Its Solidity check is worse: every withdrawal-power pattern requires an `onlyOwner`/`onlyAdmin` modifier, and **this repo's contracts contain zero `only*` modifiers** — they guard with `if (…) revert`. That check has never had a true positive available to it.

**`vendor-java-money-scan` only inspects four method names.** — _lead-verified_ Its own header claims it "closes re-arming by any phrasing at all." It does not. `WALLET_MUTATORS` at line 152 is exactly `['increaseBalance','decreaseBalance','freezeBalance','thawBalance']`, and line 613 reads `if (!mutator) continue;` — **the check is skipped entirely** for any DAO method not named one of those four. A fifth method with any other name writing `UPDATE member_wallet SET balance = …` sails through, which is the exact case the header says it closed.

**`event-wiring` proves the file is imported, not that the handler is ever called.** A `bus.subscribe(...)` inside an exported function that nothing invokes counts as "wired end to end" as soon as any reached file imports its module.

**`migration-check` prints "all 48 migrations reversible" from filename pairing alone.** — _lead-verified_ Reversibility is decided at line 41 by `up.replace(/\.sql$/, '.down.sql')` existing in a filename set. It reads the _up_ file only (line 51) and **never opens a single `.down.sql`** — so an empty file, or one containing a comment, satisfies "reversible". Its destructive list is exactly `[DROP TABLE, DROP COLUMN, TRUNCATE, DROP SCHEMA]`: **`DELETE FROM` is not in it**, nor is constraint removal. A migration that deletes rows from the ledger is not destructive as far as this gate is concerned.

**`brand-scan`** — independently confirms F4 above, with the same mechanism and a re-measured count (the number drifts with the number of worktrees; it must not be quoted as fixed).

### 4.2 · The most serious finding in the audit: a retried loan drains the lending reserve

**Severity: CRITICAL · confirmed by an independent verifier and then re-verified personally by the lead**
`services/svc-bank/src/loans/loan-service.ts:468-478, 490-499, 515`

**In plain terms:** a borrower asks for a huge loan against collateral they do not have. That attempt fails — but it leaves the huge loan amount saved. They then retry with the same loan id and a tiny amount of collateral. The safety check looks at the _tiny_ new request and passes it. The payout uses the _huge_ saved one. They put up dust and walk away with the original amount.

The mechanism, verified line by line:

1. **The loan-to-value check reads the new request.** Lines 468-478 compute `openingLtv` from `input.principal` and `input.collateralAmount` and refuse if it exceeds the product's limit.
2. **The row is written before the money moves, and a retry silently reuses it.** Line 490 inserts with a **caller-supplied** `loanId` under `ON CONFLICT (id) DO NOTHING`. On a retry nothing is inserted, so line 501 re-reads and `loan` becomes the **first call's** row — carrying the **first call's principal**.
3. **The payout draws from the old row while the collateral lock uses the new input.** Line 515 is `return this.completePending(loan, input.collateralAmount, openingLtv, now)` — the _old_ `loan` and the _new_ collateral, in the same call. `completePending` then locks `input.collateralAmount` and draws `loan.principal` (line 546).
4. **Nothing reconciles the two.** There is no check anywhere that a pending row's principal matches the principal of the request retrying it.

Attack, concretely: open loan `X` for 1 000 000 against 2 000 000 of collateral you do not hold — LTV passes, the row persists at 1 000 000, the collateral lock fails for insufficient funds, the loan stays `pending`. Retry loan `X` for 1 against 2 of collateral you _do_ hold — LTV passes on the new numbers, the insert conflicts and does nothing, and the service locks 2 units of collateral and **draws 1 000 000**. Repeat until the reserve is empty.

**Fix.** On the retry path, refuse when the persisted row's `principal` differs from `input.principal` — or re-derive LTV from `loan.principal` rather than `input.principal`, so the check and the payout can never read different numbers.

---

### 4.3 · The two most serious confirmed findings in trading

**No maximum leverage is enforced on the futures open path.** Verified personally: the only constraints anywhere are `leverage > 0` in `initial-margin.ts:12` and `CHECK ("leverage" > 0)` in the migration. `public-rest.ts:190` literally advertises `leverage: { min: null, max: null }`. The doctrine's 10× cap is unimplemented. _(Correction to the reported version: the column is `numeric(8,2)`, so leverage caps at 999 999.99 rather than being unbounded — functionally the same hole.)_ A user can lock 10 USDT and control millions in notional, and a favourable move is paid out of the house fee pot.

**Funding payments drain a position's collateral while `margin_initial` is never reduced.** Verified personally, all three legs:

- `futuresFundingPay` **credits** `positionCollateralAccount(payer, asset, positionId)` — that is value leaving the position's own collateral pot.
- `margin_initial` has **no `UPDATE` anywhere in the repo** — it is inserted at open and only ever read back.
- `funding_paid` has **no writer either** — it is inserted as `'0'` at open (`position-service.ts:372`) and read only for display.

Both the close planner and the liquidation planner compute the amount to release from `margin_initial`. So after any funding period the pot holds less than `margin_initial` says, and **every subsequent close releases more than is there** and overdraws. This is a live money-loss path, not a latent one — it needs only that funding runs once before a close.

### 4.4 · Every confirmed finding from the first pass, in full

The complete first-pass verified set — 11 high, 23 medium, 24 low. Each row was read by an independent verifier against the real source before it was allowed to appear here.

#### The gate defects, in full (33 confirmed)

| Gate                              | What it actually proves                                                                                                                                                                        | Sev    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `brand-scan.mjs:98`               | brand-scan is the only gate that walks the bare repo root, and its SKIP_DIRS omits the three gitignored dev directories the repo itself creates — 1583 false positives kill `pnpm verify` at s | high   |
| `custody-scan.mjs:108`            | custody-scan passes a real ledger write out of svc-dex — the one Protocol Plane service with no backup sovereignty test                                                                        | high   |
| `custody-scan.mjs:123`            | custody-scan check 2 (Solidity) matches an access-control idiom that appears nowhere in this repo's contracts — it has never had a true positive available to it                               | high   |
| `dual-book-door-scan.mjs:78`      | dual-book-door-scan proves registration with a substring match that the unused `import` line alone satisfies                                                                                   | high   |
| `event-wiring.mjs:835`            | event-wiring's "mounted, not merely defined" check is import-reachability, not invocation — a handler that is never called counts as wired end to end                                          | high   |
| `secret-scan.mjs:202`             | Both gates' credential-name regexes require the credential word to END the name — so the fleet's only signing key and its deposit mnemonic are not 'secret-shaped' to either gate              | high   |
| `vendor-java-money-scan.mjs:16`   | vendor-java-money-scan cannot catch a live `member_wallet` UPDATE on any DAO method not named one of four — the exact case its header claims to have closed                                    | high   |
| `agent-autoload-scan.mjs:85`      | agent-autoload-scan's "no law outside the repo" check is silenced by the word `token` appearing anywhere on the line                                                                           | medium |
| `coverage-check.mjs:468`          | coverage-check cannot detect a cited law line changing meaning — a cite is validated by line NUMBER only, never by content                                                                     | medium |
| `dual-book-door-path-unit.mjs:57` | No gate covers the interceptor's enforcement logic — a `preHandle` that refuses nothing keeps all three gates green                                                                            | medium |
| `dual-book-door-path-unit.mjs:50` | The path-unit's fragment floor is 25 against 40 actual, so 15 blocked money paths can be deleted with every gate green — including 4 that are the sole runtime control on allowlisted balance  | medium |
| `fabricated-money-scan.mjs:247`   | fabricated-money's increment rules miss the two most common ways a Vue 2 SFC hardcodes a tick/scale/fee — an object-property quoted literal and a plain assignment                             | medium |
| `gates.mjs:315`                   | gates.mjs keeps shell-i18n-scan unwired on a stale count — it claims the shell has "200+ hardcoded user-facing strings"; the scan actually returns 0 across 57 files                           | medium |
| `migration-check.mjs:43`          | migration-check prints 'all reversible' from filename pairing alone — it never reads a .down.sql, and nothing anywhere ever executes one                                                       | medium |
| `secret-scan.mjs:535`             | The config rule is line-bounded, so a YAML value on the following line or in a block scalar is never checked                                                                                   | medium |
| `skip-honesty-scan.mjs:127`       | skip-honesty-scan is silenced by the word "postgresAvailable" appearing in a COMMENT — comments are never stripped                                                                             | medium |
| `skip-honesty-scan.mjs:69`        | skip-honesty-scan knows only two probe shapes, and reports every unrecognised probe as "on shared journalled probes" — the summary line is a false claim                                       | medium |
| `vendor-shell-scan.mjs:70`        | vendor-shell-scan's CORS rule matches only `addAllowedOrigin("*")` — two live wildcard-origin WebSocket endpoints are in the tree right now and it prints clean                                | medium |
| `wallet-rpc-auth-scan.mjs:343`    | wallet-rpc-auth proves the auth guard by FILENAME only — a gutted RpcSecurityConfig.java still reports '12 of 13 bootable wallet RPC service(s) PROVE an authenticated perimeter'              | medium |
| `workspace-sync.mjs:331`          | workspace-sync's port and cross-service-URL checks are defeated by a cosmetically identical YAML reformat, and prettier accepts both forms                                                     | medium |

#### The product defects, in full (25 confirmed)

| Where                                                                                                                          | Finding                                                                                                                                                                               | Sev        | Reported as |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------- |
| `services/svc-trade/src/futures/close-planner.ts:78`                                                                           | Funding payments drain a position's collateral pot while `margin_initial` is never reduced, so every later close over-releases and overdraws the account                              | **high**   | critical    |
| `services/svc-trade/src/futures/funding-settlement.ts:111`                                                                     | Funding leg idempotency keys embed a position-set-dependent counter, so a retried period double-charges surviving pairs                                                               | **high**   | high        |
| `services/svc-trade/src/futures/initial-margin.ts:12`                                                                          | No maximum leverage is enforced anywhere on the futures open path — the doctrine's 10x cap is unimplemented                                                                           | **high**   | critical    |
| `services/svc-trade/src/futures/liquidation-tick.ts:242`                                                                       | One failing position aborts the entire liquidation scan, permanently starving every position behind it                                                                                | **high**   | high        |
| `packages/ledger-client/src/memory-ledger.ts:236`                                                                              | The tamper-evident hash chain does not cover the idempotency key, the meta, or the per-entry running balance                                                                          | **medium** | medium      |
| `packages/ledger-client/src/recipes/index.ts:525`                                                                              | One house account carries three incompatible meanings: spot fee revenue, the futures realized-loss sink, and the futures profit funding source                                        | **medium** | high        |
| `services/svc-ledger/src/index.ts:92`                                                                                          | An hourly snapshot write failure silently cancels that cycle's reconciliation — the platform's only conservation check is gated behind an unbounded, unpruned INSERT                  | **medium** | medium      |
| `services/svc-ledger/src/index.ts:34`                                                                                          | The money-plane connection pool sets no statement timeout, so one stalled backend holding the singleton chain-tip lock halts all value movement platform-wide with no bounded failure | **medium** | medium      |
| `services/svc-ledger/src/ledger/postgres-ledger.ts:285`                                                                        | post() never validates asset_id against ledger.assets — a mistyped or mis-cased asset silently opens a phantom parallel book that reconciles clean                                    | **medium** | high        |
| `services/svc-ledger/src/ledger/postgres-ledger.ts:363`                                                                        | The hash chain covers a strict subset of a transaction row — idempotency_key, meta and balance_after are unhashed — and the only tamper test mutates a field that IS covered          | **medium** | medium      |
| `services/svc-ledger/src/operator-http.ts:88`                                                                                  | The only reachable ledger freeze/unfreeze routes have zero tests; the freeze-authorisation tests all run against a router that is served on no port                                   | **medium** | high        |
| `services/svc-pay/src/ledger-client.ts:36`                                                                                     | svc-pay's ledger client still signs with the legacy replayable scheme — and its own green test certifies that scheme                                                                  | **medium** | high        |
| `services/svc-trade/src/futures/funding-settlement.ts:48`                                                                      | Funding is charged on entry-price notional, not current mark, so identical exposures pay wildly different funding                                                                     | **medium** | medium      |
| `services/svc-trade/src/futures/position-service.ts:345`                                                                       | `open()` locks margin before the position row exists, and a failed rollback strands the user's collateral with no recovery path                                                       | **medium** | medium      |
| `packages/events/src/catalog.ts:908`                                                                                           | The ledgerFreezeUpdated socket's written reason is factually false at this tip — apps/admin does make network calls, including to the ledger freeze endpoint                          | **low**    | medium      |
| `packages/ledger-client/src/accounts.ts:136`                                                                                   | subAccountHold returns an AccountRef that every post refuses                                                                                                                          | **low**    | low         |
| `packages/ledger-client/src/money.ts:33`                                                                                       | parseAmount enforces no magnitude bound, so the in-memory reference ledger accepts amounts numeric(38,18) cannot store                                                                | **low**    | low         |
| `packages/ledger-client/src/types.ts:170`                                                                                      | Idempotency is key-only with no request fingerprint, so a replay carrying a different body is reported as a successful post of a transaction that never happened                      | **low**    | low         |
| `services/svc-bank/src/bank-service.test.ts:1`                                                                                 | Scoping premise is wrong: svc-bank is not thinly tested                                                                                                                               | **low**    | low         |
| `services/svc-bank/src/ledger-client.ts:25`                                                                                    | svc-bank's only production path to the ledger has no test at all; every money test in the service substitutes MemoryLedger                                                            | **low**    | medium      |
| `services/svc-ledger/src/db/schema.ts:102`                                                                                     | assets.decimals is declared per asset and enforced nowhere — the ledger accepts 18-decimal amounts in a 2-decimal fiat asset                                                          | **low**    | medium      |
| `services/svc-ledger/src/service.ts:49`                                                                                        | The event publish runs after commit with no outbox, so a bus outage makes a COMMITTED transaction report itself as a failure to the calling service and permanently loses the event   | **low**    | medium      |
| `services/svc-pay/src/merchant-state-router.ts:89`                                                                             | The merchant suspend/reinstate admin surface has zero tests — including no test that it is not reachable with a merchant's own scope                                                  | **low**    | high        |
| `services/svc-trade/src/futures/position-service.ts:551`                                                                       | The deviation breaker's basis only advances when the liquidation job runs, so with jobs off a profitable close is refused forever after a 20% move                                    | **low**    | high        |
| `vendor/upstream-exchange/00_framework/core/src/main/java/com/bizzan/bitrade/interceptor/DualBookMoneyDoorInterceptor.java:91` | The door matches on the raw un-decoded request URI while Spring routes on the decoded path — percent-encoding one character bypasses it                                               | **low**    | medium      |

---

## 5 · Second verification pass — the 405 findings whose verifiers died

The first run's verifiers were killed mid-flight by a session limit, and the workflow's arithmetic counted a dead verifier identically to a refutation. Reporting those 405 as "refuted" would have been the single biggest false-confidence error this audit could make, so a second pass was run over all of them — one verifier per file, reading the real source, briefed to kill.

|                                        |   Count |
| -------------------------------------- | ------: |
| Findings re-submitted for verification |     405 |
| Judged in this pass                    | **404** |
| **Confirmed**                          | **304** |
| Refuted on inspection                  |     100 |
| Still unjudged                         |       1 |

Confirmed by verified severity: **1 critical · 28 high · 141 medium · 134 low**. The refutation rate of 25% is the verification doing its job — roughly one claim in four did not survive contact with the source.

### 5.1 · Confirmed critical and high

Each carries a plain-English line written for a non-technical reader.

**`services/svc-bank/src/loans/loan-service.ts:463`** — _critical_ (reported critical, confidence high)  
A retried loans.open re-validates LTV against the NEW request's principal but draws the OLD persisted principal — a borrower can draw unbounded principal against dust col

> **In plain terms:** If someone tries to open a loan pledging more collateral than they own, the failed attempt leaves the big loan amount saved; retrying with a tiny amount of collateral pays out the original big amount, letting a borrower drain the lending pot.

**`docker-compose.yml:62`** — _high_ (reported critical, confidence high)  
NATS is published on every interface with no authentication, and a forged `orderFilled` on it settles a real fill through the ledger

> **In plain terms:** The internal message bus that services use to tell each other a trade filled has no password and is open to the whole network, so anyone on the same network as a machine running the platform can send a fake fill message that the system books as real money movement.

**`packages/events/src/bus.ts:260`** — _high_ (reported critical, confidence high)  
idempotent() marks the dedupe key BEFORE running the handler, so a handler that throws once is never retried and its redelivery is acked — the event is permanently lost

> **In plain terms:** If a service hiccups while handling an event, that event is marked done before it was actually handled — so the retry is silently thrown away instead of being retried or flagged for a human.

**`packages/events/src/jetstream-bus.ts:99`** — _high_ (reported critical, confidence high)  
Consumers nak with zero backoff against max_deliver 5, and the dead-letter subject the API promises does not exist anywhere in the repo — a few seconds of downstream fail

> **In plain terms:** When a downstream step fails for even a second, the system retries five times instantly, gives up, and throws the event away with no alert and no holding area — despite the code promising one.

**`services/svc-academy/src/stake-source.ts:58`** — _high_ (reported critical, confidence high)  
Staked-lobby gate is inflated by 10^18: svc-token serialises the stake as a raw scaled bigint, svc-academy re-scales it, so any non-zero staker clears every threshold

> **In plain terms:** The paid-lobby entry check reads the staked amount a million-million-times too large, so anyone holding even a trace of the token gets into every stake-gated room for free.

**`services/svc-bank/src/earn/earn-service.ts:461`** — _high_ (reported high, confidence high)  
Earn accrual pays a full day's interest to positions opened the same day, so a deposit made minutes before the daily cron earns a whole day and can be withdrawn immediate

> **In plain terms:** Someone can park a large deposit in a savings pool for one minute right before the nightly interest run, collect a whole day's interest, and pull the money straight back out — repeatable every night, draining the pot that pays your honest savers.

**`services/svc-edge/src/control-plane.ts:43`** — _high_ (reported critical, confidence high)  
The operator kill-switch is bypassable with a `../` in the path: the guard and the proxy parse the URL differently

> **In plain terms:** If you switch a market off during an incident, someone can still get new orders through by writing the web address in a slightly different but equivalent form — the off-switch checks the address before it is tidied up, and the forwarder checks it after, so they disagree; the console will keep telling you the market is halted while orders are being accepted.

**`services/svc-identity/src/router.ts:203`** — _high_ (reported high, confidence high)  
A stolen access token can enrol its own TOTP factor and then step up to trade:withdraw, defeating the one control that exists to stop exactly that

> **In plain terms:** If someone steals a logged-in user's session, they can set up their own two-factor code on that account and use it to authorise a withdrawal, so the two-factor withdrawal check protects nobody who had not already turned two-factor on.

**`services/svc-matching/src/engine/engine.ts:271`** — _high_ (reported critical, confidence high)  
A match is applied to the book before its events publish; if a publish fails the SubmitResult is thrown away and nothing ever republishes the fill

> **In plain terms:** If the message broker hiccups at the wrong moment, a trade the engine has already matched can be silently voided — nobody loses money, but the trade never settles and the two systems disagree until someone reconciles by hand.

**`services/svc-matching/src/engine/engine.ts:270`** — _high_ (reported high, confidence high)  
A match is applied to the book before its events are published, with no outbox, no retry and no re-emit on recovery — a NATS failure or a crash after the match loses the

> **In plain terms:** A trade is committed inside the engine before anyone else is told about it, and if that message fails there is no automatic retry — the trade is lost and only a manual reconciliation will find it.

**`services/svc-p2p/src/p2p-service.ts:1943`** — _high_ (reported critical, confidence high)  
Reputation upsert is a read-modify-write with no lock when the row is absent, so two concurrent first-ever trades lose a counter and then permanently block the trade's te

> **In plain terms:** If the very first two P2P trades of the same person start at the exact same moment, a hidden counter goes one short, and later one of that person's trades can get permanently stuck with the crypto locked in escrow until someone fixes it by hand.

**`services/svc-pay/src/ledger-client.ts:36`** — _high_ (reported high, confidence high)  
svc-pay is the only ledger client still signing v1 (no body binding), so its captured signature is a replayable money instruction and svc-ledger can never be flipped to `

> **In plain terms:** The payments service is the last one still sending money instructions to the ledger without proof of what it asked for — anyone who can watch internal traffic could reuse a captured request within five minutes to make the ledger do something else entirely, and it is also the single thing blocking the security setting that would close this for good.

**`services/svc-pay/src/payment-service.ts:1938`** — _high_ (reported high, confidence high)  
payoutSettlement reverses the merchant's hold with no durable marker — a crash before the attempt counter advances leaves the retry settling out of a hold that was alread

> **In plain terms:** If the payout system is killed at one precise instant after a failed payout, a later retry can send the money out for real while the merchant still holds it in their balance.

**`services/svc-pay/src/payment-service.ts:1426`** — _high_ (reported high, confidence medium)  
refund posts to the ledger inside the database transaction — a commit failure orphans a merchant debit under a refundId that a later, different-sized refund silently reus

> **In plain terms:** If the database drops the connection at the wrong moment during a refund, a follow-up refund for a smaller amount can leave the merchant charged the larger original amount.

**`services/svc-pay/src/payment-service.ts:904`** — _high_ (reported high, confidence high)  
getMerchant runs on the shared pool from inside an open transaction — ten concurrent public checkout opens deadlock every database connection in svc-pay

> **In plain terms:** Ten shoppers opening a checkout page at the same instant can freeze the whole payments service until someone restarts it, and anyone with the public link can trigger it.

**`services/svc-pay/src/payment-service.ts:1694`** — _high_ (reported medium, confidence medium)  
A refund landing between the settlement freeze and the settlement post silently over-credits the merchant, because the frozen gross is never recomputed and the clearing a

> **In plain terms:** A refund that arrives while a settlement is half-finished causes the merchant to be paid for money that was already given back to the customer.

**`services/svc-pay/src/payment-service.ts:1700`** — _high_ (reported high, confidence medium)  
A refund landing between the settlement freeze and the settlement post makes the merchant settle a gross that no longer exists

> **In plain terms:** A refund landing in the gap between preparing and posting a settlement makes the merchant settle an amount that no longer exists.

**`services/svc-pay/src/rails/broadcast-store.ts:138`** — _high_ (reported critical, confidence high)  
A crash between eth_sendRawTransaction and the broadcast journal leaves a permanent **pending** row; the withdrawal retry path then rotates the idempotency key and broadc

> **In plain terms:** If the payments service crashes at the wrong instant while sending a customer withdrawal, the money can go out twice while the customer is refunded once, so the company silently loses the full withdrawal amount.

**`services/svc-token/src/index.ts:84`** — _high_ (reported critical, confidence high)  
The S2S stake endpoint returns the raw scaled bigint instead of a decimal string, so svc-academy re-scales it by 10^18 and every staked-lobby gate opens for a dust stake

> **In plain terms:** The staking service reports a user's stake in the wrong units to the Academy service, so anyone holding a fraction of a coin passes the 'staked lobby' entry check as if they held a thousand — the paywall for staked rooms is effectively open.

**`services/svc-trade/src/events.ts:38`** — _high_ (reported critical, confidence high)  
The matching-event recovery path is at-most-once: a failed fill settlement or hold release is marked seen before it runs and is never retried

> **In plain terms:** The backup path that is supposed to re-settle a trade when the main path dies gives up after a single failed attempt, so a trade can end up recorded but never actually paid, with the customer's funds left locked.

**`services/svc-trade/src/events.ts:42`** — _high_ (reported critical, confidence high)  
The matching-event recovery consumers mark an event as processed BEFORE running the handler, so any fill or cancel whose settlement throws is acked and never retried

> **In plain terms:** Duplicate of the previous item: one trade can be marked as done in the trading records while the money never moves, because the retry is silently skipped.

**`services/svc-trade/src/spot/trade-service.ts:585`** — _high_ (reported high, confidence medium)  
placeOrder submits to the matching engine without checking that the pending->open update applied, so a concurrent cancel can leave an unfunded order live in the book

> **In plain terms:** If a customer cancels at the same instant their order is being funded, the order can end up live on the exchange with the money already given back, and any trade against it cannot be paid out.

**`services/svc-trade/src/spot/trade-service.ts:1295`** — _high_ (reported high, confidence medium)  
A cancel racing an in-flight fill releases the whole hold, because finalize reads trade.fills under a lock that settleFill never takes

> **In plain terms:** A customer who cancels at the same moment their order is being filled can get their whole reservation back while the trade has already happened, leaving the other side's money stuck and the trade unpaid.

**`services/svc-trade/src/spot/trade-service.ts:1302`** — _high_ (reported critical, confidence medium)  
cancelOrder releases a hold that a printed-but-not-yet-recorded fill is about to spend, permanently unsettling the trade

> **In plain terms:** Same issue as the cancel-versus-fill race above: no money is invented, but a trade can print on the exchange and never get paid, with the other side's funds left locked.

**`services/svc-ws/src/private/gateway.ts:117`** — _high_ (reported critical, confidence high)  
Private WS gateway leaves the socket with no 'error' listener when the hub is at capacity — one malformed frame kills the whole svc-ws process

> **In plain terms:** A logged-in user who first opens enough connections to fill the live-updates service can then crash the whole service with a single bad message, taking price and trade streams down with it until it restarts.

**`tooling/scripts/swarm.mjs:367`** — _high_ (reported high, confidence high)  
An unrecognised claim-lock status silently means "no lock" — TRK-agents.scanner is on the free board RIGHT NOW while a live worktree is building it

> **In plain terms:** The swarm's job-claim files only count if they use one of a few exact words; two claims written with the word 'open' are being ignored, so that work is showing as unclaimed and can be handed to a second agent.

**`vendor/upstream-exchange/05_Web_Front/src/App.vue:564`** — _high_ (reported critical, confidence high)  
The sign-out button on the sole deployed product surface does not sign the user out

> **In plain terms:** On the live trading site, clicking Log Out does not log you out — the account stays signed in on that machine until the browser tab is closed; the team already has this written down as an outstanding fix.

**`vendor/upstream-exchange/05_Web_Front/src/App.vue:565`** — _high_ (reported critical, confidence high)  
"Log out" does not log you out — it calls a retired backend and never clears the session

> **In plain terms:** The Log Out button on the live site is wired to a shut-down old system, so the user stays signed in with the site still showing their name — a risk on any shared or borrowed computer.

**`vendor/upstream-exchange/05_Web_Front/src/pages/exchange/Exchange.vue:1871`** — _high_ (reported high, confidence high)  
The desk's percent-size buttons build order quantities from a decimal-place COUNT, so every percent-sized order on the six FX pairs and NATGAS is rejected by the engine

> **In plain terms:** On the six currency pairs and natural gas, the 25/50/75/100% quick-size buttons on the trading screen produce an order size the exchange will always refuse, so those buttons are effectively broken.

### 5.2 · Confirmed medium

| Where                                                                                                                          | Finding                                                                                                                                                                    | Reported as |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `.github/workflows/ci.yml:59`                                                                                                  | The production build of the only deployed vendored app is executed by nothing automated — CI green proves nothing about it                                                 | high        |
| `.github/workflows/docs-format.yml:48`                                                                                         | The four swarm-generated ops markdown files deterministically fail `format:check`, and docs-format.yml explicitly excludes all four from the only workflow that checks the | high        |
| `.github/workflows/order-path-cx8.yml:9`                                                                                       | order-path-cx8.yml's trigger paths omit three packages the same job explicitly builds and that all four money services depend on                                           | high        |
| `AGENTS.md:108`                                                                                                                | Every canonical doc tells agents to run bare `pnpm`, which is not resolvable on this machine or in any fresh worktree                                                      | high        |
| `apps/admin/src/lib/flag-state.ts:283`                                                                                         | The board's list of edge-enforced modules has drifted from svc-edge's route table — killing 'support' is enforced but shown as 'Not edge-enforced'                         | medium      |
| `docs/ops/SWARM-MANDATE.md:50`                                                                                                 | docs/ops/SWARM-MANDATE.md still states the hide-rule that PR #966 deliberately reversed — it is wrong about 10 of the 11 implementable rows on the board today             | medium      |
| `packages/config/src/env.ts:25`                                                                                                | APP_ENV defaults to 'dev' and is the sole pivot for every production safety guard; NODE_ENV is validated and read by nothing                                               | high        |
| `packages/config/src/env.ts:15`                                                                                                | Boolean env parsing accepts any string and silently resolves unrecognised values to false — DATABASE_SSL therefore disables TLS to the money database on a typo, with no e | medium      |
| `packages/config/src/jurisdiction.ts:547`                                                                                      | checkAccess's permissionless short-circuit skips the per-region module rule entirely — a region-specific 'blocked' or 'restricted' on any non-custodial protocol module is | high        |
| `packages/contracts/src/edge.ts:204`                                                                                           | createEdgeContext can never enforce S2S body binding, so every tRPC serviceProcedure in the fleet stays replayable regardless of INTERNAL_SERVICE_BODY_BIND                | critical    |
| `packages/contracts/src/edge.ts:204`                                                                                           | Body binding (L2-6) is structurally unreachable from createEdgeContext and 11 of 13 verifier call sites — INTERNAL_SERVICE_BODY_BIND=require is a no-op almost everywhere  | high        |
| `packages/contracts/src/identity.ts:44`                                                                                        | The published identity contract takes a userId that svc-identity ignores, and the IdentityContract interface it claims enforces this is implemented by nothing             | medium      |
| `packages/contracts/src/instruments.ts:343`                                                                                    | `instrumentSchema` — the declared authority for every listing — validates nothing but its own hardcoded array; no service ever parses a real market through it             | high        |
| `packages/db/src/connection.ts:39`                                                                                             | Eleven services build their Postgres pool by hand and silently drop the 15s statement_timeout that packages/db exists to guarantee                                         | high        |
| `packages/events/src/jetstream-bus.ts:84`                                                                                      | The consumer pump is a floating promise: an error from the JetStream iterator escapes the in-loop try/catch, and a clean iterator end kills the subscription with no signa | high        |
| `packages/events/src/jetstream-bus.ts:81`                                                                                      | consume() prefetches 100 messages while the pump processes them one at a time under a 30s ack_wait, so a slow handler causes JetStream to redeliver messages that are stil | high        |
| `packages/exchange-contract/src/schemas.ts:154`                                                                                | TIMEFRAME_MS makes a month 30 days and a week epoch-anchored, and candles.ts floors buckets with it — so 1M candles are not calendar months and 1w candles open on Thursda | high        |
| `packages/ledger-client/src/recipes/bank.ts:94`                                                                                | Transfer idempotency keys are built from an unvalidated, globally-shared client string — a colliding transferId makes a real transfer silently not happen while the API re | high        |
| `packages/ledger-client/src/recipes/index.ts:609`                                                                              | The platform fee is taken out of the buyer's proceeds while the buyer's fiat obligation is computed on the gross amount, and no API field discloses it                     | medium      |
| `packages/safe-regex/src/index.ts:49`                                                                                          | safe-regex flagsToInt maps every flag to the WRONG re2js constant; the flags argument has zero tests                                                                       | high        |
| `packages/telemetry/src/start.ts:129`                                                                                          | registerProcessHooks does not deliver the shutdown flush it documents — every service's own SIGTERM handler calls process.exit(0) while the flush is still in flight       | medium      |
| `packages/telemetry/src/start.ts:126`                                                                                          | registerProcessHooks has zero tests, and its ordering silently drops every span produced during the graceful-drain window                                                  | medium      |
| `services/svc-agents/src/metering/meter.ts:353`                                                                                | A usage window whose ledger charge fails is sealed and then permanently invisible to every enumerator — the revenue is silently lost and the next session close reports su | high        |
| `services/svc-agents/src/runtime.ts:451`                                                                                       | Caller-chosen requestId gives unlimited unbilled inference: the provider is called before the idempotency check, so a replayed id returns a fresh completion at zero cost  | high        |
| `services/svc-agents/src/runtime.ts:585`                                                                                       | Metered usage is only ever billed when the person being billed closes their own session — no settlement sweep exists anywhere in the repo                                  | high        |
| `services/svc-agents/src/runtime.ts:218`                                                                                       | Disabling an agent does not stop it: the `enabled` flag is checked only at session open, sessions never expire, and no operator route can terminate someone else's session | medium      |
| `services/svc-agents/src/runtime.ts:410`                                                                                       | The billing kill switch silently disables the per-session spend guardrail, contrary to its own documented contract                                                         | medium      |
| `services/svc-agents/src/runtime.ts:424`                                                                                       | A caller-chosen requestId is never bound to the request body, so any user can get unlimited unbilled inference and never trip the per-session spend cap                    | critical    |
| `services/svc-agents/src/runtime.ts:727`                                                                                       | The pre-flight spend estimate assumes 3 characters per token, which under-counts non-Latin text by roughly 3x and lets a call cross the per-session spend ceiling it was c | medium      |
| `services/svc-bank/src/cards/card-service.ts:667`                                                                              | A card capture whose remainder-reversal post fails strands the user's unspent hold permanently — every subsequent capture and reverse is refused                           | high        |
| `services/svc-bank/src/loans/loan-service.ts:184`                                                                              | Liquidation proceeds are computed in the QUOTE asset but settled as DEBT-asset amounts, and nothing constrains quoteAssetId to equal debtAssetId                           | medium      |
| `services/svc-bank/src/loans/loan-service.ts:502`                                                                              | loans.open never checks that a caller-supplied loanId belongs to the caller, so a known loan id returns another user's loan record and can drive their pending loan        | low         |
| `services/svc-bank/src/loans/risk.ts:529`                                                                                      | The liquidation penalty is capped against the loan's TOTAL debt, so on every partial-liquidation rung it computes to exactly zero                                          | medium      |
| `services/svc-bank/src/transfers/transfer-service.ts:380`                                                                      | Scheduled transfers bypass the space lock and archive guards, so a self-imposed lock does not stop a standing order draining the space                                     | medium      |
| `services/svc-dex/src/router-quote.ts:102`                                                                                     | Settlement cost (gas) is amortised over the venue's whole fillable size, not the size the leg actually takes — the router picks a strictly worse venue for the remainder a | high        |
| `services/svc-identity/src/auth/auth-service.ts:236`                                                                           | The account freeze killswitch is unreachable — no code in the repo can ever set users.status, so a compromised or fraudulent account cannot be suspended                   | high        |
| `services/svc-identity/src/auth/auth-service.ts:989`                                                                           | No failed-attempt counter, lockout or per-account throttle anywhere in svc-identity — the 6-digit code that gates trade:withdraw can be guessed at whatever rate a caller  | medium      |
| `services/svc-identity/src/auth/webauthn.ts:435`                                                                               | WebAuthn assertion verification expects raw IEEE-P1363 signatures, but real authenticators send ASN.1 DER — every passkey login will fail, and the test suite is green bec | high        |
| `services/svc-identity/src/rank/rank-service.ts:146`                                                                           | rankUpdated is published to the bus INSIDE the database transaction, so a rollback leaves a rank-up notification for a rank change that never committed                    | high        |
| `services/svc-indexer/src/indexer.ts:249`                                                                                      | The reorg fork-search floor is computed from the CURRENT head, not from the highest height prune() has already collapsed — so after any reorg that shortens the chain the  | high        |
| `services/svc-indexer/src/indexer.ts:202`                                                                                      | A reorg repair that unwinds nothing leaves the sync loop in an identical state and it retries immediately — up to `batchSize` no-progress iterations per pass, reported as | medium      |
| `services/svc-indexer/src/indexer.ts:249`                                                                                      | The reorg-too-deep halt is measured from the CURRENT head, not from the height history was actually pruned to — so a reorg can silently delete the last surviving version  | high        |
| `services/svc-indexer/src/indexer.ts:202`                                                                                      | A parent-hash mismatch at head+1 sends the loop into a repair that unwinds nothing — the cursor freezes for a full batch with lastError cleared to null and /ready still g | high        |
| `services/svc-indexer/src/projection/postgres-store.ts:226`                                                                    | `book()` composes its head stamp and its two sides from three separate unsynchronised queries, so a response can carry a crossed book or an `asOfHash` naming a block whos | medium      |
| `services/svc-ledger/src/index.ts:34`                                                                                          | The globally serialising money path runs on a connection pool with no statement timeout and no lock timeout, so one stalled post blocks every post platform-wide and exhau | medium      |
| `services/svc-ledger/src/index.ts:97`                                                                                          | The hourly reconciliation — the platform's only drift detector — swallows every failure and nothing observable changes                                                     | high        |
| `services/svc-ledger/src/index.ts:89`                                                                                          | The reconciliation timer has no in-flight guard, so a run that overruns its interval stacks copies of itself on the ledger's connection pool                               | medium      |
| `services/svc-ledger/src/ledger/postgres-ledger.ts:55`                                                                         | post() returns a prior transaction for a reused idempotency key without checking the request matches it, so a retry with different entries silently no-ops and reports suc | high        |
| `services/svc-ledger/src/ledger/reconcile.ts:67`                                                                               | Reconciliation replays the whole chain from genesis with one query per transaction, has no in-flight guard, and never writes the snapshot anchor designed to stop it       | medium      |
| `services/svc-ledger/src/ledger/reconcile.ts:82`                                                                               | Hourly ledger reconciliation replays the entire hash chain with one query per transaction, from genesis, forever                                                           | high        |
| `services/svc-ledger/src/ledger/reconcile.ts:131`                                                                              | balance_snapshots grows by one row per account per hour, forever, and is never read by any code                                                                            | high        |
| `services/svc-ledger/src/service.ts:49`                                                                                        | A committed ledger transaction is reported to the caller as a failure when the post-commit NATS publish throws, and the error is a generic 500 the caller cannot distingui | medium      |
| `services/svc-ledger/src/service.ts:207`                                                                                       | Automatic reconciliation freeze overwrites an operator's freeze reason and actor, erasing the only record of why the platform was halted                                   | medium      |
| `services/svc-ledger/src/service.ts:49`                                                                                        | A committed ledger post is reported to the caller as a failure when the event bus is down                                                                                  | high        |
| `services/svc-matching/src/engine/engine.ts:284`                                                                               | cancel() creates and permanently stores an order book for any market id, including ones that do not exist                                                                  | medium      |
| `services/svc-matching/src/engine/engine.ts:327`                                                                               | Order-cancel and order-fill events are published on two subjects consumed by two independent durables, so a hold can be released before the fill that spends it is recorde | medium      |
| `services/svc-matching/src/engine/engine.ts:284`                                                                               | Cancelling into an unknown market creates and permanently persists a phantom order book — the read-must-not-create bug that was fixed for /depth is still live on the canc | medium      |
| `services/svc-matching/src/engine/engine.ts:284`                                                                               | The "reading must not create" guard is tested on the depth route only — engine.cancel() still allocates a phantom market book                                              | high        |
| `services/svc-matching/src/engine/journal.ts:186`                                                                              | A single torn final record makes the journal unreadable and the engine unable to boot at all                                                                               | medium      |
| `services/svc-matching/src/engine/journal.ts:163`                                                                              | An unchecked short write plus an unguarded JSON.parse mean a full disk or a crash mid-append leaves a journal the engine can never boot from again                         | medium      |
| `services/svc-matching/src/index.ts:54`                                                                                        | Recovery always replays the entire journal from record 1 — snapshots are computed on the hot path and thrown away, so restart cost grows without bound                     | medium      |
| `services/svc-notify/src/dispatch.ts:98`                                                                                       | A critical notification records NOTHING on out-of-app channels when the operator kill-switch is off and the user registered no address                                     | high        |
| `services/svc-notify/src/events.ts:142`                                                                                        | A durable consumer that fails to attach for any transient reason is never retried, and /ready still answers ready: true                                                    | medium      |
| `services/svc-notify/src/notify-service.ts:230`                                                                                | Address confirmation codes have no attempt limit or lockout — a 6-digit code is brute-forceable within its 15-minute window                                                | medium      |
| `services/svc-p2p/src/p2p-service.ts:1637`                                                                                     | The timeout sweep acts on the trade status it read minutes earlier, so a buyer who marks fiat sent inside the sweep window gets the escrow refunded to the seller instead  | high        |
| `services/svc-p2p/src/p2p-service.ts:1521`                                                                                     | settle() stamps settled_at BEFORE publishing, so a bus failure permanently drops the escrow-release event and the XP awards with no retry path                             | medium      |
| `services/svc-p2p/src/state.ts:84`                                                                                             | A taker can freeze a seller's escrow indefinitely, for free, by disputing straight out of `escrowed` before any payment claim exists                                       | high        |
| `services/svc-pay/src/payment-service.ts:1717`                                                                                 | A refund between settlement freeze and settlement post makes the window permanently unsettleable, with its payments already marked included in an append-only table        | high        |
| `services/svc-pay/src/payment-service.ts:1929`                                                                                 | A merchant settlement payout wedges permanently on a stale **pending** broadcast row — the same key is reused on every retry and can never claim again                     | high        |
| `services/svc-pay/src/payment-service.ts:1898`                                                                                 | payoutSettlement reads and acts on the settlement row with no lock, so a concurrent retry can settle out of a hold another call already reversed                           | medium      |
| `services/svc-pay/src/rails/broadcast-store.ts:138`                                                                            | A crash mid-broadcast leaves a permanent **pending** row in the broadcast journal, poisoning that business key forever                                                     | medium      |
| `services/svc-pay/src/rails/crypto-native.ts:416`                                                                              | Chain error messages containing the full RPC URL (including the provider API key) are returned in tRPC error messages and persisted into payment_events that merchants can | medium      |
| `services/svc-pay/src/rails/evm-chain.ts:200`                                                                                  | EvmLiveChain reports a REVERTED on-chain transfer as a successful send — the ledger settles a payout that never left the hot wallet                                        | high        |
| `services/svc-pay/src/rails/evm-chain.ts:296`                                                                                  | Only one inbound transfer per acceptance address is ever retained — a payer who tops up or splits a payment loses the second transfer entirely                             | high        |
| `services/svc-pay/src/rails/evm-chain.ts:305`                                                                                  | ERC-20 deposits are scanned through a fixed 64-block sliding window with no cursor, so a single failed or slow watcher tick loses the deposit permanently                  | high        |
| `services/svc-pay/src/rails/evm-chain.ts:376`                                                                                  | The RPC provider API key is returned to unauthenticated callers on GET /api/pay/ready because redactRpc redacts every path segment except the last — which is where the ke | high        |
| `services/svc-pay/src/rails/evm-chain.ts:168`                                                                                  | A merchant-supplied bad payout destination permanently poisons the broadcast claim row, making that settlement unpayable forever                                           | high        |
| `services/svc-pay/src/rails/evm-chain.ts:200`                                                                                  | A receipt-wait timeout is reported as 'broadcast failed' and the caller reverses the ledger while the money is already on-chain                                            | high        |
| `services/svc-pay/src/rails/evm-chain.ts:296`                                                                                  | Only one inbound transfer per acceptance address is ever kept, and delivery is marked per address — a payer's second transfer to the same address is silently discarded    | high        |
| `services/svc-pay/src/rails/evm-chain.ts:304`                                                                                  | ERC-20 deposits are scanned only in a rolling ~64-block window from the tip, so any watcher downtime longer than that window loses them permanently while native transfers | medium      |
| `services/svc-pay/src/rails/evm-chain.ts:168`                                                                                  | A failed outbound crypto broadcast leaves its idempotency claim permanently 'pending', so that key can never broadcast again                                               | critical    |
| `services/svc-pay/src/rails/evm-chain.ts:296`                                                                                  | Only the first inbound transfer to a crypto acceptance address is ever observed; a second transfer to the same address is discarded and never booked                       | medium      |
| `services/svc-pay/src/router.ts:280`                                                                                           | Merchant self-sets the platform's own fee rate: merchant.create takes pricing.feeBps from the caller, and feeBps:0 makes every settlement free forever                     | high        |
| `services/svc-pay/src/user-money-service.ts:416`                                                                               | A withdrawal retry after a false-negative rail failure broadcasts a SECOND on-chain transfer, because the outbound broadcast key changes per attempt                       | critical    |
| `services/svc-pay/src/user-money-service.ts:388`                                                                               | Any failure of the withdrawal hold post is recorded as 'ledger.insufficient_funds', hiding a real hold behind a status the recovery index does not list                    | high        |
| `services/svc-protocol/contracts/amm/ConstantProductPool.sol:74`                                                               | AMM add-liquidity keeps the whole unbalanced deposit and mints LP only on the smaller side — no min-amounts, no refund, no deadline, so every add is sandwichable          | high        |
| `services/svc-token/src/router.ts:188`                                                                                         | The tRPC stakeOf and accessOf procedures serialise the same unformatted bigint, reporting every user's stake 10^18 times too large                                         | high        |
| `services/svc-token/src/token-service.ts:1071`                                                                                 | The max-supply guard on the mint path can never fire, because cumulativeEmission is already clamped to maxSupply                                                           | high        |
| `services/svc-token/src/token-service.ts:233`                                                                                  | stake() deletes the pending claim on ANY ledger error, so an ambiguous failure after the post commits strands the user's principal in a stake account with no stake row    | high        |
| `services/svc-token/src/token-service.ts:852`                                                                                  | recordBuyback deletes the window claim on ANY burn error, so a lost response after a committed burn releases the window and a retry with a new run id burns a second time  | high        |
| `services/svc-token/src/token-service.ts:675`                                                                                  | distributeRevenue double-counts a repeated source module: the fee sweep dedupes on (window, module) but the payout total does not, so more is paid out than was swept in   | high        |
| `services/svc-token/src/token-service.ts:733`                                                                                  | Re-running distributeRevenue for a window - the documented crash-recovery path - overpays when the staker set changed in between                                           | high        |
| `services/svc-trade/drizzle/0001_multi_asset_instruments.sql:85`                                                               | The database CHECK that is meant to guarantee a pip on every non-crypto market accepts NULL, because a SQL CHECK passes when it evaluates to NULL                          | medium      |
| `services/svc-trade/src/futures/funding-tick.ts:103`                                                                           | Funding payments drain a position's collateral pot but never adjust margin_initial, so every payer position becomes permanently impossible to close or liquidate           | critical    |
| `services/svc-trade/src/futures/liquidation-planner.ts:122`                                                                    | A failure between a liquidation's two ledger posts strands user margin or wedges the position, because the retry re-prices the release against a moved mark under a fixed  | high        |
| `services/svc-trade/src/futures/liquidation-tick.test.ts:58`                                                                   | No test in the liquidation tick ever makes a dependency throw, so a single poisoned position silently stops every later position from being liquidated — for good          | high        |
| `services/svc-trade/src/futures/liquidation-tick.ts:242`                                                                       | The liquidation tick posts money for positions it read minutes-of-latency ago without re-checking status under a lock, so it double-settles against a concurrent voluntary | high        |
| `services/svc-trade/src/futures/liquidation-tick.ts:146`                                                                       | One un-liquidatable position permanently blocks liquidation of every position opened after it                                                                              | high        |
| `services/svc-trade/src/futures/liquidation-tick.ts:147`                                                                       | The liquidation idempotency root is bucketed by wall-clock minute, so a partial failure inside the recipe loop makes the retry post under a new key against a pot that no  | medium      |
| `services/svc-trade/src/futures/liquidation-tick.ts:236`                                                                       | #950 serialised close-vs-close but left the liquidation tick unlocked — the same double-settlement window it fixed is still open across the two paths                      | high        |
| `services/svc-trade/src/futures/position-service.ts:342`                                                                       | Futures open() locks margin before the position row exists, under a random position id, so a crash between the two strands the user's margin with no record anywhere in th | high        |
| `services/svc-trade/src/mm/seed-jobs.ts:118`                                                                                   | MM seed run counter resets on process restart, so the second lifetime reuses ledger hold idempotency keys and rests house orders with zero backing hold                    | critical    |
| `services/svc-trade/src/mm/seed-jobs.ts:118`                                                                                   | MM seed run ids restart from 1 after a process restart, so a reseed submits house quotes whose hold post is a silent idempotency no-op                                     | high        |
| `services/svc-trade/src/mm/seed-jobs.ts:118`                                                                                   | MM seed run-id counter resets on restart while the last-run map is persisted, so a reseed reuses order ids whose hold key the ledger has already spent — the new quotes re | high        |
| `services/svc-trade/src/mm/seed-market.ts:334`                                                                                 | cancelSeedMarket reads a transient ledger error as "this order has no hold" and reports success, after which the run is dropped from durable state and the hold is strande | medium      |
| `services/svc-trade/src/private-rest.ts:263`                                                                                   | Order.cost is reported as limit price x filled quantity, never as the sum of fills, on every REST path — and `average` is always null, so a client cannot recover the real | medium      |
| `services/svc-trade/src/public-rest.ts:351`                                                                                    | Public /api/v1/tickers fans out two calls per market on every request, unbounded by market count and uncached                                                              | medium      |
| `services/svc-trade/src/spot/candles.ts:45`                                                                                    | Public unauthenticated /api/v1/ohlcv aggregates the entire trade.fills history for a market on every request — the LIMIT is applied after GROUP BY, so it bounds nothing   | high        |
| `services/svc-trade/src/spot/candles.ts:45`                                                                                    | Public OHLCV endpoint re-aggregates the entire fill history of a market on every request; the LIMIT bounds output, not work                                                | critical    |
| `services/svc-trade/src/spot/trade-service.ts:684`                                                                             | Cancelling an order still in `pending` tries to release a hold that was never posted, which the ledger refuses — the order can never be cancelled and cancel-all aborts    | high        |
| `services/svc-trade/src/spot/trade-service.ts:1025`                                                                            | House market-maker stub orders record only the first fill's notional as hold_amount, so any later finalize on a twice-filled seed order throws hold_uncovered forever      | medium      |
| `services/svc-trade/src/spot/trade-service.ts:348`                                                                             | A user's worst-acceptable price on a convert or market SELL is checked only against a pre-trade snapshot and is never bound to execution                                   | medium      |
| `services/svc-trade/src/spot/trade-service.ts:538`                                                                             | convertExecute requires a caller-chosen idempotency id, but the order lookup returns the stored order without checking it matches the request — a reused id reports succes | medium      |
| `services/svc-trade/src/spot/trade-service.ts:579`                                                                             | An indeterminate ledger.post failure deletes the order row, orphaning a hold that may actually have been committed                                                         | high        |
| `services/svc-trade/src/spot/trade-service.ts:414`                                                                             | placeOrder awaits a non-money bus publish after the order is already funded and live, so a NATS outage returns 500 for orders that were successfully placed                | medium      |
| `services/svc-trade/src/spot/trade-service.ts:1305`                                                                            | finalize() holds a row lock and a pooled DB connection across an untimed HTTP call to svc-ledger, so a slow ledger exhausts the 10-connection pool and stops the whole ser | high        |
| `services/svc-ws/src/env.ts:142`                                                                                               | The private JetStream durables are a single shared name with no per-replica guidance, so a second svc-ws replica silently drops a share of every user's order, fill and po | medium      |
| `services/svc-ws/src/index.ts:208`                                                                                             | svc-ws never retries the NATS connection and never reports it, so a boot-time bus failure permanently silences the trade tape and every private stream while /ready still  | high        |
| `services/svc-ws/src/private/gateway.ts:123`                                                                                   | The private stream pings but never checks for a pong, so a client that ignores pings holds its subscription forever — the README claims the opposite                       | medium      |
| `services/svc-ws/src/private/gateway.ts:123`                                                                                   | Private WS gateway pings but never checks for a pong, so a socket that stops answering holds a hub slot forever — contradicting the documented invariant                   | high        |
| `tooling/ci/checkout-staleness.mjs:25`                                                                                         | The staleness guard that exists to stop stale boards never fetches, and swarm.mjs never fetches at all                                                                     | medium      |
| `tooling/ci/dependency-audit.mjs:124`                                                                                          | The dependency-advisory ratchet gate matches by GHSA ID only — a severity escalation on an already-frozen advisory produces silent green                                   | high        |
| `tooling/ci/dependency-audit.mjs:134`                                                                                          | The frozen baseline replays its own stored note as if it were this run's result — a known advisory that escalates to critical or moves onto a request path exits 0 and pri | critical    |
| `tooling/ci/dependency-audit.mjs:100`                                                                                          | The 'Supply chain / Dependency audit' check does not audit the shipped trading front-end at all — 4,064 npm packages from a 2017 tree, served on port 8090, covered by not | high        |
| `tooling/ci/money-property.mutation.mjs:108`                                                                                   | The money-property-mutation gate prints a perfect 6/6 green when the property suite never runs a single assertion                                                          | high        |
| `tooling/ci/vendor-java-money-scan.mjs:152`                                                                                    | The DAO no-op integrity check positively asserts only 4 of the 13 disabled member_wallet mutator queries — re-arming any of the other 9 as a plain assignment passes green | medium      |
| `tooling/ci/verify.mjs:84`                                                                                                     | `pnpm verify` cannot reach typecheck or tests in the main checkout: gates walk 21 gitignored worktrees, and verify stops at the first failing step                         | critical    |
| `tooling/ci/wallet-rpc-mainnet-scan.mutation.mjs:222`                                                                          | The mutation gate's oracle is the exit code alone — a mutant that is a pure SyntaxError scores as killed, and one of its ten shipping mutants is in fact detected that way | medium      |
| `tooling/scripts/swarm.mjs:674`                                                                                                | Implementable TRK rows get no open-PR path-collision check at all, and the "allowed paths" handed to the worker are documentation files                                    | high        |
| `tooling/scripts/swarm.mjs:671`                                                                                                | A failed tracker load silently reports freeImplementable=0 — a false all-clear with `// non-fatal` written next to it                                                      | high        |
| `tooling/scripts/swarm.mjs:919`                                                                                                | Claim locks are per-worktree working-tree files, but the generated FREEZE-LIVE.md tells agents they are atomic first-writer-wins                                           | medium      |
| `tooling/scripts/worktree-gc.mjs:117`                                                                                          | worktree-gc --apply will run `git branch -D main` and delete the local main branch                                                                                         | high        |
| `tooling/uiproof/report.mjs:75`                                                                                                | uiproof PROOF.md reports PASS with zero test evidence when the Playwright JSON report is absent                                                                            | high        |
| `vendor/upstream-exchange/00_framework/core/src/main/java/com/bizzan/bitrade/event/MemberEvent.java:90`                        | A live credit to member_wallet.to_released sits in core:MemberEvent and every dual-book gate is blind to it, because the column is not called "balance"                    | high        |
| `vendor/upstream-exchange/00_framework/core/src/main/java/com/bizzan/bitrade/interceptor/DualBookMoneyDoorInterceptor.java:88` | The 410 dual-book door matches the RAW request URI, not the path Spring routes on — so an encoded or path-parameter spelling of a blocked money URI reaches the controller | high        |
| `vendor/upstream-exchange/00_framework/market/src/main/java/com/bizzan/bitrade/config/WebSocketConfig.java:24`                 | Deployed `market` service exposes an unauthenticated STOMP simple broker on Spring Framework 4.3.13 (CVE-2018-1270, SpEL RCE)                                              | critical    |
| `vendor/upstream-exchange/00_framework/market/src/main/java/com/bizzan/bitrade/handler/NettyHandler.java:75`                   | fastjson 1.2.31 parses attacker-controlled frames on two Netty commands the config explicitly whitelists for pre-auth access                                               | high        |
| `vendor/upstream-exchange/00_framework/ucenter-api/src/main/java/com/bizzan/bitrade/controller/RegisterController.java:178`    | Member and admin passwords are stored as single-round MD5, with a salt that is either derived from the public login identifier or committed in a tracked properties file   | medium      |
| `vendor/upstream-exchange/05_Web_Front/src/assets/js/ix-money.golden.js:8`                                                     | The Vue shell's entire test suite (11 golden suites) is executed by nothing — not CI, not `pnpm verify`                                                                    | high        |
| `vendor/upstream-exchange/05_Web_Front/src/components/exchange/DepthGraph.vue:310`                                             | Depth-chart tooltip prints fabricated zeros, rounded-up prices and float-accumulated totals                                                                                | medium      |
| `vendor/upstream-exchange/09_DOC/Nginx配置文件/default.conf:1`                                                                 | 09_DOC is 14 MB (39% of the vendored tree) of upstream Chinese product screenshots referenced by nothing that builds                                                       | low         |

### 5.3 · Confirmed low

| Where                                                                                                                        | Finding                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml:42`                                                                                                | Four of five workflows declare no `permissions:` block, so the GITHUB_TOKEN scope in every job that runs `pnpm install` with lifecycle scripts is whatever the repo defaul |
| `.github/workflows/gitleaks.yml:25`                                                                                          | gitleaks binary is downloaded from a mutable release URL and executed with no checksum, in the one workflow whose comment claims the binary is the lower-trust option      |
| `.npmrc:1`                                                                                                                   | No minimumReleaseAge / publish-age protection configured for the registry — the classic 'freshly-published malicious version' supply-chain vector has no first line of def |
| `AGENTS.md:237`                                                                                                              | AGENTS.md still says `pnpm gates` runs "the 14 doctrine gates" — the file it names now defines 27                                                                          |
| `apps/admin/README.md:60`                                                                                                    | The app README states the Ledger ops screen still uses the fake freeze stubs — it does not, and the buttons really halt the platform                                       |
| `apps/admin/src/components/ledger-ops.tsx:168`                                                                               | A timed-out freeze/unfreeze is reported to the operator as 'the platform did not change' — a claim the console cannot make                                                 |
| `apps/admin/src/lib/admin-bff-gate.ts:16`                                                                                    | The shared-secret comparison is not constant-time                                                                                                                          |
| `apps/admin/src/lib/admin-bff-gate.ts:11`                                                                                    | apps/admin's only authentication (adminBffGate) and both platform-changing route handlers have zero tests                                                                  |
| `docker-compose.yml:251`                                                                                                     | Registering the TracerProvider turned an accepted 'Medium' Grafana misconfiguration into live exfiltration of counterparty IDs and money amounts                           |
| `docs/GITHUB-SPEND-FORENSIC-2026-08-05.md:15`                                                                                | GITHUB-SPEND-FORENSIC-2026-08-05.md's entire premise — a private repo paying GitHub Actions minutes, with thrift as the cost-control law — is now void; the repo went publ |
| `docs/UPSTREAM-ADOPTION-QUEUE-2026-08-02.md:256`                                                                             | docs/UPSTREAM-ADOPTION-QUEUE-2026-08-02.md states as verified fact three things that are false at this tip, and gives remediation commands that cannot run                 |
| `package.json:15`                                                                                                            | `pnpm lint` executes zero tasks and exits 0 — no workspace package defines a lint script and the repo has no eslint config                                                 |
| `packages/auth/src/scopes.ts:151`                                                                                            | The database backstop constraint on API-key scopes covers only 3 of the 4 INTERACTIVE_ONLY_SCOPES — pay:payout is missing, and a prior audit already flagged it            |
| `packages/auth/src/tokens.ts:103`                                                                                            | HS256 means the verification key IS the signing key, so three services that only ever verify — including the browser-facing WebSocket gateway — hold the platform's token- |
| `packages/config/src/env.ts:118`                                                                                             | redactEnv leaves credentials in REDIS_URL and NATS_URL in the clear, while the file's header claims secrets are never logged                                               |
| `packages/config/src/fiat.ts:163`                                                                                            | formatFiat takes money as a JavaScript number, in the package's public API                                                                                                 |
| `packages/config/src/jurisdiction.ts:457`                                                                                    | The '*' wildcard region is documented and shipped but resolved by no lookup: a global block reports as active and refuses nothing                                          |
| `packages/contracts/src/edge.test.ts:143`                                                                                    | createEdgeContext's service-authentication branch has zero test coverage — the whole contracts suite stays green if it trusts every caller unconditionally                 |
| `packages/contracts/src/identity.ts:26`                                                                                      | Two RankPerks fields that the contract names consumers for — p2pLimitMultiplier and cardTier — are read by no service, and svc-identity's exit-criteria test asserts the o |
| `packages/contracts/src/instruments.ts:374`                                                                                  | `planes` is declared as the DEX/CEX sovereignty switch in both the contract and the database, and nothing reads it — the test that proves the switch asserts against a har |
| `packages/events/src/catalog.ts:876`                                                                                         | ledgerTxPosted is justified as having no consumer because 'a consumer built later replays from the start', but the publish happens after commit with no outbox, so the str |
| `packages/events/src/catalog.ts:908`                                                                                         | The ledgerFreezeUpdated socket reason justifies Class A with a claim about apps/admin that is now false                                                                    |
| `packages/events/src/catalog.ts:976`                                                                                         | Two socket classifications rest on evidence in apps/web, an app that has been deleted from the repo                                                                        |
| `packages/events/src/catalog.ts:669`                                                                                         | p2pTradeDisputed still promises a dispute backstop that was removed, and p2pDisputeResolved declares an `automatic` field the only publisher hardcodes to false            |
| `packages/events/src/events.test.ts:163`                                                                                     | JetStreamEventBus — the only bus that runs in production — has no test at all; its validation and its ack/nak can both be inverted with the suite still green              |
| `packages/ledger-client/src/client.ts:107`                                                                                   | DEFECT 3 (LOCK_KINDS is a hand-maintained string Set with nothing tying it to ACCOUNT_KINDS) — MISSED; outside the gate's scope, and no other gate covers it               |
| `packages/ledger-client/src/memory-ledger.ts:49`                                                                             | The two ledger engines validate and short-circuit in opposite orders, and the conformance suite does not ask                                                               |
| `packages/ledger-client/src/money.property.test.ts:39`                                                                       | DEFECT 1 (proRata pays dust to zero-weight participants on a negative total) — MISSED by the gate and by the property suite                                                |
| `packages/ledger-client/src/recipes/index.ts:206`                                                                            | DEFECT 2 (tradeFill / marketMakerMakerFill emit a zero-amount entry the ledger always refuses) — MISSED; outside the gate's scope by construction                          |
| `packages/safe-regex/src/index.ts:73`                                                                                        | safeTest performs a FULL-STRING match but is named and documented as a `test`, so any unanchored pattern silently returns false — fail-open if ever used for a denylist    |
| `packages/safe-regex/src/index.ts:74`                                                                                        | safeTest always returns groups: [] regardless of the pattern's capture groups, while the public type promises a populated string array                                     |
| `packages/safe-regex/src/index.ts:74`                                                                                        | safeTest never populates `groups`; the test asserts the empty stub as if it were correct                                                                                   |
| `packages/safe-regex/src/index.ts:95`                                                                                        | escapeLiteral is exported, untested, and does not escape '-'                                                                                                               |
| `packages/telemetry/package.json:16`                                                                                         | packages/telemetry is the one workspace package whose tests nothing type-checks — the ratchet's own coverage guard cannot see it                                           |
| `packages/telemetry/src/start.test.ts:84`                                                                                    | 'shutdown is idempotent and never throws' exercises the no-op stub, not the real shutdown                                                                                  |
| `packages/telemetry/src/start.ts:102`                                                                                        | startTelemetry reports enabled:true without checking whether provider.register() succeeded, and the diagnostic that would say otherwise is silenced by default             |
| `packages/venue-adapter/src/consolidated-book.ts:45`                                                                         | consolidateBook accepts non-positive prices and lets one venue's malformed level throw out the entire consolidated book                                                    |
| `packages/venue-adapter/src/fabric/book-feed.ts:198`                                                                         | MaintainedBook's fire-and-forget #seed() can reject unhandled — a delta with a zero price during the snapshot join takes the process down instead of stopping the feed     |
| `packages/venue-adapter/src/fabric/book-feed.ts:193`                                                                         | MaintainedBook reports the wrong incident when the snapshot fetch fails — an unreachable or rate-limited venue is logged as 'the REST endpoint is lagging its own websocke |
| `packages/venue-adapter/src/fabric/latency.ts:256`                                                                           | healthFromGrade never marks a venue unhealthy when the grade is provisional, silently cancelling the staleness exception its own docstring promises                        |
| `packages/venue-contracts/src/adapter.ts:194`                                                                                | assertTradeOnly matches withdrawal scopes by exact string equality against a 5-item list, so any other spelling of a withdraw permission is accepted                       |
| `packages/venue-contracts/src/market.ts:178`                                                                                 | roundToTick rounds a BUY price UP, above the caller's authorised price — its own docstring and test comment both assert the opposite of what the code does                 |
| `services/svc-academy/src/router.ts:297`                                                                                     | paperDrill's 'no live risk' guard reads the paper flag from the caller, not from svc-trade — the guarantee stated in the code comment is not implemented                   |
| `services/svc-academy/src/stake-source.ts:33`                                                                                | The fail-closed stake gate (createStakeSource) has no test at all — every one of its four refusal branches is unexercised                                                  |
| `services/svc-agents/src/fleet/guardrails.ts:318`                                                                            | Every ceiling in the guardrail is per-session and session creation is unlimited, so both the spend cap and the action cap are multiplied at will                           |
| `services/svc-agents/src/router.ts:241`                                                                                      | session.open lets any principal with agents:execute bind to any registered agent's guardrail — there is no per-user entitlement check on agentId                           |
| `services/svc-agents/src/runtime.ts:424`                                                                                     | The metering kill-switch also stops the rate being recorded, so the cost of the switched-off period is not reconstructable after a price change — contradicting the switch |
| `services/svc-dex/src/router-quote.ts:107`                                                                                   | No guard against a sell whose settlement cost exceeds its proceeds — the buy side has one, the sell side does not, so a negative-value trade is returned as a routable quo |
| `services/svc-dex/src/router.ts:165`                                                                                         | `dex.quote` accepts qty "0" and answers with a 500 — the zero check throws a bare RangeError that the router's refusal handler does not catch                              |
| `services/svc-dex/src/router.ts:199`                                                                                         | `routePreview` has no decimal validation on its money inputs — malformed strings 500 the service and a NEGATIVE settlementCost makes gas score as income                   |
| `services/svc-edge/src/cors.ts:153`                                                                                          | CORS refuses DELETE, so a cross-origin browser cannot reach the order-cancel paths the kill-switch guarantees stay open                                                    |
| `services/svc-identity/drizzle/0000_identity_init.sql:145`                                                                   | The database backstop on API-key scopes omits pay:payout, so the control the README calls a backstop no longer covers the interactive-only set                             |
| `services/svc-identity/src/router.ts:129`                                                                                    | sessions.ip is populated with the tRPC request id at registration and left NULL on every other session-issuing path, so the session audit column contains no IP addresses  |
| `services/svc-indexer/src/indexer.ts:186`                                                                                    | Ingest loop re-fetches its own head block, logs included, once per block instead of once per pass — doubling RPC calls during backfill                                     |
| `services/svc-indexer/src/projection/postgres-store.ts:191`                                                                  | prune() re-scans the entire retained projection every poll cycle instead of only the newly-finalised window                                                                |
| `services/svc-indexer/src/projection/postgres-store.ts:290`                                                                  | Account-scoped reads wrap the indexed column in lower(), so every fills/positions lookup degrades to a full scan of a table that is never pruned                           |
| `services/svc-indexer/src/projection/postgres-store.ts:317`                                                                  | markets() UNIONs three unbounded full table scans on every call                                                                                                            |
| `services/svc-indexer/src/projection/postgres-store.ts:111`                                                                  | applyBlock issues one awaited round trip per event inside the open transaction                                                                                             |
| `services/svc-indexer/src/projection/postgres-store.ts:290`                                                                  | svc-indexer's public account-tape endpoint sequentially scans the entire fills table because lower() disables the index built for it                                       |
| `services/svc-indexer/src/projection/postgres-store.ts:318`                                                                  | svc-indexer's public markets() endpoint full-scans three unbounded tables and de-duplicates them, with no LIMIT and no cache                                               |
| `services/svc-indexer/src/projection/postgres-store.ts:311`                                                                  | svc-indexer's public positions() endpoint cannot use positions_account_idx because it filters on lower(account)                                                            |
| `services/svc-ledger/src/ledger/reconcile.ts:130`                                                                            | balance_snapshots is written hourly by every replica, never read, never pruned, and its through_entry_id cutoff is never populated — so §4.2's reconciliation anchor does  |
| `services/svc-ledger/src/s2s-http.ts:106`                                                                                    | The served balance API drops `purpose`, the fifth component of account identity, so a listed hold cannot be read back                                                      |
| `services/svc-matching/src/engine/book.ts:329`                                                                               | duplicate_order_id only guards orders that are still live — resubmitting an order id that already filled matches and settles a second time                                 |
| `services/svc-matching/src/engine/book.ts:329`                                                                               | Every order submission linearly scans the entire stop-order array twice, so resting stops turn an O(log n) submit into O(number of stops)                                  |
| `services/svc-matching/src/engine/book.ts:393`                                                                               | The fill-or-kill viability check sums the entire opposing book with no early exit, so a market FOK order costs O(all resting orders) even when it would fill at the touch  |
| `services/svc-matching/src/engine/engine.ts:101`                                                                             | Snapshots are computed and thrown away — recovery always full-replays from record 1, so MATCHING_SNAPSHOT_EVERY is a knob that does nothing                                |
| `services/svc-matching/src/engine/engine.ts:328`                                                                             | Every order submission makes one sequential NATS round-trip per emitted event, so a taker that sweeps K makers costs K+1 serialised broker round-trips inside the request  |
| `services/svc-matching/src/engine/engine.ts:346`                                                                             | A full snapshot of every book is serialised inside the submit path every N records and written to a sink nothing ever reads, while `recover()` ignores snapshots entirely  |
| `services/svc-matching/src/engine/journal.ts:157`                                                                            | `FileJournal` holds every journal record in memory for the process lifetime and loads the whole file as one JS string at boot — there is no rotation, truncation or compac |
| `services/svc-matching/src/index.ts:74`                                                                                      | /health serialises and sorts every resting order in every book on every request, unauthenticated, on the same single thread that matches orders                            |
| `services/svc-matching/src/index.ts:74`                                                                                      | `GET /health` rebuilds and sorts the entire cross-market resting-order list just to report a count, and Docker probes it every 5 seconds                                   |
| `services/svc-matching/src/reconcile.test.ts:422`                                                                            | summarizeReconcile's only test passes an empty report, so a constant-returning implementation is green — and both L3 reconcile helpers are unreachable from any route      |
| `services/svc-matching/src/reconcile.ts:170`                                                                                 | reconcile() collapses engine orders into a Map keyed on order id, so a second live order under the same id is invisible and the report returns ok:true                     |
| `services/svc-notify/src/channels/refusal-code-honesty.test.ts:18`                                                           | Assertion that is literally the implementation: expect(refusalCodeCount()).toBe(allRefusalCodes().length)                                                                  |
| `services/svc-notify/src/dispatch.ts:103`                                                                                    | The refusal code `channel.target_unverified` is declared and published in the code's own vocabulary but is never emitted — an unconfirmed address is recorded as "no addre |
| `services/svc-notify/src/index.ts:91`                                                                                        | Notification mute preferences are stored in process memory only — the API confirms the write and it is lost on every restart                                               |
| `services/svc-notify/src/preferences/digest.ts:1`                                                                            | The digest-cadence preference subsystem is 994 lines of tested but completely unreachable code — the promised behaviour does not exist                                     |
| `services/svc-notify/src/required-channels.ts:1`                                                                             | Dead duplicate boot-gate parser sitting untracked in the main checkout — the exact class of drift the worktree's own code warns about                                      |
| `services/svc-p2p/src/p2p-service.ts:1494`                                                                                   | A release whose fee rounds up to the entire escrowed amount builds a zero-amount buyer entry that the ledger always rejects — after the terminal decision is already commi |
| `services/svc-p2p/src/p2p-service.ts:1886`                                                                                   | `escrowIntegrity()` nets drift across a seller's trades, so equal-and-opposite escrow errors report `{ ok: true }`                                                         |
| `services/svc-p2p/src/p2p-service.ts:976`                                                                                    | `cancelTrade`'s authorisation checks run on an unlocked read, so the 'a buyer may not cancel after declaring the fiat sent' rule is not enforced under concurrency         |
| `services/svc-p2p/src/p2p-service.ts:1470`                                                                                   | Buyers accumulate escrow-release samples, so the `fast-release` badge is awarded to accounts that have never released anything                                             |
| `services/svc-p2p/src/pricing.test.ts:79`                                                                                    | Dead assertion in the P2P pricing suite — `.toMatchObject` is read as a property, never called                                                                             |
| `services/svc-p2p/src/router.ts:382`                                                                                         | `trades.take` has no client idempotency key, so a retried take escrows the seller's funds a second time                                                                    |
| `services/svc-protocol/src/amm/mint-swap-onchain.test.ts:191`                                                                | The AMM on-chain suite deploys a real pool and swaps through it but never compares the TypeScript quote against the contract — the one thing the suite exists to prove     |
| `services/svc-protocol/src/events.ts:57`                                                                                     | The chain observer subscribes to SessionGranted / SessionRevoked with no address filter, so any contract on the chain can cause protocolSessionKey* events to be published |
| `services/svc-protocol/src/router.ts:841`                                                                                    | Nothing between the API and the pool rejects a zero-address LP recipient, so an add-liquidity call can silently burn both deposits                                         |
| `services/svc-token/src/router.ts:441`                                                                                       | svc-token's mount test covers every money procedure's MFA gate but no governance procedure — and createProposal is the one place admin:treasury skips the MFA check        |
| `services/svc-token/src/token-service.ts:598`                                                                                | emissionParams accepts initialEpochReward as a JSON number, putting a float on the mint path in violation of the money rule the sibling parser enforces                    |
| `services/svc-token/src/token-service.ts:842`                                                                                | recordBuyback accepts tokensBought of zero, permanently consuming a revenue window with a run that burns nothing and cannot be undone                                      |
| `services/svc-trade/src/futures/funding-settlement.ts:101`                                                                   | The pro-rata split of futures funding is never exercised: every test uses exactly one long and one short, where the weighting term is algebraically the identity           |
| `services/svc-trade/src/futures/job-host.test.ts:5`                                                                          | job-host.test.ts covers neither of the two behaviours the job host exists to guarantee: the error handler on a rejected tick, and the overlap guard                        |
| `services/svc-trade/src/futures/liquidation-tick.ts:174`                                                                     | The liquidation scan fetches a mark per POSITION rather than per market — N open positions on one market means N depth RPCs to svc-matching every 15 seconds               |
| `services/svc-trade/src/futures/liquidation-tick.ts:205`                                                                     | The deviation breaker #965 armed bounds only single-tick jumps — the liquidation tick advances its own basis 20% every 15s, and position-service.ts's "unratchetable" comm |
| `services/svc-trade/src/futures/tick-stores.test.ts:70`                                                                      | An assertion that cannot fail, guarding the futures liquidation event: expect(publish).not.toHaveBeenCalled() on a vi.fn() that is never wired to anything                 |
| `services/svc-trade/src/mm/seed-market.ts:129`                                                                               | An indeterminate ledger hold post is recorded as 'hold_failed' and the run is never tracked, so committed market-maker holds are stranded with no releaser                 |
| `services/svc-trade/src/mm/seed-market.ts:152`                                                                               | seedMarket's submit_indeterminate branch — the one that leaves house inventory held against a possibly-live order — has no test                                            |
| `services/svc-trade/src/spot/sequence-guard.ts:94`                                                                           | /ready runs an unbounded aggregate over the whole trade.fills table plus one serial HTTP call per market on every readiness probe                                          |
| `services/svc-trade/src/spot/trade-service.ts:1330`                                                                          | XP for a filled order is published after the terminal status write and is permanently lost if the broker is down, because finalize short-circuits on any retry             |
| `services/svc-trade/src/spot/trade-service.ts:245`                                                                           | listMarket silently discards every change to an existing market's fees, tick, lot and limits, and returns the stale row as a success                                       |
| `services/svc-trade/src/spot/trade-service.ts:767`                                                                           | settleOutcome re-reads the same order rows and re-runs a SUM aggregate once per fill, so one market order sweeping k levels costs ~13k sequential round trips inside a sin |
| `services/svc-ws/src/depth/hub.ts:271`                                                                                       | DepthHub cold-start seed and the poller both write #books with no ordering guard, so a slow seed can roll the book backwards and force-snapshot every subscriber with stal |
| `services/svc-ws/src/env.ts:137`                                                                                             | svc-ws now holds the platform's symmetric JWT signing secret, and every governing record still states it holds no credential                                               |
| `services/svc-ws/src/private/gateway.ts:78`                                                                                  | Private gateway parses the upgrade URL against the client-controlled Host header; an unparseable Host makes it write an HTTP 500 into a socket the public gateway has alre |
| `services/svc-ws/src/routes.ts:67`                                                                                           | Unauthenticated `/ready` on the internet-facing port discloses the internal address of svc-matching                                                                        |
| `services/svc-ws/src/trade/source.ts:33`                                                                                     | A newly-created JetStream durable replays the stream's full 90-day history and svc-ws fans every replayed message out as a live frame                                      |
| `tooling/agent-protocol/AGENT_PROTOCOL.md:70`                                                                                | AGENT_PROTOCOL §3 states 'pnpm gates # 14 doctrine gates' and lists 14; the runner has 27                                                                                  |
| `tooling/ci/agent-autoload-scan.mjs:84`                                                                                      | agent-autoload-scan's out-of-repo path regex misses `$HOME/projects/` and any home directory not named `projects`                                                          |
| `tooling/ci/dod-gate.mjs:149`                                                                                                | Nothing in the repo verifies a TracerProvider was actually registered — the DoD gate still passes on the exact silent failure this package exists to fix                   |
| `tooling/ci/dod-gate.mjs:72`                                                                                                 | dod-gate's §13-socket check only sees a deferral written on ONE line — a two-line comment ships green                                                                      |
| `tooling/ci/dod-gate.mjs:149`                                                                                                | dod-gate's observability check is satisfied by the word `withSpan` in a comment or in a test file                                                                          |
| `tooling/ci/gates.mjs:329`                                                                                                   | gates.mjs manifest check — the file's central promise — is defeated by a subdirectory or a `.js` extension                                                                 |
| `tooling/ci/gates.mjs:350`                                                                                                   | The CI-parity self-guard in gates.mjs is a substring search over ci.yml text — a comment satisfies it while the step is disabled                                           |
| `tooling/ci/gates.mjs:313`                                                                                                   | gates.mjs — the repo's canonical manifest of what runs where — still describes the pre-#971 workflow, and its self-check cannot notice                                     |
| `tooling/ci/infra-verdict.mjs:150`                                                                                           | infra-verdict exits 0 on an empty journal even under CI=true / REQUIRE_POSTGRES=1 — the backstop asserts no lower bound                                                    |
| `tooling/ci/killswitch-reachability.mjs:179`                                                                                 | killswitch gate prints "nothing publishes a host port outside the door unrecorded" but only inspects containers named `svc-*`                                              |
| `tooling/ci/money-property.mutation.mjs:86`                                                                                  | An interrupted money-property-mutation run leaves money.ts on disk carrying a live money defect                                                                            |
| `tooling/ci/reachability-scan.mjs:126`                                                                                       | The reachability gate reports '0 unreachable' while two modules in the tree meet its own stated failure condition — its importer test is a basename match, so a same-named |
| `tooling/ci/unreported-suites.mjs:40`                                                                                        | Half the unreported-suites register (7 svc-protocol suites) has no staleness check, contradicting the file's own 'it cannot go stale' claim                                |
| `tooling/ci/wallet-rpc-mainnet-scan.mjs:382`                                                                                 | The mainnet gate fences whichever wallet-RPC tree it finds FIRST and never checks for a second — a duplicated tree is scanned zero times and the gate still prints its cle |
| `tooling/ci/wallet-rpc-mainnet-scan.mjs:508`                                                                                 | Two of M1's three mainnet-selector rules are proven by nothing — neutering them leaves the summary numerically identical and the gate green over a live NetworkParameters. |
| `tooling/ci/wallet-rpc-mainnet-scan.mjs:2177`                                                                                | The mainnet gate reads .properties only — a Spring Boot application.yml carrying a live mainnet endpoint and contract address in the same tree is invisible, and no denomi |
| `tooling/ci/workspace-sync.mjs:331`                                                                                          | Fixing the port bindings silently disarms the port-collision gate: `workspace-sync` check 4 captures zero ports once `127.0.0.1:` is prefixed                              |
| `tooling/uiproof/auth.spec.mjs:80`                                                                                           | The Pass-3 'honest empty' assertion is vacuous — /available/i and /0\.00/ match the shell on any page                                                                      |
| `tooling/uiproof/proof.spec.mjs:130`                                                                                         | The uiproof mount assertion is satisfied by the App.vue chrome, so it never proves the route under test rendered anything                                                  |
| `vendor/upstream-exchange/00_framework/pom.xml:90`                                                                           | The MongoDB driver pin in the parent POM is inert, and its committed rationale contradicts the compose file's                                                              |
| `vendor/upstream-exchange/00_framework/ucenter-api/src/main/java/com/bizzan/bitrade/config/RedisCacheConfig.java:53`         | Redis cache serializer enables Jackson polymorphic typing on jackson-databind 2.9.1 in four money-path services                                                            |
| `vendor/upstream-exchange/00_framework/ucenter-api/src/main/java/com/bizzan/bitrade/controller/PromotionController.java:392` | @Transactional is inert on two private @RequestMapping money handlers — Spring cannot advise private methods, so multi-write handlers have no rollback boundary            |
| `vendor/upstream-exchange/00_framework/ucenter-api/src/main/java/com/bizzan/bitrade/controller/WithdrawController.java:232`  | Withdrawal amount is never truncated to the coin's withdraw scale — BigDecimal.setScale result discarded                                                                   |
| `vendor/upstream-exchange/00_framework/ucenter-api/src/main/resources/dev/application.properties:139`                        | prod and test application.properties are 0 bytes while all three Maven profiles are activeByDefault — the only real config is `dev`, and it disables actuator security     |
| `vendor/upstream-exchange/05_Web_Front/Dockerfile:45`                                                                        | The vendor shell image is built with `npm install`, not `npm ci`, directly under a comment promising the image matches what the lockfile pins                              |
| `vendor/upstream-exchange/05_Web_Front/src/config/intafaced.js:36`                                                           | config/intafaced.js documents a `schema` parameter that none of its four functions accept, and imports ix-wire without using it                                            |
| `vendor/upstream-exchange/05_Web_Front/src/pages/index/Index.vue:911`                                                        | The home-page market table skips the wire-shape validation the trading terminal applies to the same two endpoints                                                          |

### 5.4 · Refuted on inspection

100 claims did not survive. They are listed so the record is complete and so nobody re-raises them.

| Where                                                                                                                   | Claim                                                                                                          | Why it failed                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/svc-pay/src/rails/evm-chain.ts:219`                                                                           | EvmLiveChain forgets every acceptance address on restart and throws away its own block lookback, so deposits s | The repo already discloses this honestly: the tracker entry for the crypto rail names 'address book + watcher are in-process' as a residual that BLOCKS production go-live, and states that do |
| `services/svc-pay/src/rails/evm-chain.ts:200`                                                                           | A broadcast on-chain payout whose receipt wait times out is treated as "never sent": the ledger hold is revers | The double-send half is wrong: the transaction hash is written to the durable broadcast journal at line 199 BEFORE the receipt wait at line 200, and a retry with the same key returns that st |
| `services/svc-pay/src/rails/evm-chain.ts:217`                                                                           | Live crypto deposit watching is in-process memory only — a restart makes every already-issued acceptance addre | Same claim as finding 1 and refuted on the same grounds: the tracker explicitly names 'address book + watcher are in-process' as a disclosed residual that blocks production go-live for this  |
| `services/svc-matching/src/engine/engine.ts:266`                                                                        | Scoping correction: the order book itself is not racy — journal append and book mutation are one synchronous b | Not a finding — its own text says 'Not a defect'. Its content is accurate (I confirmed journal append and book mutation sit in one synchronous block in both submit() and cancel(), with no aw |
| `services/svc-p2p/src/p2p-service.ts:1873`                                                                              | escrowIntegrity() reports false drift for the documented lock-committed-but-trade-still-created window, so the | The finder assumed the check reads a per-seller pooled escrow balance, but line 1885 reads tradeEscrowAccount(seller, asset, row.id) — a pot keyed by the individual trade id — and the loop o |
| `services/svc-notify/src/required-channels.ts:26`                                                                       | The uncommitted required-channels.ts is unfinished: it is a rival copy of a boot gate that the shipped code do | The harm claimed (a future agent wires this rival parser into boot in place of the env.ts gate) is guarded twice in ways the finder did not check: the shipped channels/registry.ts header com |
| `services/svc-notify/src/required-channels.ts:22`                                                                       | Uncommitted svc-notify required-channels.ts duplicates already-shipped, already-wired logic under a different  | It restates as a defect exactly what the repo already discloses on purpose: registry.ts states 'THIS IS THE ONLY PARSE OF NOTIFY_REQUIRED_CHANNELS IN THE SERVICE' and explains in its header  |
| `services/svc-notify/src/required-channels.ts:5`                                                                        | Main checkout carries real, never-committed, unique source code — not a worktree, on a branch 198 commits behi | Nothing about money or takeover is involved, so 'critical' is wrong by definition, and the premise is also false: the at-risk content here is the file the shipped code explicitly documents a |
| `tooling/ci/dependency-audit.mjs:127`                                                                                   | Making this required converts one newly-published LOW-severity advisory into a repo-wide merge block — and the | This is the documented design, not a defect: the header at lines 24-34 states 'THE LIST CANNOT GROW' and that any NEW advisory fails, the gates registry entry (tooling/ci/gates.mjs:313) repe |
| `apps/admin/src/lib/admin-bff-gate.ts:13`                                                                               | The admin BFF gate fails OPEN by default, so the endpoint that halts all value movement platform-wide is unaut | Line 13 does say `if (!secret) return null`, but this is an explicitly optional, opt-in stopgap, not a gate that silently fails open: the file's own header (lines 2-6) states "Optional gate. |
| `services/svc-trade/src/spot/trade-service.ts:344`                                                                      | The convert spread is quoted to the user but never charged — execution settles at raw book prices, so the adve | Already disclosed by the repo: the header on convertSpreadBps says execution still walks the real book via market IOC, and the prior audit ledger parks this as M-05 'Convert house spread not |
| `services/svc-trade/src/spot/trade-service.ts:1305`                                                                     | finalize posts to svc-ledger over HTTP inside an open Postgres transaction while holding a row lock, so the re | The finalize header documents this exact ordering and outcome: release before status, so a crash leaves a non-terminal row, a retry recomputes the same remainder, and the fixed release key m |
| `services/svc-trade/src/spot/trade-service.ts:538`                                                                      | A placeOrder retry silently returns a stranded `pending` order as if it had been placed                        | The returned record carries status 'pending', so nothing is reported as placed; and the stranded-row case is explicitly documented with an owner action in reconcileOrder's table (orphan pend |
| `services/svc-trade/src/spot/trade-service.ts:321`                                                                      | Scoping correction: the convert stale-quote free-option premise does not hold — execute re-quotes live; the re | This is a scoping note, not a defect: it correctly retracts the stale-quote premise and then restates the uncharged convert spread, which the repo already parks as M-05 and documents in the  |
| `services/svc-trade/src/spot/trade-service.ts:1755`                                                                     | On a market whose liquidity is the house MM bot, publicTape's seeded exclusion filters out every print, so LIM | Intentional and documented at the exact insert site: the house market-maker stub is written with seeded=true specifically 'so public tape / candles exclude house MM prints (SD-3)'. The empty |
| `docker-compose.yml:23`                                                                                                 | The platform's Postgres — the money database — is published on all interfaces with a superuser password commit | Both halves are already disclosed honestly by the repo itself: docs/A1.4-WALLET-SECRETS-PERIMETER-2026-07-30.md lists Postgres 5433 on 0.0.0.0 as finding P6 at Medium with the written reason |
| `docker-compose.yml:250`                                                                                                | Grafana runs with anonymous Admin on a published port, and the doc that records the platform perimeter now des | The core is a verbatim restatement of finding P5 in the repo's own perimeter register, which already records Grafana anonymous Admin on 0.0.0.0:3001 at Medium. Both claims the finder added o |
| `.github/workflows/ci.yml:42`                                                                                           | Zero required checks: `main` has no branch protection and no rulesets, so every gate in every workflow is advi | This is already on the record as a known owner action, not a new discovery: docs/ops/OWNER-GITHUB-CONFIG.md item G1 states 'No branch protection on main', re-verified 2026-08-07 with the sam |
| `tooling/ci/vendor-java-money-scan.mjs:106`                                                                             | vendor-java-money-scan reports "clean" while a live absolute-set write to member_wallet.balance sits in the ve | The title's load-bearing claim — that a live absolute-set balance write "sits in the very DAO it audits" — is false. I read all 174 lines of MemberWalletDao.java: every one of its 14 @Modify |
| `vendor/upstream-exchange/00_framework/admin/src/main/java/com/bizzan/bitrade/config/ShiroConfig.java:133`              | Admin console ships a publicly-known Shiro rememberMe AES key — any anonymous request can forge an admin sessi | Line 133 is quoted correctly and the key is a genuinely well-known Shiro cipher key, but the failure scenario cannot occur: the `admin` module is not built or deployed anywhere. No `target/` |
| `vendor/upstream-exchange/00_framework/admin/src/main/java/com/bizzan/bitrade/config/ShiroConfig.java:133`              | Admin console ships a hardcoded Shiro rememberMe AES key — the cookie is deserialized before authentication, a | Duplicate of finding 0 and refuted on the same verified ground. Lines 133 and 152 are quoted accurately, but the stated attack — 'sends it as the rememberMe cookie to any admin endpoint' — p |
| `services/svc-academy/src/academy-service.ts:350`                                                                       | svc-academy's 1063-line AcademyService — the staked-lobby access gate, the seat race, invite consumption — is  | Line 350 is indeed `async join()` and it is true that no test constructs AcademyService (router.mount.test.ts imports it type-only and stubs it). But the finding's substance is wrong on two  |
| `packages/safe-regex/src/index.ts:2`                                                                                    | safe-regex (FH-SEC-01) never runs on untrusted input — all three of its call sites parse developer-authored co | The reachability trace is roughly right (parseSymbol/parseSubject have no external callers), but this is a doc-reading concern, not a code defect, and the scope is already disclosed honestly |
| `packages/safe-regex/src/index.ts:95`                                                                                   | escapeLiteral (and near-dead isSafeMethodId) in @intafaced/safe-regex have zero real callers                   | An unused-export complaint, not a defect — the finding says so itself ('No functional bug today'). The header at line 12 explicitly documents this as intended Stage-1 scope: 'Stage-1 lands t |
| `services/svc-indexer/src/projection/postgres-store.ts:246`                                                             | Emptied book levels are retained forever and are read on every book request, because quantity>0 and LIMIT are  | Both halves are documented trade-offs in header comments the finder did not credit: postgres-store.ts:238-245 states the quantity>0 filter sits outside the DISTINCT ON precisely because putt |
| `packages/events/src/catalog.ts:918`                                                                                    | buybackExecuted publishes tokensBought and tokensToRewards as settled figures that no ledger movement backs, a | The finder treats 'nothing is actually bought back' as a concealed defect, but svc-token/src/token-service.ts states it in capitals in its own header ('NOTHING IS BOUGHT BACK HERE… tokensBou |
| `services/svc-ledger/src/service.ts:116`                                                                                | The operator unfreeze reports 400 'failed' after it has already thawed the ledger                              | This exact behaviour is documented as an intentional trade-off in the method it concerns — service.ts:175-178 on `publishFreeze` states that after the durable write 'if this publish throws,  |
| `services/svc-ledger/src/service.ts:206`                                                                                | On a detected reconciliation mismatch, a bus failure suppresses the alarm event entirely and downgrades the op | The `reconcile()` header at lines 196-200 documents this verbatim as the deliberate choice: 'If the bus is down, the alarm fails to send and this throws — with the book already halted. An al |
| `services/svc-matching/src/index.ts:74`                                                                                 | Unauthenticated GET /health does O(every resting order) work on the matching event loop — 210x the cost of a d | The mechanism is real (restingOrderCount does rebuild and sort every order), but the stated failure — 600 requests/second from 'any browser or script' — cannot occur: docker-compose.apps.yml |
| `services/svc-dex/src/router-quote.ts:151`                                                                              | `Route.totalQuoteAmount` is a gross figure — it omits settlement cost on both sides and the taker fee on a sel | The arithmetic claim is true but it is not a defect: totalQuoteAmount is the sum of the per-venue quoteAmount field, which the type documents at line 44 as the raw book cost/proceeds, and th |
| `tooling/ci/reachability-scan.mjs:54`                                                                                   | Scoping correction: the Stage-1 agent guardrail modules named in the brief are declared-unreachable parked cod | The factual core is true (I confirmed registerAgent has no caller outside runtime.test.ts, and the four *AgentGuardrail factories are referenced only by their own tests and honesty modules), |
| `tooling/ci/reachability-scan.mjs:132`                                                                                  | reachability-scan's KEEPERS message claims the money-deny honesty files carry a safety property; their tests a | Both stated failure scenarios fail on the actual tests. Adding a money tool to the declared list WOULD go red: navigator/guardrail.test.ts loops NAVIGATOR_MONEY_WRITE_TOOLS through evaluateT |
| `tooling/ci/killswitch-reachability.mjs:179`                                                                            | SCOPING CORRECTION: the §14.6 CI gate greps for the console's route files and explicitly skips the admin conta | The gate never claims what the finder says it claims. Its file header states it is "Deliberately structural rather than behavioural", and the closing comment plus the four printed lines (327 |
| `packages/auth/src/scopes.ts:306`                                                                                       | No code path in the repo can issue any admin:* scope, so the ledger freeze, module kill-switch, KYC approval a | Admin tokens are deliberately NOT mintable from the user auth surface — scopes.ts states 'Operator scopes. Never on a user session, whatever the account.' They are deployment credentials: th |
| `services/svc-ws/src/index.ts:128`                                                                                      | The `ws.gateway` kill-switch cannot be pulled by an operator at all, and never closes an open socket — both be | The finder read the line numbers correctly but missed the guard: `ws.gateway` is registered in packages/config/src/flags.ts:177 as `serviceEnv('svc-ws','WS_GATEWAY_ENABLED')`, and the admin  |
| `services/svc-edge/src/index.ts:47`                                                                                     | The shipped deployment collapses the rate limiter into one global bucket, so any single caller can throttle th | The mechanism is technically accurate (line 47 is quoted correctly, nginx does proxy /api/ to svc-edge, and EDGE_TRUST_PROXY is set nowhere in compose), but this is a trade-off the repo docu |
| `services/svc-edge/src/index.ts:191`                                                                                    | `/ready` hands the operator kill state to any unauthenticated caller, unthrottled — the exact leak the CORS la | The information /ready publishes is not a leak because any unauthenticated caller can already read it from the kill-switch guard itself: control-plane.ts:84-91 answers every request to /api/ |
| `services/svc-ledger/src/ledger/postgres-ledger.ts:84`                                                                  | SCOPING CORRECTION — the double-spend shape the scoping pass named is closed; the residual concurrency risk in | This is not a defect finding at all — the finder states the double-spend risk does not exist here, and I confirmed that: every post takes FOR UPDATE on the singleton chain_tip row (lines 86- |
| `packages/venue-adapter/src/fabric/latency.ts:251`                                                                      | The entire §27 fabric (gap detection, cross-check, latency grading, rate governing) has no production consumer | The mechanism is factually wrong on its central claims: the production adapter BinanceSpotMarketData constructs and drives both the rate governor and the latency grader on every REST read (b |
| `packages/exchange-contract/src/api.ts:100`                                                                             | WS_CHANNELS publishes seven WebSocket channels and a subscribe-frame protocol; svc-ws implements two channels, | The failure scenario cannot occur: exchange-contract is a private, unpublished workspace package (package.json "private": true, version 0.0.0) and WS_CHANNELS is referenced by nothing except |
| `packages/exchange-contract/src/api.ts:110`                                                                             | RATE_LIMITS publishes limits four times higher than the edge actually enforces, and the throttle refusal is no | RATE_LIMITS is a dead constant — grep across the tree finds it only in its own declaration, so no CCXT bot or client ever reads it (the package is private and unpublished; CCXT reads a rateL |
| `vendor/upstream-exchange-compose.yml:225`                                                                              | Every Java service in vendor/upstream-exchange-compose.yml references a jar that is gitignored and absent — `c | The facts are right (no target/ dirs exist, each module's .gitignore ignores /target/), but the repo already discloses this in full: docs/UPSTREAM-ADOPTION-QUEUE-2026-08-02.md §2.4 is litera |
| `vendor/upstream-exchange-compose.yml:285`                                                                              | The vendored compose passes NO environment to any Java service, so every `${VAR}` secret placeholder the secur | Three errors. (1) Both profiles set management.security.enabled=false two lines above the password (ucenter-api:139, otc-api:71), so no basic-auth credential guards /monitor/heapdump at all  |
| `packages/exchange-contract/src/schemas.ts:347`                                                                         | Three declared CCXT error classes have no emitter, and the shell's error table has no arm for the one refusal  | Two claims, neither a defect in this file. (a) EXCHANGE_ERROR_CODES is deliberately CCXT's published taxonomy — the header at schemas.ts:342-346 says integrators branch on these names — so d |
| `vendor/upstream-exchange/00_framework/core/src/main/java/com/bizzan/bitrade/event/MemberEvent.java:90`                 | Live, ungated credit to member_wallet.to_released on registration — invisible to the money scan, the 410 door, | The headline claim "live, ungated credit on registration" is false: promotion() is private and its ONLY caller is onRegisterSuccess line 70, which sits inside `if (needRealName == 0)` at lin |
| `docs/ops/FREEZE-LIVE.md:1`                                                                                             | docs/ops/*.md status snapshots are auto-generated and safe to lose — not a real risk, noted to avoid false ala | This is not a defect — the finder explicitly writes "fail: None". Its factual content is correct (I confirmed FREEZE-LIVE.md line 1-3 and R00/R01/R02/DASHBOARD.md all carry "(generated)" hea |
| `docs/ops/FREEZE-LIVE.md:1`                                                                                             | docs/ops/FREEZE-LIVE.md is being independently, uncommittedly regenerated in at least four separate checkouts  | The count is factually right — I ran git status across all 42 registered worktrees and exactly four hold uncommitted FREEZE-LIVE.md edits (main, coord-freeze-live, /private/tmp/sov-claim-che |
| `apps/admin/src/app/page.tsx:14`                                                                                        | The BFF gate covers only the two API routes — the console's pages are ungated and render the live control-plan | The mechanics are correct (page.tsx line 14 does call readKillSwitches() and no middleware.ts exists), but this is a limitation the repo discloses honestly and in three places, not an undete |
| `services/svc-pay/src/index.ts:325`                                                                                     | A verified inbound chain event that matches no payment is answered 202, marked delivered by the watcher, and r | The stated failure cannot occur. The acceptance address is only ever derived inside `CryptoNativeAdapter.authorize`, and the only way a payer ever learns it is an authorize that returned `pe |
| `services/svc-notify/src/preferences/combined.ts:31`                                                                    | svc-notify's entire digest/fan-out delivery-planning layer (994 lines) is imported by nothing in production —  | The unreachability fact is correct (combined.ts is imported only by its own test; dispatch.ts never touches digest), but the failure scenario cannot occur: router.ts exposes only mutePrefs/s |
| `.github/workflows/supply-chain.yml:60`                                                                                 | The required "Supply chain" check is green because it only reads pnpm-lock.yaml — the adopted Java product's e | The mechanical facts are right (the job runs only `node tooling/ci/dependency-audit.mjs`, which shells to `pnpm audit --json` at dependency-audit.mjs:100, and .github/dependabot.yml declares |
| `vendor/upstream-exchange/01_wallet_rpc/ltc/pom.xml:64`                                                                 | 32 unverifiable binary jars sit on the classpath of the key-handling wallet services, including an orphan bitc | Every element of this finding is already written down in the repo, verbatim, as a disclosed limitation with an owner action: docs/adr/2026-07-28-vendored-exchange-integration.md:127-129 ("## |
| `docs/security/WALLET-RPC-SECURITY-REVIEW-2026-08-05.md:3`                                                              | 00_framework — the admin console and all three user-facing APIs — has never had a security review, while docs/ | The document is scoped to 01_wallet_rpc in its title, its Scope line (line 4), its "What was read" section ("Every .java file under vendor/upstream-exchange/01_wallet_rpc"), its filename, an |
| `packages/db/src/db.test.ts:4`                                                                                          | packages/db's transaction()/serializable() is untested — the retry loop, the isolation level and the BEGIN its | The premise is right (db.test.ts line 4 imports only isSerializationFailure, and no test calls transaction() directly) but the load-bearing claim — that the BEGIN could be deleted with the s |
| `docker-compose.apps.yml:965`                                                                                           | The operator console publishes port 3100 on all interfaces with no authentication by default, and the kill-swi | The mechanics are accurately read (line 964 is the bare ADMIN_BFF_SHARED_SECRET pass-through, line 965 is ports ['3100:3100'], and admin-bff-gate.ts returns null when the secret is unset), b |
| `tooling/frontend/residual-register.json:81`                                                                            | Residual A2 "Withdraw decimal + receipt + lock" is marked done on evidence of a module with zero importers beh | The 'no importer' fact is true (only its own golden test requires it), but the repo already discloses exactly this in ADR docs/adr/2026-08-04-platform-pages-ia.md:62 — 'withdraw-math.js sits |
| `docs/COORDINATOR-INDEPENDENT-AUDIT-2026-08-07.md:165`                                                                  | Repo went public and thrift was deleted entirely ~90 min after two same-day audit docs diagnosed a live 'dead  | The raw fact checks out (thrift-preflight.mjs was deleted from origin/main in 89e1a71e at 15:42, and line 165 does cite it), but this is disclosed snapshot staleness, not a defect: the doc p |
| `services/svc-academy/src/certs/xp-emit.ts:8`                                                                           | Uncommitted svc-academy certs L3 slice fails typecheck right now                                               | The core factual claim is false in the tree under audit: xp-policy.ts and progress.ts both exist at services/svc-academy/src/certs/ in the mega-audit worktree and are git-tracked (git ls-fil |
| `services/svc-agents/src/router.ts:236`                                                                                 | Any user with `agents:execute` can open a session against any registered agentId, including one whose guardrai | The stated failure — an ordinary user driving write-mode pay/bank tools through an uncapped agent — cannot occur: this router exposes no tool-call procedure at all (its whole surface is heal |
| `services/svc-protocol/src/router.ts:509`                                                                               | The session-key spend-cap preflight defaults on-chain spend to zero and never checks the presented scope was a | This procedure is not a guard: its own implementation comment says "The chain runs the same checks and does not consult this one", the repo's public-procedure audit already classifies it as  |
| `packages/auth/src/tokens.ts:135`                                                                                       | verifyAccessToken accepts a JWT with no `exp` claim and reports it as expiring at epoch 0; three operator/sock | The only way to present a signature-valid token with no `exp` is to hold JWT_ACCESS_SECRET — and a holder of that key can already mint a token with `exp` set 100 years out, so the missing `r |
| `packages/auth/src/tokens.ts:114`                                                                                       | Nothing revokes an issued access token — logout, logoutAll, refresh-reuse detection, API-key revocation and ac | This is the stated design, not a defect: the file header (tokens.ts:10-13) says access tokens are short-lived and carry scopes precisely so every service authorises locally without a round t |
| `packages/telemetry/src/start.ts:144`                                                                                   | isTelemetryActive exported from @intafaced/telemetry, called nowhere but its own test                          | `isTelemetryActive` is an exported helper used by its own test; an unused public export is a dead-code/refactor observation, not a defect — nothing behaves incorrectly, and the finding itsel |
| `services/svc-notify/src/channels/refusal-code-honesty.test.ts:21`                                                      | svc-notify 'honesty board' tests assert round-trips a module performs against itself — they cannot fail for an | The title's claim — the assertion "cannot fail for any implementation" — is false, and the finder concedes it: refusalCodeCatalogStatusLineMatches() returns false if the format string (refus |
| `INTAFACED_DEFINITIVE_BUILD.md:63`                                                                                      | 3 of the 4 law-named §8 services are missing with zero disclosure anywhere in docs                             | The core premise — "zero disclosure anywhere in docs" — is false. docs/TRACKER.md (launch.token-factory row) states verbatim "STILL NOT DONE: no services/svc-launch (§8.4 owns launchpad/meme |
| `INTAFACED_DEFINITIVE_BUILD.md:55`                                                                                      | 3 real, tested services (svc-edge, svc-support, svc-ws) exist in code but are named nowhere in the law         | The literal observation is correct (svc-edge, svc-support, svc-ws appear nowhere in the law), but the stated failure cannot occur: docs/TRACKER.md carries a green ops.support row naming svc- |
| `tooling/ci/vendor-shell-scan.mjs:152`                                                                                  | vendor-shell-scan matches one line at a time — every hazard pattern is defeated by a newline, in a tree of con | The named failure scenario is caught by the companion gate vendor-java-money-scan.mjs, which runs in the same gates job (gates.mjs:167). Its Check 2 positively asserts that any @Query on one |
| `tooling/ci/vendor-shell-scan.mjs:121`                                                                                  | vendor-shell-scan never opens `.sql` files, while three exist under vendor/ and one of its rules is a pure-SQL | The extension filter does omit .sql, but the failure cannot occur: vendor/upstream-exchange-compose.yml:62 documents that nothing is mounted at /docker-entrypoint-initdb.d by design, so no v |
| `services/svc-protocol/src/amm/build.ts:39`                                                                             | svc-protocol ships the AMM deposit path with no withdrawal path — there is no builder or procedure for burn    | The code facts are right (no burn builder, no LP-balance read), but this restates a limitation the repo already discloses: docs/TRACKER.md line 173 marks protocol.amm as blocked, human-owned |
| `tooling/agent-protocol/AGENT_PROTOCOL.md:38`                                                                           | Six AGENT_PROTOCOL §2 'hard prohibitions' have no machine enforcement anywhere in the repo                     | The cited line 38 refutes itself: it names its own enforcement mechanism ("the dev DB enforces this with per-service roles"), and those roles genuinely exist — tooling/infra/postgres-init/01 |
| `apps/admin/src/app/api/ledger-freeze/route.ts:32`                                                                      | No origin or content-type check on either platform-changing POST route — cross-site requests are accepted verb | The stated failure needs an ambient browser credential, and none exists: the admin console has no cookies or session anywhere (grep for cookie/session in apps/admin/src returns nothing) and  |
| `apps/admin/src/lib/console-status.ts:110`                                                                              | The console computes whether its platform-changing routes are gated, then renders nothing — a wide-open consol | The only true part is that `bffGated` (line 110) is assigned and never rendered — an unused field, not a defect. The security framing fails on three checks: the BFF gate is explicitly option |
| `packages/events/src/memory-bus.ts:19`                                                                                  | MemoryEventBus runs subscribers inline inside publish() and never redelivers, so no test in the repo can exerc | Line 19 is indeed publish(), but this is a test/dev double whose header comment explicitly scopes its fidelity ('Behaves like JetStream where it matters: ... handlers run sequentially per su |
| `services/svc-ws/src/private/hub.ts:113`                                                                                | `/private/stream` caps connections globally, not per user — one authenticated account can deny every other tra | The code facts are correct (line 113 caps on total subscriptions, no per-userId accounting, principal is available at gateway.ts:107/114), but the repo already discloses this exact gap by na |
| `packages/exchange-contract/src/symbols.ts:55`                                                                          | The published unified-symbol grammar has no consumer anywhere in the repo, and presentCcxtMarket emits `settle | The cited location is wrong and the defect is not in this file: symbols.ts:55 is the 128-char length cap, and the only concrete defect named (`settle: null` on swap/option markets) lives in  |
| `services/svc-trade/drizzle/0006_paper_markets.sql:15`                                                                  | Migrations validate CHECK constraints on live money tables with no NOT VALID and no lock_timeout, so a single  | The Postgres mechanism is stated correctly (line 15 does add a validating CHECK, and migrate.ts:26 sets no lock_timeout), but the failure scenario cannot occur in the only deployment topolog |
| `services/svc-identity/src/affiliates/commission.ts:100`                                                                | The whole affiliate commission engine is unreachable, and the reachability gate cannot see it because its memb | The factual half is true (nothing outside services/svc-identity/src/affiliates/ imports it), but every part that makes it a defect is wrong. commission.ts's own header states "NO payout, NO  |
| `services/svc-trade/src/spot/matching-client.test.ts:102`                                                               | The matching-client test named 'still authenticates the read' asserts nothing about authentication, and the re | The literal observation is right — the stub only records the URL, so the test named 'still authenticates the read' asserts a path and a limit, nothing about headers — but the failure scenari |
| `services/svc-trade/src/futures/position-loaders.test.ts:5`                                                             | position-loaders.test.ts tests only its own in-memory test doubles; the SQL loader that feeds the funding mone | No defect exists today: the production SQL in position-loaders.ts lines 56-60 and 74-77 does carry `WHERE p.status = 'open' AND p.market_id = ${marketId}` correctly, so the described failure |
| `packages/auth/src/guards.ts:56`                                                                                        | requireOwnership — the platform's only 'may I act on another account's row' guard — has three dedicated tests  | The narrow fact is true (only tests import `requireOwnership`), but the finding's premise — that this is "the platform's only 'may I act on another account's row' guard" — is false: ownershi |
| `vendor/upstream-exchange/05_Web_Front/nginx.conf:75`                                                                   | nginx proxies only /api/, the dev server proxies five prefixes — four API prefixes are answered by index.html  | The failure scenario is factually wrong: Account.vue's getAccount() (src/components/uc/Account.vue:504-536) tests `resp && resp.code == 0`, and an HTML body makes that false, so it DOES take |
| `vendor/upstream-exchange/00_framework/exchange/src/main/java/com/bizzan/bitrade/controller/MonitorController.java:300` | The matching engine's start/stop/reset control endpoints have no authentication of any kind                    | The code reading is accurate (reset-trader:162, start-trader:231, stop-trader:300, no Shiro/interceptor in the exchange module), but this exact issue is already disclosed by the repo as an o |
| `docs/SHIZU-BOARD-AUDIT-2026-08-07.md:112`                                                                              | SHIZU-BOARD-AUDIT's Priority-1 fix ("set owner: shehzad002 on six ownerless chain rows") was already merged 40 | The cited line 112 is literally the line "**Fix applied (see §13):** owners set, with two deliberate exceptions..." — the opposite of the claimed "lists six rows as having no owner". Line 5  |
| `tooling/frontend/preflight.mjs:11`                                                                                     | frontend:preflight prints READY from file existence alone — it never checks that any UI proof ran, and SLICE_T | The central mechanism claim is false: SLICE_TYPE=LAW only relaxes the Orca-ready check (line 133) and the docs/refs artifact check (line 151); the on-main-branch refusal (103), 11 law-file c |
| `.worktrees/audit-pay-live-crypto:1`                                                                                    | audit-pay-live-crypto worktree's HEAD is a genuinely orphaned commit reachable from no branch or tag           | The git facts are right (detached HEAD 41eb9f17, no branch or tag contains it) but the stated loss cannot occur: the commit's content is already in main. Its second parent 48384aec is an anc |
| `docs/MULTI-AGENT-METHOD-AUDIT-2026-08-07.md:1`                                                                         | ~1,800 lines of finished, dated analysis docs sit uncommitted and would vanish on an abrupt session end / chec | The stated failure — the analysis vanishing "with no trace in git log, no PR" — is factually false: line 4 of the doc says the cleanup was executed and merged as #953, and I confirmed commit |
| `.worktrees/docs-frontend-blueprint:1`                                                                                  | Two worktrees hold real untracked content on branches that are otherwise safe-to-delete (zero unique commits v | The raw facts check out (I ran it: branch docs/frontend-final-blueprint is 735 behind / 0 ahead, with exactly 3 untracked docs), but the failure scenario is guarded in the place the finder n |
| `services/svc-pay/src/rails/evm-chain.live.test.ts:116`                                                                 | Scoping correction: the money risk in svc-pay is concentrated in the live chain adapter, not in payment-servic | Both halves fail. Factually: CI does run this suite — .github/workflows/ci.yml starts anvil (chain-id 31337) on 127.0.0.1:8545 inside the same Tests job, several steps before `pnpm test`, an |
| `tooling/ci/event-wiring.mjs:1190`                                                                                      | Scoping correction: the gate reports 16 sockets and 16 wired events, not the 18 sockets / 14 wired the brief s | The number itself is right (I ran the gate: '32 declared event(s)... 16 wired end to end, 16 recorded socket(s) ... A 15 · B 1 · C 0'), but this corrects a stale count in the audit brief, no |
| `services/svc-indexer/src/chain/evm/source.ts:314`                                                                      | status endpoint fans out to three uncached upstream RPC calls per request against the same endpoint and timeou | The mechanics are accurately described (probe() at line 311-332 does eth_chainId + eth_blockNumber with cacheTime:0 + eth_getCode, and router.ts:211 calls it per status query with no cache), |
| `services/svc-trade/src/spot/order-route-properties.test.ts:52`                                                         | A fast-check 'property' whose generator only ever produces trailing zeros, so it proves nothing about fraction | The generator observation is literally true (line 55 emits only trailing zeros), but the claimed failure cannot occur and the coverage is not missing: formatAmount in packages/ledger-client/ |
| `services/svc-pay/src/tracing.ts:51`                                                                                    | Money spans in svc-pay and svc-p2p export raw exception messages and full stack traces, contradicting the no-m | The code lines are quoted correctly, but the premise is wrong on both halves. svc-identity's comment is explicitly credential-scoped ('never the credential — no password, no TOTP code, no to |
| `packages/contracts/src/analytics-metric-honesty.ts:86`                                                                 | moneyMetricsRefuseNumber() asserts a law it does not check, and its only test assertion cannot fail            | The body description is accurate (line 86 is `listMoneyMetricIds().length > 0`, a duplicate of hasMoneyMetrics), but this is a naming complaint, not a defect: the money-as-number law IS enfo |
| `services/svc-identity/src/affiliates/freeze.test.ts:69`                                                                | The 'L3 wave' status-line test blocks assert round-trips that cannot fail                                      | Both halves of the stated failure scenario are actually caught by this very file: if `accrueWithFreezes` dropped every row, line 33 (`expect(all.length).toBeGreaterThan(0)`, run with an empt |
| `services/svc-trade/src/spot/order-route-chaos.test.ts:54`                                                              | scoping-correction: the skip counts in the brief are stale — 8 files and 9 tests skip locally, not 5 and 6, an | This is not a defect at all — it is a correction to the audit brief's own test-count numbers, and its substantive claim is that the code is CORRECT. I read packages/db/src/testing.ts:582 and |
| `services/svc-academy/src/index.ts:41`                                                                                  | Roughly 2,345 of svc-academy's lines are modules no entry point imports — passing tests over code no user can  | The arithmetic is right (I traced imports: certs/progress 450, certs/xp-policy 200, certs/xp-emit 141, spatial/canvas 288, spatial/reconnect 125, tournaments/season-lifecycle 802, tournament |
| `services/svc-academy/src/certs/xp-policy.test.ts:84`                                                                   | svc-academy certs 'L3 wave' cases are tautologies and cannot-fail assertions that inflate the test count witho | The tautology observation is literally true (lines 85-88, 93 assert things TypeScript already guarantees), but the stated failure scenario is false: the same file hard-pins the XP amount at  |
| `docs/DENON-CALL-BRIEF-2026-08-07.md:89`                                                                                | DENON-CALL-BRIEF's talking point '#904 not merged, mergeable, needs a merge/close decision' was already resolv | The facts check out (doc mtime 11:01:34, merge commit 7c270ae1 for #904 landed 11:35:33 and is an ancestor of origin/main), but line 5 of the same doc explicitly discloses the limitation: 'M |
| `tooling/scripts/tracker.mjs:149`                                                                                       | Tracker's automated 'done' validator checks path existence + coarse mount regex only — TESTED and NOT-PROPPED- | The code does what the finding describes, but this is not a defect: the registry header at tooling/tracker/features.mjs lines 26-38 explicitly and honestly discloses the exact limitation — " |
| `.worktrees/:1`                                                                                                         | Scoping correction: worktree count and branch count have grown past the brief's numbers                        | Not a defect in the system — it is a comment on the audit brief's own headcount, and its specific numbers do not reproduce: at this tip `git worktree list` returns 40 (not 26) and `git branc |

---

## 6 · What to fix, in order

Ranked by _damage if left_ ÷ _effort to fix_. Every one of these is confirmed — either by the lead agent running code, or by an independent verifier reading the source. Nothing speculative is in this list.

### Tier 0 — the launch blocker

| #   | Fix                                                                                                                                                                                                             | Where                                             | Why                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | On the loan retry path, refuse when the persisted row's `principal` differs from `input.principal` — or re-derive LTV from `loan.principal` so the safety check and the payout can never read different numbers | `services/svc-bank/src/loans/loan-service.ts:515` | The one confirmed **critical**. Not exploitable today only because no loan product row exists. **This must be closed before lending is switched on** — after that it is an unbounded drain of the lending reserve |

### Tier 1 — small fixes that close real money or credential holes

| #   | Fix                                                                                                                                              | Where                                                                        | Why it is first                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Add `key`, `mnemonic`, `seed` to the credential-name pattern, and allow a trailing qualifier so `SECRET_KEY_LIVE` matches                        | `tooling/ci/secret-scan.mjs` + the same shape in `compose-secret-parity.mjs` | Today the hot-wallet signing key and the deposit mnemonic can be committed and the gate prints "clean". Roughly a one-line change to a regex |
| 2   | Enforce a maximum leverage in `PositionService.open()` before `initialMargin` runs                                                               | `services/svc-trade/src/futures/`                                            | The doctrine's 10× cap is simply not implemented; the API advertises no maximum                                                              |
| 3   | Make funding move the position row with the money — reduce `margin_initial` (or add `margin_current` the planners read) and write `funding_paid` | `services/svc-trade/src/futures/`                                            | Every close after a funding period over-releases collateral. Live, not latent                                                                |
| 4   | Match the actual `registry.addInterceptor(...).addPathPatterns("/**")` call, not the class name                                                  | `tooling/ci/dual-book-door-scan.mjs`                                         | The architectural boundary between the vendored exchange and the sovereign ledger is currently proved by an unused `import` line             |
| 5   | Add `.worktrees`, `.pnpm-store`, `.tools` to `SKIP_DIRS` — better, derive the skip set from `.gitignore`                                         | `tooling/ci/brand-scan.mjs`                                                  | Restores `pnpm verify` in the main checkout. Today it dies at step 1 and the test suite never runs                                           |
| 6   | Change the two zero-length guards to fail loudly: `if (scanned === 0)`                                                                           | `tooling/ci/i18n-scan.mjs`, `i18n-bypass-scan.mjs`                           | Two of the 27 gates currently certify nothing. `brand-scan` already has exactly this guard — copy it                                         |

### Tier 1b — the other confirmed highs, grouped by the shape of the fix

These came out of the second verification pass and each was read against the source by an independent checker. Grouped because several share one root cause.

| Group                     | Fix                                                                                                                                                                              | Where                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Perimeter**             | Make the kill-switch guard normalise the path before deciding, so a request cannot reach the API by a route the guard does not recognise                                         | `services/svc-edge/src/control-plane.ts:43`                                          |
| **Perimeter**             | Put authentication on the message bus and stop publishing it on every interface — an unauthenticated bus lets a forged "trade filled" settle through the ledger                  | `docker-compose.yml:62`                                                              |
| **Perimeter**             | Stop a session from enrolling its own second factor and then using it to clear the withdrawal step-up                                                                            | `services/svc-identity/src/router.ts:203`                                            |
| **At-most-once delivery** | Mark the dedupe key _after_ the handler succeeds, not before — currently anything that fails once is never retried. Same bug in three places                                     | `packages/events/src/bus.ts:260`, `services/svc-trade/src/events.ts:38,42`           |
| **At-most-once delivery** | Give the matching engine an outbox, or re-emit on recovery — a match is applied to the book before its event publishes, and a publish failure loses the fill with no repair path | `services/svc-matching/src/engine/engine.ts:270`                                     |
| **Order/hold races**      | Read the row count on the pending→open update before submitting to the engine; and make the cancel path and the fill path take the same lock                                     | `services/svc-trade/src/spot/trade-service.ts:585, 1295, 1302`                       |
| **Payments durability**   | Move the ledger post out of the database transaction, and give the settlement reversal a durable marker so a crash cannot strand it                                              | `services/svc-pay/src/payment-service.ts:1426, 1938`, `rails/broadcast-store.ts:138` |
| **Payments auth**         | Move `svc-pay` onto the body-bound signing scheme the other five services already use — its captured signature is replayable today                                               | `services/svc-pay/src/ledger-client.ts:36`                                           |
| **Scaling bug**           | `svc-token` returns a raw scaled integer where a decimal string is expected, and `svc-academy` scales it again — the staked-lobby gate is inflated by 10¹⁸                       | `services/svc-token/src/index.ts:84`, `svc-academy/src/stake-source.ts:58`           |
| **User-visible**          | Make sign-out clear the session unconditionally, as its own comment already promises                                                                                             | `vendor/upstream-exchange/05_Web_Front/src/App.vue:564`                              |
| **User-visible**          | Fix the desk's percent-size buttons — they build quantities from a count of decimal places, so every percent-sized order on the six FX pairs is wrong                            | `…/pages/exchange/Exchange.vue:1871`                                                 |
| **Interest**              | Stop paying a full day's interest to a position opened the same day                                                                                                              | `services/svc-bank/src/earn/earn-service.ts:461`                                     |
| **Coordination**          | An unrecognised claim-lock status is treated as "no lock" — one tracker row is on the free board right now while a live worktree holds it                                        | `tooling/scripts/swarm.mjs:367`                                                      |

### Tier 2 — guards that need real logic, not a regex tweak

| #   | Fix                                                                                                                                                                                                                                                                            | Where                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 7   | Trigger the wallet-write check on the **table** (`member_wallet`), not on four hardcoded method names                                                                                                                                                                          | `tooling/ci/vendor-java-money-scan.mjs`                       |
| 8   | Flag any Protocol Plane import of `@intafaced/ledger-client` without a subpath, instead of matching 18 of 48 recipe names; and match Solidity on the **capability** (a value-moving call behind a platform-key check) rather than on an `onlyOwner` idiom this repo never uses | `tooling/ci/custody-scan.mjs`                                 |
| 9   | Make the event "mounted" test about the **call site**, not file import-reachability                                                                                                                                                                                            | `tooling/ci/event-wiring.mjs`                                 |
| 10  | Actually open the `.down.sql` files, and add `DELETE FROM` and constraint removal to the destructive list                                                                                                                                                                      | `tooling/ci/migration-check.mjs`                              |
| 11  | Derive `LOCK_KINDS` from `AccountKind` with an exhaustiveness check, so a new lock kind cannot silently escape INVARIANT 2                                                                                                                                                     | `packages/ledger-client/src/client.ts`                        |
| 12  | Copy `svc-pay`'s `ledger-client.test.ts` to the five services that move money over the same wire with no such test                                                                                                                                                             | `svc-bank`, `svc-trade`, `svc-token`, `svc-agents`, `svc-p2p` |

### Tier 3 — latent, but cheap to close while the context is fresh

| #   | Fix                                                                                                                                                                           | Where                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 13  | Refuse a negative total in `proRata`, or skip zero-weight entries in the dust loop                                                                                            | `packages/ledger-client/src/money.ts`                   |
| 14  | Widen the money property suite: allow `0n` weights, extend the allocation properties to negative totals, and assert _a zero weight receives exactly zero_                     | `packages/ledger-client/src/money.property.test.ts`     |
| 15  | Change the fill guards from `< 0n` to `<= 0n` in both `tradeFill` and `marketMakerMakerFill`                                                                                  | `packages/ledger-client/src/recipes/index.ts`           |
| 16  | Refuse a liquidation triggered only by a stored liq price when the position is in profit, and validate the stored price sits on the correct side of entry                     | `services/svc-trade/src/futures/liquidation-planner.ts` |
| 17  | Delete or finish the two orphaned uncommitted files in the main checkout (`svc-academy/src/certs/`, `svc-notify/src/required-channels.ts`) — the first breaks typecheck there | main checkout only                                      |

### The standing rule this audit would propose

Three separate gates in this repo have now been caught **reporting green while inspecting nothing** — the reachability gate on Windows (fixed), the value gate under `fetch-depth: 1` (fixed, and named as _half of how PRs #832–#876 landed_), and the two i18n gates (live today). One gate, `wallet-rpc-mainnet-scan`, already defends against this explicitly: its success line asserts _"every denominator non-zero."_

**Make that the rule for all 27: a gate that cannot state how many things it inspected is not allowed to say they were fine.**
