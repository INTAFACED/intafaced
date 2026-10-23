# SPEC — EIP-155 chain id on the wallet RPC withdrawal signing path

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

> **STATUS: APPLIED on `fix/wallet-rpc-eip155`.** Both call sites now pass a
> configured chain id, the chain id has no default, a ceiling guard refuses what the
> library cannot express, and fourteen known-answer fixture tests pass against a real
> JDK 8 + Maven build. §3 — the question this document said had to be answered before
> any code was written — has been answered **from the jar**, and the answer changed
> the design. See **§3.1**.
>
> The original status line read _"SPECIFIED, NOT APPLIED… there is no JDK, JRE or
> Maven on the host."_ That constraint is gone. What has **not** changed is §7: this
> tree is still barred from live value pending the §A4 review, and nothing in this
> repository can build, containerise or boot any module of it — still enforced by
> rules M5–M7, and still true after this change, because the toolchain used to verify
> it lives outside the repository and no build step was added to CI.

**Raised by:** `fix/wallet-rpc-criticals`, which fixed the other two `01_wallet_rpc`
criticals and deliberately left this one alone.
**Applied by:** `fix/wallet-rpc-eip155`.
**Companion:** [`OWNER-ACTIONS-WALLET-RPC-SECRETS.md`](OWNER-ACTIONS-WALLET-RPC-SECRETS.md) §A4 ·
[`A1.4-WALLET-SECRETS-PERIMETER-2026-07-30.md`](A1.4-WALLET-SECRETS-PERIMETER-2026-07-30.md)
**Enforced by:** `tooling/ci/wallet-rpc-mainnet-scan.mjs` — rule M3's frozen entry is now
**deleted**, because the finding is gone; M8 gains one entry for the fixture recipient.
Rule M3 itself is untouched and keeps its proof-of-life from `RULE_PROBES`.

---

## 1. The defect

Both ETH-family withdrawal paths sign with the two-argument form of web3j's
transaction encoder:

| Where                                           | Method          | Moves                                              |
| ----------------------------------------------- | --------------- | -------------------------------------------------- |
| `eth-support/…/service/PaymentHandler.java:158` | `transferEth`   | native ETH                                         |
| `eth-support/…/service/PaymentHandler.java:193` | `transferToken` | any ERC-20, incl. the module's configured contract |

```java
byte[] signedMessage = TransactionEncoder.signMessage(rawTransaction, payment.getCredentials());
```

That overload takes **no chain id**. It is the pre-EIP-155 encoding, and the
signature it produces is valid on **every EVM chain at once** — Ethereum mainnet
included, whatever `coin.rpc` points at.

The consequence is the one that matters for containment, and it survives the
other two fixes on this branch:

> A withdrawal signed against a testnet node is **also a valid mainnet
> transaction**. Anyone who observes it — a node operator, a mempool watcher,
> anyone who can read the testnet — can replay those exact bytes onto mainnet
> and it will execute, from the same account, for the same amount, to the same
> destination.

Deleting the second Etherscan broadcast (done on this branch) removed the path
that broadcast the mainnet copy _for_ you. It did not make the signature
chain-specific. **"Point it at a testnet" is still not a containment strategy for
this tree.**

### Blast radius

`eth-support` is a library, not a service. Its `pom.xml` is a dependency of three
bootable modules, and both signing call sites are on the shared path:

- `eth` — native ETH withdrawals
- `erc-token`
- `erc-eusdt` — the module whose contract pin was the third critical

One fix in one file covers all three. That is also why a mistake in it costs
three modules.

---

## 2. Why this was not applied in the same branch as the other two

> Historical. The reasoning below is why the fix waited; it is preserved because
> it is also the standard the applied change had to meet. It did: a compiler, a
> known-answer fixture from outside this codebase, and a mutation proof that the
> fixture is not vacuous. §6 records each item against what was actually run.

The other two criticals were a **deletion** and a **configuration value**.
Neither can change the bytes of a signed transaction:

- removing a second, redundant broadcast of already-signed bytes cannot alter how
  those bytes were produced;
- replacing a literal in a `.properties` file with an unresolved `${…}` placeholder
  removes a value, and the service refuses to start rather than using a different one.

This one is different in kind. **Adding a chain id changes what gets hashed and
therefore what gets signed.** EIP-155 changes the RLP payload the signature is
computed over and folds the chain id into `v`. Get it wrong and you do not get a
compile error or a test failure — you get a transaction that a node rejects as
malformed, or worse, one that is silently signed for a chain nobody meant.

On a withdrawal path, applying that without a compiler, without a single test,
and without a known-answer fixture, is exactly the class of change that looks
obviously right in review and strands money. **The correct action with no
toolchain is to specify it precisely and stop.** That is what follows.

---

## 3. MUST VERIFY FIRST — the chain-id parameter width

This reactor pins **web3j 3.3.1** (`01_wallet_rpc/pom.xml`, `org.web3j:core`).

In the web3j 3.x line the EIP-155 overload is believed to be:

```java
TransactionEncoder.signMessage(RawTransaction, byte chainId, Credentials)
```

— that is, the chain id is a **`byte`**, not a `long`. If that is correct, it is
decisive and it is the reason this document leads with it:

- a signed Java `byte` is `-128..127`;
- **Ethereum mainnet is chain id 1** — expressible;
- **Sepolia is 11155111** — NOT expressible;
- **Holesky is 17000, Polygon 137, Arbitrum 42161** — none expressible.

If that signature is what the resolved jar carries, then "add a chain id" cannot
be implemented for most of the chains anyone would actually want to contain this
tree on, and the real work order is **upgrade web3j first** (the parameter widened
to `long` in the 4.x line) — a dependency bump on unreviewed, unbuilt,
custody-holding third-party code, which is a much larger change than this one and
needs its own review.

**Verify before writing any code**, with a toolchain:

```bash
mvn -q dependency:copy-dependencies -DincludeArtifactIds=core
javap -classpath target/dependency/core-3.3.1.jar org.web3j.crypto.TransactionEncoder
javap -classpath target/dependency/core-3.3.1.jar org.web3j.tx.ChainId
```

Record the actual signature in this document before proceeding. Do not take the
paragraph above as established — it is knowledge of the library, not an
observation of the jar, and this repository has no way to check it.

## 3.1 ANSWERED — from the jar. The parameter is a `byte`; the conclusion drawn from that was wrong

**`byte` is confirmed.** `javap` against the resolved `org.web3j:crypto:3.3.1`:

```
public class org.web3j.crypto.TransactionEncoder {
  public static byte[] signMessage(org.web3j.crypto.RawTransaction, org.web3j.crypto.Credentials);
  public static byte[] signMessage(org.web3j.crypto.RawTransaction, byte, org.web3j.crypto.Credentials);
  public static org.web3j.crypto.Sign$SignatureData createEip155SignatureData(org.web3j.crypto.Sign$SignatureData, byte);
  public static byte[] encode(org.web3j.crypto.RawTransaction);
  public static byte[] encode(org.web3j.crypto.RawTransaction, byte);
}
```

and the `v` arithmetic, disassembled — note the `i2b` truncating the **result**:

```
public static Sign$SignatureData createEip155SignatureData(Sign$SignatureData, byte);
   0: aload_0
   1: invokevirtual  // Sign$SignatureData.getV:()B
   4: iload_1        // chainId
   5: iconst_1
   6: ishl           // chainId << 1
   7: iadd
   8: bipush 8
  10: iadd           // getV() + (chainId << 1) + 8
  11: i2b            // ← truncated to a byte, on the RESULT
```

Also observed, and **not** what §5 assumes: on this version `ChainId.NONE` is `-1`,
not `0`.

```
public class org.web3j.tx.ChainId {
  public static final byte NONE = -1;
  public static final byte MAINNET = 1;
  ...
  public static final byte ETHEREUM_CLASSIC_MAINNET = 61;
}
```

(web3j 3.3.1 ships named constants — 61, 62 — that are worth noticing, because a
signed byte cannot hold `2*61+35 = 157`. They still work. That is the clue to the
next paragraph.)

### The conclusion the `byte` finding invites is wrong, and it is wrong in the unsafe direction

The natural reading — signed byte, so `v = 2*chainId + 35|36` must stay ≤ 127, so
chain ids above ~45 are unusable — **does not hold**, and believing it would have
produced a guard that refuses chains this library signs perfectly well.

The truncated byte is never read as a signed Java value. `TransactionEncoder`
hands `SignatureData.getV()` straight to `RlpString.create(byte)`, which is:

```
public static org.web3j.rlp.RlpString create(byte);
   4: iconst_1
   5: newarray byte
   9: iload_0
  10: bastore        // the raw byte, into a 1-element array. No sign handling.
```

RLP is a byte encoding and a node reads those bytes **unsigned**. So `v = 128`
truncates to the Java byte `-128`, is stored as `0x80`, and is read back by
every node on earth as `128` — which is correct. Two's complement round-trips.

The real ceiling is therefore where the true `v` stops fitting in eight bits **at
all**:

| chain id | v (recovery id 0) | v (recovery id 1) | web3j          |
| -------- | ----------------- | ----------------- | -------------- |
| 45       | 125               | 126               | correct        |
| 46       | 127               | 128 → `0x80`      | **correct**    |
| 56 (BSC) | 147               | 148 → `0x94`      | **correct**    |
| 109      | 253               | 254 → `0xfe`      | correct        |
| **110**  | 255               | **256 → `0x00`**  | **half wrong** |
| 111+     | 257               | 258               | always wrong   |

**Measured, not reasoned.** Chain ids 1–300 × four private keys (1200 signatures)
were signed with this exact jar and compared byte-for-byte against
[viem](https://viem.sh) 2.55.8:

- **1–109: all 1200/1200 match, every key.**
- **110: 3 of 4 keys match.** The fourth signs with recovery id 1 and web3j emits
  `…80` `00` where the correct encoding is `…80` `820100`. `r` and `s` are
  identical and correct; only `v` is destroyed. A node cannot recover the sender
  from `v = 0`, so the withdrawal is **malformed**, not merely misrouted.
- **111 and above: none match.**

Which half you get at 110 is decided by the signature nonce, not by anything an
operator controls, so it would fail on roughly every other withdrawal.

### What this changes about the work order

- **The ceiling is 109, not 45.** `PaymentHandler.MAX_EIP155_CHAIN_ID = 109L`.
- **BSC (chain id 56) IS reachable** on web3j 3.3.1. The §3 claim that "add a
  chain id cannot be implemented for most of the chains anyone would actually
  want" is too pessimistic: mainnet 1, Ropsten 3, Rinkeby 4, Kovan 42, BSC 56 and
  every id up to 109 are all expressible and correct.
- **Polygon 137, Holesky 17000, Arbitrum 42161 and Sepolia 11155111 remain
  unreachable**, and no cast fixes them. Reaching those needs the web3j upgrade,
  which is still its own change on unreviewed custody code.
- **The `byte` range check in §5 (`id > Byte.MAX_VALUE`) is wrong twice over**: it
  would reject 109 (fine) and it derives its bound from the wrong quantity. The
  bound is on `v`, not on the chain id.

Reproduce:

```bash
JAVA_HOME=<jdk8> mvn -pl eth-support -am test   # from vendor/upstream-exchange/01_wallet_rpc
```

---

## 4. The chain-id source

**It must be configuration, and it must have no default.**

Not a constant, not `1`, not "mainnet because that is what it does today". A
default of `1` would be mainnet-by-omission, which is the precise failure this
whole perimeter exists to prevent: a service that reaches mainnet because nobody
set a variable.

This matches what the auth/secrets work already established across all 13
property files — an unresolved `${…}` placeholder makes the service **fail to
start**, and a service that does not boot is strictly better than one that boots
pointed at the wrong chain.

**Add to `Coin` (`rpc-common/…/entity/Coin.java`, a lombok `@Data` bean bound by
`@ConfigurationProperties(prefix = "coin")` in `rpc-common/…/config/CoinConfig.java`):**

```java
    /**
     * EIP-155 chain id. NO DEFAULT: an unset value must stop the service, not
     * silently select a chain. See docs/SPEC-EIP155-WALLET-RPC-WITHDRAWAL-SIGNING.md.
     */
    private Long chainId;
```

Note the type is `Long` here and not `byte` regardless of what §3 finds — the
config should carry the true value, and any narrowing belongs at the call site
where it can be range-checked and rejected loudly.

`Coin` is **shared** by every module in the tree via `rpc-common`, so this field
appears on modules that have no use for it (`bch`, `ltc`, `xmr`, …). That is
harmless — those modules also carry their own `Coin.java` copies — but it should
be stated in the PR rather than discovered.

**And to `eth`, `erc-token` and `erc-eusdt` `application.properties`:**

```properties
# EIP-155 chain id. Environment only, no default: an unset value must stop the
# service rather than let it sign a transaction that is valid on every chain.
coin.chain-id=${ETH_CHAIN_ID}
```

plus a commented `# ETH_CHAIN_ID=` entry in `.env.example` under the
`01_wallet_rpc` block, alongside the existing wallet variables.

---

## 5. The exact diff

> **SUPERSEDED IN ONE RESPECT — read §3.1 first.** The shape below is what was
> implemented (three-argument overload at both call sites, one private helper, no
> default, refuse rather than truncate) and it is correct. The **bound** is not:
> the helper below rejects anything above `Byte.MAX_VALUE`, which is the wrong
> quantity. The limit is on `v`, not on the chain id, and it is **109**. The
> implemented helper is `PaymentHandler.eip155ChainId`, is `static` and
> package-private so the fixture tests can call it without a Spring context, and
> is invoked from a `@PostConstruct` as well as from every signature — so a
> missing or unusable chain id stops the service at boot rather than at the first
> withdrawal.

Assuming §3 confirms the `byte` parameter. **Both hunks are in the `eth-support`
module, `src/main/java/…/wallet/service/PaymentHandler.java`** — the package
segment is elided because the vendor's identity may not be written into this
repo's own source (Doctrine §0.7), which is also why the mainnet gate keys its
baseline by module and file basename rather than by path.

A range check is included deliberately: with a `byte` parameter, a chain id of
`137` silently truncates to `-119`, which is a _different chain id_ and a
perfectly valid signature for nothing. It must throw, not truncate.

```diff
@@ transferEth(Payment payment)
-            byte[] signedMessage = TransactionEncoder.signMessage(rawTransaction, payment.getCredentials());
+            byte[] signedMessage = TransactionEncoder.signMessage(rawTransaction, chainIdByte(), payment.getCredentials());

@@ transferToken(Payment payment)
-            byte[] signedMessage = TransactionEncoder.signMessage(rawTransaction, payment.getCredentials());
+            byte[] signedMessage = TransactionEncoder.signMessage(rawTransaction, chainIdByte(), payment.getCredentials());

@@ new private helper on PaymentHandler
+    /**
+     * The configured EIP-155 chain id, narrowed to the width web3j 3.3.1 accepts.
+     *
+     * Fails loudly in both directions rather than guessing. An unset chain id is
+     * a configuration error, and a chain id that does not fit in a signed byte is
+     * a library limitation the operator has to know about — truncating it would
+     * produce a valid signature for a chain nobody chose.
+     */
+    private byte chainIdByte() {
+        Long id = coin.getChainId();
+        if (id == null) {
+            throw new IllegalStateException(
+                "coin.chain-id is not set. Refusing to sign: the two-argument signMessage is pre-EIP-155 "
+                    + "and produces a transaction that is replay-valid on every EVM chain, mainnet included.");
+        }
+        if (id < 1 || id > Byte.MAX_VALUE) {
+            throw new IllegalStateException(
+                "coin.chain-id=" + id + " does not fit the byte-width chain id of web3j 3.3.1. "
+                    + "Upgrade web3j before targeting this chain - see docs/SPEC-EIP155-WALLET-RPC-WITHDRAWAL-SIGNING.md.");
+        }
+        return id.byteValue();
+    }
```

`coin` is already an `@Autowired` field on `PaymentHandler`, so no new injection
is needed.

**If §3 instead finds a `long` parameter** (i.e. the resolved jar is not what is
assumed), the helper collapses to a null check and the range check is dropped —
but the null check stays, because "no chain id configured" must never mean
"sign for chain 0", which is `ChainId.NONE` and is exactly the defect being fixed.

### What must NOT be written

```java
// WRONG. Compiles, passes the gate's old arity rule, and changes nothing:
TransactionEncoder.signMessage(rawTransaction, ChainId.NONE, payment.getCredentials());
```

`ChainId.NONE` is web3j's literal "no chain id" sentinel (`0`). The three-argument
call with `NONE` produces a **byte-identical** pre-EIP-155 signature. This is the
most likely wrong fix, because it is the named constant already on the classpath
and it makes the call _look_ remediated.

Rule M3 of `wallet-rpc-mainnet-scan.mjs` was widened on this branch to catch it,
along with the two-argument `RawTransactionManager` and `Transfer.sendFunds`,
both of which sign chain-id-less on web3j 3.x without the word `signMessage`
appearing anywhere. All are mutation-proved.

---

## 6. What must be true before this is trusted

None of this is optional, and none of it can be done here.
**Status of each item is recorded inline. Items 1–4 and 6 are DONE; item 5 is NOT.**

1. **It compiles.** ✅ `mvn -pl eth,erc-token,erc-eusdt,eth-support -am test`
   against JDK 8 (Temurin 1.8.0_502) and Maven 3.9.9 — `BUILD SUCCESS`, all
   three bootable ETH-family modules and the shared library.
   The reactor blocker was real and is fixed: `01_wallet_rpc/pom.xml` declared
   `<module>xrp</module>` for a directory that is not on disk. Maven resolves
   `<modules>` at POM-read time, so the reactor failed before any goal ran and
   even `-pl eth-support -am` could not get past it. **Nothing in this repository
   could build any module of this tree while that line stood** — that one line is
   why this spec sat unapplied. It is removed, with a comment saying so.
2. **§3 is answered from the jar**, not from memory, and this document is updated
   with the observed signature. ✅ See **§3.1** — and note that the answer
   contradicted the conclusion §3 drew from it. The parameter is a `byte`; the
   usable ceiling is 109, not 45, because RLP reads the truncated byte unsigned.
3. **A known-answer signed-transaction fixture test exists and passes.** ✅
   `eth-support/src/test/java/…/service/PaymentHandlerEip155Test.java`, 14 tests,
   `Tests run: 14, Failures: 0, Errors: 0, Skipped: 0`.

   - fixed private key `0x4646…46`, nonce 9, gasPrice 20 gwei, gasLimit 21000,
     recipient `0x3535…35`, value 1 ether — the inputs from EIP-155's own worked
     example; ✅
   - signed through the production path (`PaymentHandler.signToHex`) at chain ids
     1, 56 and 109, on **both** the ether and the ERC-20 `transfer()` shapes; ✅
   - asserted against vectors produced **independently by viem 2.55.8**, and the
     chain-id-1 ether case is byte-identical to the signed transaction **published
     in EIP-155 itself** — so the anchor is a specification constant, not a
     recording of any implementation; ✅
   - `v` asserted directly as `2*chainId + 35 | 36`; ✅
   - the pre-EIP-155 output is pinned as a literal and asserted **not** equal, and
     `r` is asserted to differ too, so a "fix" that only rewrote `v` while still
     hashing the old payload fails. ✅

   The old two-argument overload is **not called** to produce that comparison
   — it is banned in this tree by gate rule M3, and a test is not an exemption
   from a ban whose subject is this file. The expected value is a frozen literal.

   **Mutation-proved** rather than assumed to be meaningful. Three mutations were
   applied to the fix and the suite went red on each:

   | mutation                                       | result         |
   | ---------------------------------------------- | -------------- |
   | restore the two-argument `signMessage`         | 7 of 14 fail   |
   | raise `MAX_EIP155_CHAIN_ID` from 109 to 110    | 2 of 14 fail   |
   | drop the null check, default the chain id to 1 | 1 of 14 errors |

4. **A negative test**: with `coin.chain-id` unset, `transferEth` and
   `transferToken` throw and no transaction is broadcast. Not "logs a warning". ✅
   Both paths sign through the same `signToHex`, which calls the guard before
   `TransactionEncoder`, so the throw happens before any bytes exist and long
   before `ethSendRawTransaction`. Unset, `0`, `-1` and everything above 109 are
   all covered, including Polygon 137, Holesky 17000, Arbitrum 42161 and Sepolia
   11155111 by name. **Stronger than specified:** `@PostConstruct
requireEip155ChainId()` runs the same guard at bean construction, so the
   service does not start at all — the failure is an outage, not a failed
   withdrawal.
   `ceilingPlusOneIsNotConservatism_theLibraryReallyTruncatesV` additionally
   proves the ceiling is a measurement: it bypasses the guard, signs at 110 with
   a key that lands on recovery id 1, and asserts web3j emits `v = 0`.
5. **A replay test, if a devnet is available**: ❌ **NOT DONE.** There is no
   devnet on this host and nothing in this repository may boot a module of this
   tree (M5–M7). The property is inferred from the encoding — a chain id is in
   the signed payload and in `v`, so a node on a different chain rejects it —
   which is what EIP-155 says, not what was observed here. **This is the one item
   on this list that remains unverified.**
6. **The gate stays green.** ✅ `pnpm gates` passes, 14/14. The M3 frozen entry is
   **deleted in this commit**, replaced by a comment recording what it said and
   why it is gone. One M8 entry is **added** for the fixture recipient
   `0x3535…35`: `src/test` is walked like any other source in this tree, and a
   known-answer test whose inputs can be edited is not a known-answer test, so
   freezing it is the point rather than a concession.

---

## 7. Priority, in context

This is **not** the most urgent item on this tree, and it should not jump the queue
ahead of the review §A4 requires.

Nothing in this repository can build, containerise, compose or boot any module of
`01_wallet_rpc` — that is an enforced invariant (rules M5, M6 and M7), not an
accident, and it is asserted on every CI run. So this defect is **latent**: it is
a property of code that nothing here can execute. The order is:

1. the security review the vendored-exchange ADR makes a precondition of adoption;
   — ✅ done, `docs/security/WALLET-RPC-SECURITY-REVIEW-2026-08-05.md`;
2. a JDK and a working reactor build; — ✅ done (see §6.1);
3. this fix, with the fixture tests above; — ✅ done;
4. only then, any question of deployment. — **NOT DONE, and not requested.**

Applying step 3 before step 2 is what this document exists to prevent. It did not
happen: step 2 came first, and the answer it produced (§3.1) changed step 3.

**Step 4 is untouched and the bar is unmoved.** This fix makes a withdrawal from
this tree chain-specific. It does not address F1, F2, F3, F5, F8, F9 or F12 of the
security review — two services still print a live spending credential to stdout on
an ordinary success path, and this branch deliberately did not go near key
generation, key storage or `RpcSecurityConfig`. A chain-id fix is not an adoption
signal. Rules M5–M7 still hold and are asserted on every CI run.
