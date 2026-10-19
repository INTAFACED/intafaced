# ADR: what the Java dual-book neutering actually guarantees, and what it does not

**Status:** **Accepted — 2026-08-04.** Owner decision, stated and confirmed.
**Decision owner:** repo owner. **Written by:** Denon.
**Spec id:** D-S-17.
**Builds on:** [`2026-08-02-adopt-vendored-product-keep-our-ledger.md`](2026-08-02-adopt-vendored-product-keep-our-ledger.md) ("Yes for the product. No for the book."), which is unchanged. This ADR states the **residual** that decision left, because the residual has been read as smaller than it is. **See P4-07:** forever Java vs TS money SoT is sealed in [`2026-08-15-java-vs-ts-money-sot-seal.md`](2026-08-15-java-vs-ts-money-sot-seal.md) — this residual is not re-opened.

---

## The decision

> **The Java shell's balance writes are neutralised by four mechanisms of very different strength, and only two of them hold at runtime. The scan is a source gate; the deployable artifact is not built from the scanned source. Neither fact may be described as "the Java book is closed."**

The adoption ADR is correct and stays. What follows is what an honest status line for it says.

This is settled. Agents and engineers implement it; they do not re-litigate it.

**Honesty sheet (D26-P2-07):** [`JAVA-GRADE-D-JAR-TRUTH.md`](../JAVA-GRADE-D-JAR-TRUTH.md) — Grade D allowlist empty; gitignored compose jars are not the scanned source.

---

## What is actually true today

63 balance-write sites survive across 29 files. **Zero are redirected to `packages/ledger-client`.** The allowlist in `vendor-java-money-scan.mjs` is a work queue — each entry names a target recipe (`escrowLock`, `tradeFill`, `withdrawSettle`, `rewardPay`, `deposit`) and not one of those mappings has been implemented.

| Grade | Count | Held by                                                 | Holds at runtime?                                |
| ----- | ----- | ------------------------------------------------------- | ------------------------------------------------ |
| **A** | 7     | DAO `@Query` no-op `WHERE 1 = 0`; service `throw`       | **Yes.** Re-proved every scan run, no allowlist. |
| **B** | 29    | `IllegalStateException` from `MemberWalletService`      | **Yes.** The exception is real.                  |
| **C** | 12    | The HTTP 410 door interceptor only                      | **Partly.** See below.                           |
| **D** | 10    | A `= null` assignment or an unconditional `return;`     | **No. Nothing stands here.**                     |
| —     | 5     | Not balance writes; listed rather than pattern-excluded | n/a                                              |

---

## The four things this means, in the order they change the answer

### 1. The scanned source is not the running binary

Compose runs `<module>/target/<module>.jar`. Those jars are **gitignored and untracked**, built 2026-07-29. Every neutering commit landed **2026-07-31 → 2026-08-02**. The jars predate all of it, and the compose file itself records that this host "cannot do (no JDK, no mvn)" a rebuild.

So `✓ vendor-java-money-scan clean` is a true statement about source that nothing in this repo can compile into the thing that would execute. **This is the same defect class as a scan that walks zero files** — the check is real and its object is not the object that matters. Four gates were landed to close that class at the file level; this is it at the artifact level.

**Rule: no claim about Java runtime safety may cite a source scan as its evidence.** The gates prove what the source says. They prove nothing about the jar.

### 2. Ten sites are held by nothing, and four are beyond the door by construction

Grade D has no throw, no `WHERE 1=0`, no door — only a `= null` line and a static allowlist. Restore one assignment and the mint is live.

Four of those are not merely undoored but **undoorable**: `wallet:MemberConsumer:149` is a Kafka consumer; `admin:OrderEvent` and `otc-api:OrderEvent` are Spring event listeners. An HTTP interceptor cannot reach any of them, so no amount of door work fixes this. They must be **deleted**, not disabled.

### 3. The door covers less than it reads

- **`admin` has no compose service at all.** Eight of the twelve Grade C sites live there, so their 410 has never executed once. That includes `admin:MemberWalletController` — the most direct mint in the tree — and `admin:DividendController`, which credits every holder of a coin in one request and is the one Grade C site with an explicit `save()`.
- **`otc-api` is in compose but cannot boot** — three documented defects, one of them (shiro-quartz) deliberately not worked around, because "committing an unverifiable binary onto the classpath of a money service is the exact practice the adoption ADR objects to." That reasoning is right and stays.
- **The biggest seam is not HTTP.** `exchange-core:ExchangeOrderService` holds eight Grade B sites on the trading path, reached from `ExchangeTradeConsumer` over **Kafka**, from scheduled jobs, and from Spring events — never from `/order/add`. Only the service-level throw stands there.

### 4. The "four mutators" seam never covered debits

The adoption ADR names `increaseBalance`, `decreaseBalance`, `freezeBalance`, `thawBalance` as "the exact seam". **`decreaseBalance` has zero call sites.** It exists only as a DAO no-op declaration; `MemberWalletService` has no such method.

Debits were never done through a mutator. They were done as `setBalance(x.subtract(y))` on a Hibernate-managed entity, which flushes at commit — and that is the entire 27-site class PR #422 discovered. The seam was true of the **names** and false of the **coverage**, and the sentence should be read that way from here.

---

## Corrections to the record

- **Jar count is 32, not 31.** The "31" at `vendor/.gitignore:11` and in the adoption ADR is wrong; `docs/UPSTREAM-ADOPTION-QUEUE-2026-08-02.md` (removed) already carries the right figure. Eighteen sit inside `01_wallet_rpc`, including **`bitcoinj-core-0.13-alice-SNAPSHOT.jar`** — a snapshot build of an unnamed fork, on the classpath of the two modules that mint keys with `new ECKey()`.
- **`*.jar` is not marked binary** in `.gitattributes`; `git check-attr` returns `text: auto` on a wallet jar.
- **The adoption ADR's "32 call sites are all of this grade" is an overcount.** The Grade B budget is 29; 32 is reached only by including the three Grade A declarations. The new ratchet arithmetic should reconcile to 29.
- **`core` did not compile from source — CONFIRMED 2026-08-04, and it was three errors, not one.** All in `MemberApplicationService`:
  1. `promotionLevelTwo()` — `return;` followed by `if (rewardPromotionSetting != null) {`. JLS §14.21 unreachable statement.
  2. `promotion()` — `return;` followed by a `RewardPromotionSetting` declaration. Same rule.
  3. **`promotion()` declared `MemberPromotion one` twice in the same block.** JLS §6.4 duplicate local variable — a compile error regardless of reachability, and one nobody had spotted.

  Note the distinction that makes this a real error rather than a lint opinion: `if (false && …)` elsewhere in the same file is **legal**, because `if` is the one construct §14.21 exempts for conditional compilation. `return;` gets no such exemption.

  **So `core` has not compiled since the disabling campaign landed, and no jar has ever been built from the current source.** That is a stronger statement than the artifact gap above: it is not merely that the jars are stale, it is that the source they would be rebuilt from does not compile. All three are now fixed; a sweep of all 870 Java files found no fourth instance.

---

## What "done" for the Java residual requires

In order. Each step is independently landable.

1. **Delete the ten Grade D sites.** They are reward mints with no ledger equivalent built, so there is nothing to redirect them to. Deleting the mint and keeping the surrounding workflow is the honest move; a `= null` short-circuit is a booby trap for the next author. **Done (D26-P2-07):** sites deleted; `vendor-java-money-scan` Grade D band empty + ratchet; `vendor-java-jar-truth` bans the `Reward*Setting = null` re-arm shapes.
2. **Resolve the compile question.** If `core` does not build, nothing downstream is real. **Done:** `vendor-compile.yml` compiles `core` under the pinned JDK 8 / Maven 3.8 image (advisory).
3. **A reproducible build.** A source scan that cannot be tied to the artifact is a claim about a file, not a system. Until a jar can be built from scanned source in CI, the runtime posture is unverified — say so rather than implying otherwise. **Path real (D26-P2-07):** `pnpm vendor-java:rebuild` (`tooling/scripts/vendor-java-rebuild.mjs`) + `vendor-compile.yml` `package-compose-jars` job; `vendor-java-jar-truth` refuses overclaims and stale jars. Absent jars remain the honest "runtime UNVERIFIED" state — not a green safety tick.
4. **Move the Grade C twelve off the door.** A door on a module with no compose service is not a control. Either give `admin` the same service-level throw the mutators have, or delete the sites.
5. **Implement the queue.** Thirty-six sites currently throw. Each `Queue:` target is a real recipe; a throw is a holding position, not an outcome.

---

## A stale instruction in a live law document

`DIRECTION-2026-07-31.md` (removed) §4 made this decision ("**DECIDED. Option B**") and named two enforcement gaps that must close with it. The first reads:

> "**`custody-scan` walks `.ts`/`.tsx` only — it has never read a line of Java.** Fix it, or this decision is unenforced."

**That instruction was half-wrong.** Bolting the dual-book call-site ratchet onto the Protocol Plane checks extends the wrong gate — that work stays in `vendor-java-money-scan`. **D26-P2-08** (2026-08-09 board) corrects the other half: `custody-scan` must still **open** the Java **runtime risk surface** (money-plane `src/main` + committed classpath jars), fail-closed, so `pnpm scan:custody` cannot print clean while blind to vendor money Java. §4's second gap (invert `vendor-shell-scan`) was real and is closed.

---

## Standing rules

- **`custody-scan` walks the Java runtime risk surface (D26-P2-08).** Supersedes the 2026-08-04 "do not extend" line below's original intent: do **not** bolt the dual-book call-site ratchet onto the Protocol Plane checks — that stays in `vendor-java-money-scan`. Do **extend** `custody-scan` so its scan object includes money-plane `src/main/java` + committed classpath jars, fail-closed. The stale DIRECTION §4 instruction to "fix it" without that object distinction remains wrong; D26-P2-08 is the corrected shape.
- **The ratchet freezes by per-file, per-rule count**, keyed on `module:file` — `rules: { 'jpa-entity-balance-mutation': N }`. That is the scan's own documented convention and it is what implementers follow. It is deliberately **not** a global count, which would be near-useless.
  - **Its one residual weakness, stated rather than hidden:** within a single file and a single rule, removing one site and adding another passes. The blast radius is one file and one rule, which is small — but it is not zero, and a future tightening to exact matched text would close it. Do not describe the current ratchet as text-exact; it is not.
- **A gate whose walk can be empty must fail loudly.** Applies to every scan in `tooling/ci/`, and is the reason `custody-scan` exits 1 on an empty derivation rather than printing a tick.
- **Do not add a jar to make something boot.** Stated once for `otc-api`; it holds generally.

---

## What agents may implement without asking again

- Deleting Grade D sites and tightening the ratchet accordingly.
- Adding a service-level throw where only a door stands.
- Implementing any queued recipe redirect, to the money law.
- Correcting the jar count, `.gitattributes`, and the ratchet arithmetic.

## What still needs the owner

- Running `01_wallet_rpc` against real value — untouched, owner-gated, and the security review of that tree is commissioned to nobody, sized XL, and unstarted.
- Any decision to vendor a prebuilt jar.
- Retiring the vendored shell, or committing to rebuild its jars in CI.
