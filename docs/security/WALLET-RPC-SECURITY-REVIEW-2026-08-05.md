# Security review — `vendor/upstream-exchange/01_wallet_rpc`

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Date:** 2026-08-05
**Scope:** the vendored wallet RPC tree, 16 module directories, 228 tracked `.java` files, 13 `.properties`, 18 committed `.jar` binaries.
**Method:** static reading only. Nothing in this review was compiled, executed, or tested.
**Status of the tree:** unreviewed until this document. This document is that review.

This is the read that `docs/UPSTREAM-ADOPTION-QUEUE-2026-08-02.md (removed):1488` (removed) deferred when it said _"It is not a security review and must not be cited as one. 215 files were not read line by line."_ It is the precondition of adoption that the [vendored-exchange ADR](../adr/2026-07-28-vendored-exchange-integration.md) requires, and that [`OWNER-ACTIONS-WALLET-RPC-SECRETS.md` §A4](../OWNER-ACTIONS-WALLET-RPC-SECRETS.md) records as not having happened.

**Verdict up front:** this tree must not be pointed at real value in its current state, and the reason is not the three findings that were already known. It is that **three of its thirteen bootable services print a live spending credential to stdout on an ordinary success path**, and one of the three prints an Ethereum private key. Those are not configuration mistakes; they are code. See [Verdict](#6-verdict).

> **Amended 2026-08-06.** As first published this sentence read _"**two** … and a third **almost certainly** prints an Ethereum private key"_, because [F3](#f3) rested on an accessor chain in a library this host could not open. That library has now been read on this host, without a JVM, and the chain is exactly what the review inferred. The hedge is gone and the count moved from two to three. The evidence is in the [F3 follow-up of 2026-08-06](#f3-2026-08-06) — whose one remaining caveat, the jar's provenance, was **closed against Maven Central later the same day** ([§8.3](#83-what-leaned-on-it)).

---

## 1. Scope and method

### 1.1 What was read

Every `.java` file under `vendor/upstream-exchange/01_wallet_rpc`, every `pom.xml`, every `application.properties`, and the file listing and reference graph of every committed `.jar`.

The six bitcoinj-family modules (`bch`, `bsv`, `ltc`, `btm`, `eos`, `xmr`) are near-identical clones. `bch` was read in full and the other five were diffed against it, with every differing region read in full. That is stated here so the claim "228 files read" is not mistaken for 228 independent readings — roughly 90 of those files are byte-identical copies of about 20 distinct files.

### 1.2 What could **not** be done, and why

**There is no JDK, JRE, or Maven on this host.** Nothing here was compiled, run, unit-tested, fuzzed, or dynamically observed. Every finding in this document is a static-analysis finding and is marked as such. Specifically, this review could not:

> **Correction, 2026-08-06 — the "Reach the network" row below is false**, and three other rows leaned on it. This host has working DNS and TCP/443, and Maven Central answers queries and serves artifact bytes. Everything justified by "there is no network" is re-examined in [§8](#8-correction--this-host-has-network-access). The compilation clause above is **unchanged and still true**: no JDK and no Maven has been on `PATH` in any session that wrote to this document, and nothing here has been compiled or executed. _"Could not reach the artifact"_ is wrong; _"did not compile anything"_ was and remains right.

| Not done                         | Consequence for this review                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compile any module               | Cannot confirm the tree even builds. It almost certainly does not — see [F21](#f21).                                                                                                                                                                                                                                                                                            |
| Run `mvn dependency:tree`        | The transitive dependency set, and therefore the CVE surface and the gadget classes available to a deserialisation attack, is **unknown**. Only directly declared versions are reported here.                                                                                                                                                                                   |
| Resolve any Maven coordinate     | ~~Cannot confirm that `cash.bitcoinj:bitcoinj-core:0.14.5.2`, `org.web3j:core:3.3.1` or any other declared dependency resolves to a public artifact, nor what its checksum is.~~ **Superseded 2026-08-06** — four coordinates were queried against Maven Central, and three of the answers change what this document can say. [§8.3](#83-what-leaned-on-it).                    |
| Open `org.web3j:core:3.3.1`      | ~~The `Credentials` / `ECKeyPair` accessor chain that [F3](#f3) depends on was reasoned about from the library's published API, not read.~~ **Superseded 2026-08-06** — `org.web3j:crypto:3.3.1`, which is where those two classes actually live, was found on this host and read; its checksum was then matched against Maven Central. See the [F3 follow-up](#f3-2026-08-06). |
| Execute a fastjson serialisation | [F4](#f4) depends on fastjson's `JavaBeanSerializer` walking public getters. That is fastjson's documented behaviour, not an observation. (Since resolved by a bytecode read — see the [F3](#f3) follow-up.)                                                                                                                                                                    |
| ~~Reach the network~~            | **FALSE. See [§8](#8-correction--this-host-has-network-access).** DNS and TCP/443 complete to Adoptium, GitHub and Maven Central. Jar checksums _can_ be checked against Central — one now has been — and balances _can_ be checked at any address named here. That the original review did not do these things is a different statement from their having been impossible.     |
| Read the deployed environment    | Every `${VAR}` placeholder's actual value is unknown. Whether one `WALLET_RPC_AUTH_TOKEN` is shared across all thirteen services — which decides the blast radius of [F5](#f5) — cannot be answered from the tree.                                                                                                                                                              |
| Read downstream consumers        | Whether re-emitted deposit events double-credit ([F17](#f17)) depends on a Kafka consumer outside this tree that was not reviewed.                                                                                                                                                                                                                                              |

Where a finding rests on an inference rather than a read, the inference is named at the finding.

### 1.3 Live vs latent

Nothing in this tree runs today. There is **no Dockerfile anywhere in it, no compose service that references it, no CI job that builds it, and no shell script that starts it** — independently confirmed for this review, and now enforced by rules M5–M7 of `tooling/ci/wallet-rpc-mainnet-scan.mjs` (PR #763). So in the strictest sense every finding here is unreachable.

That reading is useless for a custody decision, so this review uses a narrower axis:

- **LIVE** — reachable on an ordinary code path the first time somebody supplies the environment variables and starts the service. The absence of a Dockerfile is one commit away from not being true, and the placeholders that stop a service from starting decide _whether_ it starts, not what it does once it has.
- **LATENT** — real code that is still not reachable when the service runs: dead methods with no callers, commented-out branches, paths masked by a mangled constant, or `main()` harnesses that no runtime invokes.

"LIVE" in this document therefore means _live the moment anyone deploys this tree_, which is exactly the decision this review exists to inform.

### 1.4 Ranking

Findings are ranked by **what an attacker gains**, not by CVSS. A finding that hands over a spending key outranks a finding with a higher nominal score that yields an error message.

**On the numbers, after the 2026-08-06 amendment.** `F1`…`F21` are stable anchors — four other documents and one CI gate cite them by number — so they were **not** renumbered when [F3](#f3) was confirmed and moved to the top of the ranking. The table below is therefore in anchor order, not rank order, in exactly one place: **F3 now outranks F1 and F2.** The reason is stated at [F3](#f3-rank) and is worth one line here, because it is the only ranking argument in this document that does not follow from blast radius alone — **a leaked node credential can be rotated and a leaked withdrawal secret can be rotated, but a leaked private key cannot.** It _is_ the account. The only remedy is to sweep the funds to a new key, and until that is done every past reader of the log can spend.

---

## 2. Findings

### Summary table

| #           | Finding                                                                     | Live?                        | An attacker gains                                                   |
| ----------- | --------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------- |
| [F3](#f3)   | **ETH hot-wallet private key written to the log every 30 s** _(rank 1)_     | LIVE                         | The ETH and ERC-20 hot wallet, from log-read access, unrotatably    |
| [F1](#f1)   | ECT withdrawal signing secret printed to stdout on every withdrawal         | LIVE                         | The entire ECT hot wallet, from log-read access                     |
| [F2](#f2)   | Node RPC credentials logged at INFO on startup (3 modules)                  | LIVE                         | Full spend authority over the BTC / Omni-USDT / ACT nodes           |
| [F4](#f4)   | Chain-id-less signing + unconditional second broadcast to mainnet Etherscan | LIVE                         | Withdrawals land on mainnet regardless of which node signed them    |
| [F5](#f5)   | Every value-moving endpoint is an HTTP GET behind one shared static token   | LIVE                         | The whole float, in one request, to any address                     |
| [F6](#f6)   | Deposits credited without checking transaction success                      | LIVE (eth) / LATENT (erc-\*) | Credit for transfers that never happened                            |
| [F7](#f7)   | No function-selector check in the token deposit watcher                     | LATENT                       | Credit for an `approve()` that moves nothing                        |
| [F8](#f8)   | Trust-all TLS feeding fastjson 1.2.31 in six key-handling services          | LIVE                         | Code execution in a process holding private keys                    |
| [F9](#f9)   | Unencrypted bitcoinj wallet, plus a race that silently destroys keys        | LIVE                         | Permanently unspendable customer deposits                           |
| [F10](#f10) | `act` cannot be shown to have the auth guard; the gate is version-blind     | LIVE                         | Unauthenticated `/rpc/**` on one service                            |
| [F11](#f11) | Depositor chooses which user account gets credited                          | LIVE (eos) / LATENT (xmr)    | Misattributed credit; no existence check on the target              |
| [F12](#f12) | `walletpassphrase` / `walletlock` are dead code across the tree             | LIVE                         | Node RPC reachability equals unlimited spend authority              |
| [F13](#f13) | Live mainnet Tether contract pinned, unmangled                              | LIVE                         | (known) The module addresses real USDT                              |
| [F14](#f14) | Service-registry beacon to a routable third-party IP                        | LIVE                         | The location of every process holding withdrawal keys               |
| [F15](#f15) | Raw node and exception text echoed to HTTP callers                          | LIVE                         | Node internals, RPC parameters, filesystem paths                    |
| [F16](#f16) | `erc-token` and `erc-eusdt` collide on port, coin name and collection       | LIVE                         | Address-book confusion between two contracts                        |
| [F17](#f17) | Unbounded block-replay endpoint re-emits deposit events                     | LIVE                         | Deposit-event flood; double-credit if consumers are not idempotent  |
| [F18](#f18) | Shared static HTTP client and response across threads                       | LIVE                         | Cross-request response confusion in a wallet service                |
| [F19](#f19) | Committed node credentials in `main()` harnesses                            | LATENT                       | Two disclosed node credentials                                      |
| [F20](#f20) | Locally rebuilt, unreferenced 1.4 MB crypto library                         | LATENT                       | An unverifiable binary one config line from the key-minting path    |
| [F21](#f21) | This tree has never been compiled by anyone                                 | LIVE                         | Nothing — it is why every judgement here is unchecked by a compiler |

---

<a id="f1"></a>

### F1 — The ECT withdrawal signing secret is printed to stdout on every withdrawal · **LIVE**

**Where:** `vendor/upstream-exchange/01_wallet_rpc/ect/src/main/java/…/component/EctApi.java:129` and `:141`

```java
126:    public String sendFrom(String privatekey, String from, String to, BigDecimal amount, String remark){
128:            JSONObject request = new JSONObject();
129:            request.put("secret", privatekey);
...
140:            request.put("payment", payment);
141:            System.out.println(request.toJSONString());
142:            HttpResponse<String> response = Unirest.post(host + "/accounts/payments/"+from+"?submit=true")
```

Line 129 puts the withdrawal signing secret into `request`. Line 141 serialises `request` — the whole object, secret included — and writes it to standard output. This happens on the success path of every single withdrawal, before the request is sent.

**Reached from:** `ect/.../controller/WalletController.java:47` — `ectApi.sendFrom(coin.getWithdrawWallet(), ...)`, where `coin.withdrawWallet` is bound from `ect/src/main/resources/application.properties:28` — `coin.withdraw-wallet=${ECT_WITHDRAW_WALLET_SECRET}`. This is item **A1** of `OWNER-ACTIONS-WALLET-RPC-SECRETS.md`, the secret that document tells the owner to rotate first.

**What an attacker gains:** everything at `coin.withdraw-address`. Not by breaking anything — by reading a log. In a container deployment, stdout is the log pipeline: `docker logs`, journald, whatever aggregator is attached, and every copy and backup of it. The guard that was built for this secret (`EctWithdrawSecretConfig`, which refuses to boot on a blank or known-disclosed value) protects _provisioning_. It does not protect the value once the process is running, and this line hands out the replacement secret exactly as freely as the old one.

**Adjacent, same file, same shape:** `EctApi.java:88` — `System.out.println(response.getBody())` inside `getNewWallet()`, whose response body _is_ a freshly minted address **and its secret**. That method has no caller in this tree, so it is latent — but the sink is unconditional, so the first caller added leaks every newly minted ECT wallet secret into the logs.

**Remediation direction:** delete the print at `:141` and `:88`; a secret must never reach a serialiser whose output goes to a log sink.

---

<a id="f2"></a>

### F2 — Node RPC credentials are logged at INFO on startup · **LIVE**

**Where, three modules, three separate lines:**

| File                                      | Line | Code                                   |
| ----------------------------------------- | ---- | -------------------------------------- |
| `bitcoin/.../config/RpcClientConfig.java` | 23   | `logger.info("uri={}",uri);`           |
| `usdt/.../config/RpcClientConfig.java`    | 23   | `logger.info("uri={}",uri);`           |
| `act/.../config/JsonrpcConfig.java`       | 17   | `System.out.println("coin.rpc="+url);` |

In all three the logged value is the injected `${coin.rpc}`, which by design carries HTTP basic-auth credentials in its userinfo — `bitcoin/src/main/resources/application.properties:26-28` documents it as _"bitcoind RPC endpoint including its rpcuser:rpcpassword"_. `act`'s own `JsonrpcClient.java:32` goes to the trouble of rebuilding the URI **without** the userinfo before putting it on the wire; `JsonrpcConfig.java:17` prints the original, with it, first.

**What an attacker gains:** a bitcoind or omnicore RPC credential is spend authority over that node's wallet. Combined with [F12](#f12) — nothing in this tree ever locks a node wallet — RPC reachability is unlimited spend authority. The ACT credential likewise controls the ACT node.

**Second-order, same beans:** `usdt/.../config/RpcClientConfig.java:26` — `logger.info("client={}",client)` — passes the client object, which holds the derived `Authorization: Basic …` header value, into a log statement. `JsonrpcClient` neither overrides `toString()` nor carries Lombok `@Data`, so this most likely resolves to the default `Object.toString()` and leaks nothing. **I could not confirm this**: the superclass `com.spark.blockchain.rpcclient.BitcoinRPCClient` lives in a committed jar and I have no JDK to decompile it. Treat as unresolved.

Same class of latent risk in `act/.../component/JsonrpcClient.java:21`, where Lombok `@Data` is applied to a class whose `headers` field holds the `Authorization` value — the generated `toString()` and `getHeaders()` will emit it. No current call site logs the object.

**Remediation direction:** log the scheme, host and port only; never the whole URL for any property that is documented as carrying credentials.

---

<a id="f3"></a>

### F3 — The ETH hot-wallet private key is written to the log every thirty seconds · **LIVE** · _confirmed 2026-08-06 · rank 1_

> **Status.** Published as an inference on 2026-08-05. Half-confirmed the same day (fastjson). **Fully confirmed 2026-08-06**, when the web3j half was read on this host without a JVM. The original inference text is kept below unedited so the two follow-ups can be checked against what they claim to have resolved. Read [the 2026-08-06 follow-up](#f3-2026-08-06) for the evidence and for the one residual caveat, which is about the jar's provenance and not about the accessor chain.

**Where:** `eth-support` · `PaymentHandler.java:238` and `:243` (`:207` and `:212` when this review was written; the file gained a comment header when the [F4](#f4) Etherscan relay was deleted — the code is unchanged)

```java
198:    @Scheduled(cron = "0/30 * * * * *")
199:    public synchronized void checkJob(){
202:        if (current != null ) {
206:                    if (ethService.isTransactionSuccess(current.getTxid())) {
207:                        logger.info("转账{}已成功,检查次数:{}", JSON.toJSON(current), checkTimes);
...
212:                        logger.info("转账{}未成功,检查次数:{}", JSON.toJSON(current), checkTimes);
```

`current` is a `Payment`. `Payment` has a public getter for its `Credentials`:

- `eth-support/.../entity/Payment.java:13` — `private Credentials credentials;`
- `eth-support/.../entity/Payment.java:28` — `public Credentials getCredentials() { return credentials; }`

`JSON.toJSON(Object)` (fastjson 1.2.31) serialises a POJO through `JavaBeanSerializer`, which walks public getters recursively. The web3j chain from there is `Credentials.getEcKeyPair()` → `ECKeyPair.getPrivateKey()`, which returns the secp256k1 private key as a `BigInteger`.

**The result is that the ETH hot-wallet private key is written to the log, as a decimal integer, every thirty seconds for as long as a withdrawal is unconfirmed** — and `maxCheckTimes` is 100 (`:62`), so up to fifty minutes of repetition per withdrawal.

**Caveat — this is an inference, not an observation.** `org.web3j:core:3.3.1` is a Maven dependency, not a jar in this tree, so I could not open it; the `getEcKeyPair()` / `getPrivateKey()` accessors are taken from web3j's published API for that generation. Likewise fastjson's getter-walking is documented behaviour I could not execute. Both would take about two minutes to confirm on a host with a JDK, and confirming them is the single highest-value follow-up in this document.

#### F3 follow-up, 2026-08-05 (PR "wallet RPC gate gaps") — half answered, and it stays an inference

This finding depends on **two** libraries. One of them turned out to be readable on this host after all; the other is not, and no JDK appeared. So the honest position is that the inference is now **shorter, not resolved**.

**Confirmed — fastjson serialises through public getters, and recurses.** `com.alibaba:fastjson:1.2.31` is present in the host's local Maven repository at `~/.m2/repository/com/alibaba/fastjson/1.2.31/fastjson-1.2.31.jar`, and its SHA-1 (`1ca964122c53f03f6fc3938b58c16d63b40490ab`) matches the `.sha1` recorded beside it. A jar is a zip, and a `.class` file's constant pool and `Code` attribute can be decoded without a JVM. Reading the shipped bytecode of the exact artifact the tree pins:

```
JSON.toJSON(Object)
  → JSON.toJSON(Object, SerializeConfig)
      → SerializeConfig.getObjectWriter(Class)
      → JavaBeanSerializer.getFieldValuesMap(Object)
          → FieldSerializer.getPropertyValue(Object)
              → FieldInfo.get(Object)
                  → java.lang.reflect.Method.invoke(...)      ← the getter, reflectively
      → JSON.toJSON(Object)  on every value it collected      ← and it RECURSES
```

That is read out of the class files, not out of documentation. `TypeUtils.computeGetters` is present and carries the `get` / `is` prefix constants and the `getName` / `getParameterTypes` / `getReturnType` / `getModifiers` reflection calls, so a public no-arg `getX()` with a matching field is collected by default with no annotation required.

And nothing in `Payment` opts out: the class carries only Lombok `@Builder`, `getCredentials()` at `:28` is public, the backing field is not `transient`, and there is no `@JSONField(serialize = false)`, no `@JSONType` and no `SerializeFilter` anywhere in the tree.

**Not confirmed — the web3j half.** `org.web3j:core:3.3.1` is **not** in that local repository (it holds fastjson, Spring, Lombok, Mongo and the rest, but no `org/web3j` directory at all), and it is not one of the three committed jars. ~~and there is no network.~~ **Correction, 2026-08-06: there is a network, and the artifact is published.** See [§8.3](#83-what-leaned-on-it) — `core-3.3.1.jar` was confirmed fetchable from Maven Central from this host. The obstacle recorded below is gone; the work is simply not done. There is also no in-repo compile-time evidence to fall back on: `getEcKeyPair`, `getPrivateKey` and `ECKeyPair` **appear nowhere in the 228 Java files**, so the tree never demonstrates the accessor shape it would compile against. Whether `Credentials` exposes a public getter chain ending at the secp256k1 private key is exactly as unverified as this review left it.

**Verdict: still an inference.** The conditional has not moved, only narrowed — from "two libraries behave as documented" to "one class in one library exposes one public getter". The consequence remains asymmetric and unattractive: if it does, the ETH hot-wallet private key is written to the log as a decimal integer every thirty seconds for up to fifty minutes per unconfirmed withdrawal; if it does not, the line is harmless. Nothing available in this repository decides it, and it is not recorded as a finding.

Confirming it still needs `org.web3j:core:3.3.1` on disk. It does **not** need a working build — the same bytecode read used above would answer it in minutes, so the follow-up is "obtain the jar", not "make this tree compile".

<a id="f3-2026-08-06"></a>

#### F3 follow-up, 2026-08-06 — answered. It logs the private key.

**The jar was found, and the accessor chain is exactly what the review inferred.** The remaining conditional is closed. §F3 is a finding.

The one thing that is **not** established is the jar's provenance, and that is set out in full below rather than buried, because it is the only part of this finding that anybody should still argue with.

##### Where the jar was, and what it is

Not in `~/.m2` — the previous follow-up was right that `org/web3j` is absent there, and it still is. The search that found it covered the whole of `C:` (the only fixed drive), not just the Maven cache:

```
<scratch>/dl/web3j-crypto-3.3.1.jar     44,008 bytes
  SHA-256  e8ad15e18928853dfdb7ef59f0755d68c7c965396e951e4162003d909d8ec486
  SHA-1    8e07f435838a1d840765656d8df6b8e8e2c5f4e4
<scratch>/dl/web3j-core-3.3.1.jar      239,749 bytes
  SHA-256  515008bf4edfe58c66124f11bfb0cb519fe50156cdaa8130cd243c477dba0cf9
  SHA-1    1738c99a0c39c118a838b4ac14f945e858a9cfae
```

**Note the artifact name.** The review, this file's §4 table, and both previous follow-ups all say the blocker was `org.web3j:**core**:3.3.1`. That is the coordinate the [reactor pom pins](#4-dependency-versions-and-cve-surface), but it is **not** where these two classes live. `Credentials` and `ECKeyPair` are in `org.web3j:**crypto**`, which arrives transitively. Anyone who went looking for `Credentials.class` inside a `core` jar would have found nothing and concluded the wrong thing — `core-3.3.1.jar` does not contain either class. It does contain six classes whose descriptors name `org/web3j/crypto/Credentials`, which is how the transitive edge is visible without resolving a pom.

##### What the class files say

Decoded the same way the fastjson chain was — a jar is a zip, and a `.class` file's constant pool, access flags and member tables parse without a JVM. Nothing was compiled or executed.

```
org/web3j/crypto/Credentials          major=52 (Java 8)   public final
  FIELDS
    private final  ecKeyPair  : Lorg/web3j/crypto/ECKeyPair;      ← not transient, no annotation
    private final  address    : Ljava/lang/String;
  METHODS
    public  getEcKeyPair()Lorg/web3j/crypto/ECKeyPair;            ← public, no-arg, non-static
    public  getAddress()Ljava/lang/String;

org/web3j/crypto/ECKeyPair            major=52 (Java 8)   public final
  FIELDS
    private final  privateKey : Ljava/math/BigInteger;            ← not transient, no annotation
    private final  publicKey  : Ljava/math/BigInteger;
  METHODS
    public  getPrivateKey()Ljava/math/BigInteger;                 ← public, no-arg, non-static
    public  getPublicKey()Ljava/math/BigInteger;
```

Both getters are `public`, no-arg, non-static, and return a value. Both back onto a `private final` field that is **not** `transient` — the access flags are `0x0012` (`PRIVATE|FINAL`); `ACC_TRANSIENT` is `0x0080` and is absent. Neither class carries a single annotation: the only class-level attribute on either is `SourceFile`, the field attribute lists are empty, and no method carries `RuntimeVisibleAnnotations`. There is nothing anywhere in either class for a serialiser to opt out on.

##### The chain, end to end, every link now read rather than assumed

```
PaymentHandler.checkJob()                        @Scheduled(cron = "0/30 * * * * *")
  JSON.toJSON(current)                           current : Payment  (a FIELD, see below)
    → JSON.toJSON(Object, SerializeConfig)
        → ParserConfig.isPrimitive2(Payment)     false → keep going
        → SerializeConfig.getObjectWriter        → JavaBeanSerializer
        → JavaBeanSerializer.getFieldValuesMap   → FieldInfo.get → Method.invoke
             ↳ Payment.getCredentials()          public · field not transient · no @JSONField
        → JSON.toJSON(value)  on every value     ← RECURSES
             ↳ Credentials.getEcKeyPair()        public · field not transient · no annotation
        → JSON.toJSON(value)  again
             ↳ ECKeyPair.getPrivateKey()         public · field not transient · no annotation
             ↳ returns java.math.BigInteger
        → ParserConfig.isPrimitive2(BigInteger)  TRUE → returned VERBATIM, not skipped
  logger.info("…{}…", <that JSONObject>, checkTimes)
        → SLF4J formats with String.valueOf → JSONObject.toString() → JSON text
```

The last link was the one worth checking rather than assuming, and it was checked: `ParserConfig.isPrimitive2` was decoded and its `ldc` sequence lists `java/math/BigInteger` alongside `Boolean`, `Character`, `Byte`, `Short`, `Integer`, `Long`, `Float`, `Double`, `BigDecimal`, `String` and the four date types. So the key is **kept as a value**, not dropped and not stringified into something lossy. And the fallback branch does not save it either — when `getObjectWriter` returns something that is not a `JavaBeanSerializer`, `JSON.toJSON` falls through to `toJSONString` then `parse`, which renders the same number.

**So the ETH hot-wallet private key is written to the log as a decimal integer, every thirty seconds, for as long as a withdrawal is unconfirmed.** `maxCheckTimes` is 100, so up to fifty minutes and up to a hundred copies per withdrawal. This is `eth-support`, which is compiled into `eth`, `erc-token` and `erc-eusdt` — including the module holding the [live mainnet Tether contract](#f13).

##### A third call site on the same field, which is not a leak today

`PaymentHandler.java:274`, in `doJob`:

```java
logger.info("开始执行付款任务:current---"+JSONObject.toJSONString(current));
```

Same field, same serialiser. It is **not** a leak, and the honest reason is unglamorous: it sits inside `if (current == null && tasks.size() > 0)`, so `current` is null every time the line runs and it prints the four characters `null`. It is recorded here, and frozen in the gate, because the guard is the only thing making it harmless — the line was plainly written to dump the in-flight payment, and it would do exactly that if the condition were reordered or the statement moved below `current = payment;` eleven lines down.

<a id="f3-rank"></a>

##### Where this now ranks: above [F1](#f1) and [F2](#f2)

Three services print a spending credential on a success path. This one is the worst of the three, for three reasons, in increasing order of importance:

1. **Volume.** [F2](#f2) prints once per boot and [F1](#f1) once per withdrawal. This prints up to a hundred times per withdrawal, which makes it far and away the most likely of the three to survive into a truncated log excerpt, a sampled aggregator, a support paste or a screenshot.
2. **Directness.** [F2](#f2)'s node credential is only spend authority to somebody who can also reach the node's RPC port. A private key needs nothing but the key — any public RPC endpoint in the world will broadcast the resulting transaction.
3. **Irreversibility, which is the one that decides it.** A node RPC credential can be rotated in `bitcoin.conf`. The [F1](#f1) withdrawal secret can be rotated, and `OWNER-ACTIONS-WALLET-RPC-SECRETS.md` §A1 already tells the owner to rotate it. **A private key cannot be rotated — it is the account.** The only remedy is to sweep every asset to a new key, and until that sweep is done and confirmed, everyone who has ever read that log can spend. Rotation converts F1 and F2 into historical incidents; nothing converts this one except moving the money.

##### The residual caveat: the jar's provenance, stated plainly

**This jar cannot be checksum-verified, and this review does not claim it has been.** The distinction from the fastjson read matters and is not glossed:

|                           | fastjson 1.2.31                                 | web3j crypto 3.3.1                       |
| ------------------------- | ----------------------------------------------- | ---------------------------------------- |
| Location                  | `~/.m2/repository/com/alibaba/fastjson/1.2.31/` | a scratch download directory             |
| Maven layout              | yes, with `_remote.repositories`                | no                                       |
| `.sha1` sidecar           | yes, **and it matches**                         | none                                     |
| `.pom` beside it          | yes                                             | none                                     |
| Embedded `META-INF/maven` | —                                               | none (web3j 3.x shipped a bare manifest) |
| Jar signature             | none                                            | none                                     |

It also arrived in a way this review should record rather than assume away: **that directory was created on 2026-08-06 and also contains a JDK 8 archive and a Maven archive.** Something on this host had network access, which contradicts the premise stated in [§1.2](#12-what-could-not-be-done-and-why) and repeated in this document's footer. That premise was true when the review was written and is now stale. Nothing in this follow-up used that network, downloaded anything, or ran the JDK — the class files were parsed as bytes, which is the same method and the same evidentiary standard as the fastjson read.

**What makes the read trustworthy anyway, and it is not the filename.** Every `org.web3j.crypto` API this tree compiles against resolves against this jar with an exactly matching signature:

| Called at                           | Signature required                                                                              | Present in the jar |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------ |
| `EthService.java:61`                | `WalletUtils.generateNewWalletFile(String, File, boolean) → String`                             | ✓                  |
| `EthService.java:62, 113, 178, 199` | `WalletUtils.loadCredentials(String, String) → Credentials`                                     | ✓                  |
| `PaymentHandler.java:145, 181, 190` | `Credentials.getAddress() → String`                                                             | ✓                  |
| `PaymentHandler.java:158, 193`      | `TransactionEncoder.signMessage(RawTransaction, Credentials) → byte[]`                          | ✓                  |
| `PaymentHandler.java:154`           | `RawTransaction.createEtherTransaction(BigInteger, BigInteger, BigInteger, String, BigInteger)` | ✓                  |
| `PaymentHandler.java:192`           | `RawTransaction.createTransaction(BigInteger, BigInteger, BigInteger, String, String)`          | ✓                  |

A jar fabricated to mislead this review would have had to reconstruct that entire compile surface consistently. The class-file version is 52 (Java 8), matching a 2018 build of a library whose poms target 1.8. And one incidental corroboration of [F4](#f4) falls out of the same read for free: the three-argument overload is `signMessage(RawTransaction, **byte**, Credentials)` — the chain id is a `byte` — and the tree calls the two-argument form at both signing sites, which is the pre-EIP-155 shape [F4](#f4) describes.

**What would close the gap, in one command, for whoever next has a network:** fetch `https://repo1.maven.org/maven2/org/web3j/crypto/3.3.1/crypto-3.3.1.jar.sha1` and compare it to `8e07f435838a1d840765656d8df6b8e8e2c5f4e4`. If it matches, the last conditional in this finding is gone. If it does not match, **the jar on this host is not the published artifact and this finding must be reopened** — in which case the interesting question stops being F3 and starts being how it got here.

> ##### Gap closed, 2026-08-06 — it matches. **F3 has no remaining conditional.**
>
> That command was run, the same day, by the [hex-constant audit](#7-fixed-width-hex-constant-audit-addendum-2026-08-06) — which existed because the "no network" premise was wrong, and which therefore had the one thing this paragraph was waiting for. Three values, all identical:
>
> | Source                                                | SHA-1                                      |
> | ----------------------------------------------------- | ------------------------------------------ |
> | `repo1.maven.org/…/crypto-3.3.1.jar.sha1` (published) | `8e07f435838a1d840765656d8df6b8e8e2c5f4e4` |
> | recorded above, from the jar on this host             | `8e07f435838a1d840765656d8df6b8e8e2c5f4e4` |
> | recomputed from the jar's bytes with `sha1sum`        | `8e07f435838a1d840765656d8df6b8e8e2c5f4e4` |
>
> SHA-256 `e8ad15e18928853dfdb7ef59f0755d68c7c965396e951e4162003d909d8ec486` likewise matches what the follow-up recorded. **The jar read above is the published Maven Central artifact.** The provenance caveat is discharged, the compile-surface argument that stood in for it is no longer load-bearing, and [F3](#f3) is now a finding with no inference anywhere in it: `eth-support` writes the ETH hot-wallet private key to the log.
>
> Nothing was compiled to establish this, and nothing was executed — an HTTPS GET of a checksum file and a local digest of bytes already on disk. The correct reading of the sequence is in [§8](#8-correction--this-host-has-network-access): a false entry in [§1.2](#12-what-could-not-be-done-and-why) was the only thing standing between this document's highest-priority finding and its full confirmation, and it stood there for a day.

##### What changed in the gate

`tooling/ci/wallet-rpc-mainnet-scan.mjs` rule **M9** previously and deliberately did not reach these lines, and its header said why: _"a gate must not promote an inference to a finding by pattern-matching it; the day somebody reads `org.web3j:core:3.3.1` is the day this becomes a finding, and it will be added then, by a human, with a reason."_ That condition is now met, so M9 was extended and the three call sites frozen (M9 goes from 8 entries to 11).

The extension is a second taint **source**, not a broader sink. M9 sourced taint from identifier names and `@Value` bindings, and neither can see this: nothing about `current` is spelled like a secret, and the key is three getters and one third-party library away. So a value is now also credential-bearing if its **declared type** has a public getter graph that reaches a private key — `Payment`, `Credentials`, `ECKeyPair` — **and it is passed whole to a reflective serialiser**. Both halves are required, which is what keeps `payment.getTo()` and the `address=` / `gasPrice=` lines in the same class silent; two new rule probes pin that boundary in both directions.

**Remediation direction, unchanged and now unconditional:** never pass an object holding `Credentials` to a serialiser. Log the txid and the business id. A `@JSONField(serialize = false)` on `Payment.credentials` would also work, and is worse, because it leaves the next object that holds a `Credentials` unprotected.

**Same file, definitely true, no inference needed:** `PaymentHandler.java:162` — `logger.info("hexRawValue={}", hexValue)` — logs the complete signed raw transaction on the token withdrawal path. Because that signature carries no chain id ([F4](#f4)), anyone with log-read access holds a transaction that is **valid and replayable on every EVM chain simultaneously**.

**Remediation direction:** never pass an object holding `Credentials` to a serialiser; log the txid and business id only.

---

<a id="f4"></a>

### F4 — Chain-id-less signing, and an unconditional second broadcast to mainnet Etherscan · **LIVE** · _known critical, confirmed and extended_

**The signing call sites.** There are exactly **two** in the whole tree, both in `eth-support/.../service/PaymentHandler.java`, both the two-argument pre-EIP-155 form, both textually identical:

| Line | Path              | Code                                                                                               |
| ---- | ----------------- | -------------------------------------------------------------------------------------------------- |
| 123  | ether withdrawal  | `byte[] signedMessage = TransactionEncoder.signMessage(rawTransaction, payment.getCredentials());` |
| 160  | ERC-20 withdrawal | `byte[] signedMessage = TransactionEncoder.signMessage(rawTransaction, payment.getCredentials());` |

The three-argument overload `signMessage(rawTransaction, chainId, credentials)` is not used anywhere. There is no other signing call site in the tree: `bch`/`bsv`/`ltc` mint keys but their transfer endpoints are unimplemented stubs, and `bitcoin`/`usdt` delegate signing to the node.

**Consequence:** the produced signature has no chain id, so the transaction is valid on Ethereum mainnet, on every testnet, and on every EVM fork where that account has a balance. This is why "point `coin.rpc` at a testnet" was never a mitigation — a testnet-signed withdrawal from this code is also a valid mainnet withdrawal.

**The second broadcast, and whether it is conditional.** The mission asked whether the second broadcast is conditional. **In practice it is not.**

```java
// PaymentHandler.java — ether path
125:            EthSendTransaction ethSendTransaction = web3j.ethSendRawTransaction(hexValue).sendAsync().get();
128:            if (StringUtils.isEmpty(transactionHash)) { ... }
131:            else {
132:                if(etherscanApi != null){
133:                    logger.info("=====发送Etherscan广播交易======");
134:                    etherscanApi.sendRawTransaction(hexValue);
135:                }
```

```java
// PaymentHandler.java — ERC-20 path
163:            EthSendTransaction ethSendTransaction = web3j.ethSendRawTransaction(hexValue).sendAsync().get();
170:                if(etherscanApi != null){
171:                    logger.info("=====发送Etherscan广播交易======");
172:                    etherscanApi.sendRawTransaction(hexValue);
173:                }
```

The only guard is `etherscanApi != null`, on a field declared `@Autowired(required = false)` at `:57-58`. But the bean is defined **unconditionally**:

```java
// eth-support/.../config/EthConfig.java
35:    @Bean
36:    @ConfigurationProperties(prefix = "etherscan")
37:    public EtherscanApi etherscanApi(){
38:        EtherscanApi api = new EtherscanApi();
39:        return api;
40:    }
```

There is no `@ConditionalOnProperty` on it, unlike the `web3j` bean directly above at `:24`. So in any module that imports `EthConfig` — `eth`, `erc-token`, `erc-eusdt` — the field is always non-null and **the second broadcast always fires**. The `@Autowired(required=false)` reads as a switch and is not one.

**The destination is not configurable at all.** `eth-support/.../service/EtherscanApi.java:19` and `:34` hardcode `https://api.etherscan.io/api` as a string literal. Only the API key is a property (`etherscan.token`). Ethereum mainnet is compiled in.

**What this costs the operator:** the mainnet copy is the one that lands. Every ETH and ERC-20 withdrawal this tree performs is broadcast to Ethereum mainnet by way of a third party, whatever `coin.rpc` names, and — because of the chain-id-less signature — it is a _valid_ mainnet transaction rather than one the network rejects. Combined with [F3](#f3)'s `hexRawValue` log line, the same transaction is also sitting in the logs in relayable form.

**Remediation direction:** pass a chain id to `signMessage`, and make the Etherscan endpoint a property that defaults to unset with the call skipped when it is.

---

<a id="f5"></a>

### F5 — Every value-moving endpoint is an HTTP GET behind one shared static token · **LIVE**

**The authorization model is one bit.** `RpcAuthInterceptor` compares a single shared secret from the `X-Rpc-Auth-Token` header, and `RpcSecurityConfig` applies it to `/**` with no exclusions. The comparison itself is sound — `rpc-common/.../config/RpcAuthInterceptor.java:55-66` accumulates into `diff` without early return and folds the length difference in, and the 401 body at `:45` is deliberately uninformative. The startup guard at `RpcSecurityConfig.java:31-41` genuinely fails closed on a missing or under-32-character token.

But that is the _whole_ model. Reading a block height and sweeping the entire deposit float take the identical credential. There is no per-endpoint scope, no destination allowlist, no amount cap, no rate limit, no second approval, and no replay protection.

**And every value-moving endpoint is a GET:**

| Module                  | File:line                                        | Endpoint                                               | Effect                                                                        |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `eth`                   | `controller/WalletController.java:84`            | `GET /rpc/withdraw?address=&amount=`                   | pays from the hot wallet to any address                                       |
| `eth`                   | `controller/WalletController.java:68`            | `GET /rpc/transfer?address=&amount=&fee=`              | sweeps deposit addresses to any address                                       |
| `erc-eusdt`             | `controller/WalletController.java:154`           | `GET /rpc/withdraw`                                    | pays live-mainnet USDT ([F13](#f13)) to any address                           |
| `erc-eusdt`             | `controller/WalletController.java:118`           | `GET /rpc/transfer`                                    | sweeps every deposit address to any address                                   |
| `erc-eusdt`             | `controller/WalletController.java:98`            | `GET /rpc/transfer-from-address?fromAddress=&address=` | attacker picks both source and destination                                    |
| `erc-token`             | same lines                                       | same                                                   | same                                                                          |
| `usdt`                  | `controller/WalletController.java:56`            | `GET /rpc/withdraw`                                    | Omni USDT; **no `amount > 0` check**, `fee` accepted and ignored              |
| `usdt`                  | `controller/WalletController.java:71`            | `GET /rpc/transfer`                                    | sweeps the whole address book                                                 |
| `usdt`                  | `controller/WalletController.java:112`           | `GET /rpc/transfer-from-address`                       | attacker picks the funding address                                            |
| `bitcoin`               | `controller/WalletController.java:55`            | `GET /rpc/transfer`, `GET /rpc/withdraw`               | raw-tx build and broadcast; `fee` unvalidated                                 |
| `ect`                   | `controller/WalletController.java:40`            | `GET /rpc/transfer`, `GET /rpc/withdraw`               | the withdrawal from [F1](#f1); `fee` accepted and silently ignored            |
| `bch`/`bsv`/`ltc`/`btm` | `WalletController.java:144`/`:144`/`:140`/`:140` | `GET /rpc/transfer`, `GET /rpc/withdraw`               | stubs today — but the _mapping shape_ is inherited by whoever implements them |

**What an attacker gains:** a single GET, with the destination address and the amount in the query string, drains the float. And because these are GETs, the credential and the whole request are exposed in ways a POST would not be: every reverse-proxy and load-balancer access log records the full URL with the destination and amount; browser history and `Referer` headers carry it; it is CSRF-triggerable by any HTML in the perimeter that can emit a request with the header — and trivially replayable from any log.

`act/.../controller/WalletController.java:41` compounds the shape: `@RequestMapping("address/{account}")` with no `method` element accepts every verb.

**What cannot be determined here:** whether one `WALLET_RPC_AUTH_TOKEN` value is deployed for all thirteen services. If it is, compromise of any one service's environment — including the three that print node credentials in [F2](#f2) — unlocks the withdrawal endpoints of all thirteen.

**Remediation direction:** value-moving operations must be POSTs with a per-operation credential, a destination allowlist and an idempotency key.

---

<a id="f6"></a>

### F6 — Deposits are credited without checking that the transaction succeeded · **LIVE** (`eth`) / **LATENT** (`erc-*`)

**`eth` — no check of any kind.** `eth/.../component/EthWatcher.java:48-57`:

```java
48:                    if (StringUtils.isNotEmpty(transaction.getTo())
49:                            && accountService.isAddressExist(transaction.getTo())
50:                            && !transaction.getFrom().equalsIgnoreCase(getCoin().getIgnoreFromAddress())) {
51:                        Deposit deposit = new Deposit();
52:                        deposit.setTxid(transaction.getHash());
55:                        deposit.setAmount(Convert.fromWei(transaction.getValue().toString(), Convert.Unit.ETHER));
56:                        deposit.setAddress(transaction.getTo());
57:                        deposits.add(deposit);
```

The credit decision reads `to` and `value` straight out of the block body. The transaction **receipt**, which is where the success flag lives, is never fetched on this path. A transaction that is included in a block but reverts still carries its `to` and its `value` in the block body while transferring nothing.

**`erc-token` / `erc-eusdt` — the check exists and is commented out.** `erc-eusdt/.../component/TokenWatcher.java:62-66` and `:106-109`:

```java
62://                try {
63://                	   合约执行结果判断，此处暂时注释掉，后面需要确认是否一定需要
64://                    EthGetTransactionReceipt receipt =  web3j.ethGetTransactionReceipt(transaction.getHash()).send();
65://                    if(receipt.getTransactionReceipt().get().getStatus().equalsIgnoreCase("0x1")){
```

_"Contract execution result check, commented out for now, need to confirm later whether it is strictly necessary."_ It is strictly necessary. The check is still present and active in `replayBlockInit` at `:196` — the manual replay path — so the scheduled watcher is the one running without it.

**The compensating control, and why it is currently inert.** The token watcher has a second guard at `:87-90`, an Etherscan `getLogs` round-trip that checks a Transfer event was actually emitted, and the code comment says it exists _"防止低版本的token假充值"_ — to prevent fake deposits. It runs only when `contract.getEventTopic0()` is non-empty. Both modules set it:

```
erc-eusdt/src/main/resources/application.properties:72     ← :51 when this review was written
contract.event-topic0=0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a1128f55a4df523b3ef

erc-token/src/main/resources/application.properties:51
contract.event-topic0=0xddf252ad1be2c89b69c2b068fc378daa952b7f163c4a11628f55a4df523b3ef
```

_(The `erc-eusdt` line moved from 51 to 72 when `contract.address` was replaced by a placeholder and its reasoning written into the file. The two modules no longer share a line number. Verified against the tree on 2026-08-06 — see [§7.4](#74-the-seven-malformed-constants).)_

The real ERC-20 `Transfer` topic0 is `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` — 64 hex digits. **Both of these are 63 digits**, each missing a different character, in exactly the digit-drop mangling style the upstream applied to the addresses. Neither will ever match. `checkEventLog` returns false, `continue` fires, and **no deposit is ever credited on either module**.

So today the erc modules fail closed — no fake deposits, and no real ones either. That is not a control; it is a broken constant that happens to point the safe way. Correcting the topic0 to its proper 64 digits restores a real Transfer-log check, which is the right fix. **Deleting the line, or setting it empty, removes the guard entirely and makes the commented-out receipt check the only thing that was standing between this watcher and free money — and it is commented out.** The mangled topic0 is not in the frozen baseline of `wallet-rpc-mainnet-scan.mjs`, so nothing currently stops that edit.

**What an attacker gains:** on `eth` today, credit for ether that was never transferred, at the cost of the gas for a reverting transaction. On the erc modules, the same the moment topic0 is touched.

**Remediation direction:** uncomment and require the receipt status check on every deposit path; treat an unverifiable receipt as "not a deposit".

---

<a id="f7"></a>

### F7 — The token deposit watcher does not check which function was called · **LATENT**

**Where:** `erc-eusdt/.../component/TokenWatcher.java:69-82` (identical in `erc-token`)

```java
69:                        String input = transaction.getInput();
70:                        String cAddress = transaction.getTo();
71:                        if (StringUtils.isNotEmpty(input) && input.length() >= 138 && contract.getAddress().equalsIgnoreCase(cAddress)) {
73:                            String data = input.substring(0, 9);
74:                            data = data + input.substring(17, input.length());
75:                            Function function = new Function("transfer", Arrays.asList(), Arrays.asList(new TypeReference<Address>() {
79:                            List<Type> params = FunctionReturnDecoder.decode(data, function.getOutputParameters());
81:                            String toAddress = params.get(0).getValue().toString();
82:                            String amount = params.get(1).getValue().toString();
```

The only conditions are: the input is at least 138 characters, and the transaction is addressed to the watched contract. **The four-byte function selector is never compared to `transfer`'s `0xa9059cbb`.** Lines 73-74 slice the selector region apart to strip address padding and then decode whatever remains as `(address, uint256)`.

Any call to the contract with a compatible argument layout decodes as a transfer. `approve(address spender, uint256 value)` is the obvious one: same two argument types, same encoding, always succeeds, moves nothing, costs about 45,000 gas. An attacker calls `approve(theirDepositAddress, 10^12)` on USDT and this watcher reads it as a transfer of 10^12 units to their deposit address.

**Currently latent** for the same reason as [F6](#f6): the mangled topic0 makes the Etherscan check reject everything. A _correct_ topic0 would also catch this one, because `approve` emits `Approval`, not `Transfer`. An _empty_ topic0 leaves nothing at all in the way.

**Remediation direction:** require `input.startsWith("0xa9059cbb")` before decoding, and decode the arguments properly rather than by string surgery.

---

<a id="f8"></a>

### F8 — Trust-all TLS on the deposit-detection transport, feeding fastjson 1.2.31 · **LIVE**

**Where:** `bch|bsv|ltc|btm|eos|xmr/.../util/SSLClient.java:19-26` — six byte-identical copies:

```java
19:        SSLContext sslContext = new SSLContextBuilder().loadTrustMaterial(null, new TrustStrategy() {
20:            //信任所有
21:            public boolean isTrusted(X509Certificate[] chain, String authType) throws CertificateException {
22:                return true;
23:            }
24:        }).build();
```

_"Trust everything."_ Every certificate chain is accepted. This client is what `HttpClientUtil.doHttpsGet` (`:274`) and `doHttpsPost` (`:48`, `:92`) use, which is the transport for every outbound call in the four modules that read deposits from a third-party explorer:

- `bch/src/main/resources/application.properties:26` — `…blockApi=https://bch-chain.api.btc.com/v3/`
- `bsv/...:26` — `https://bchsvexplorer.com/api/`
- `ltc/...:27` — `https://litecoinblockexplorer.net/api/`
- `eos/...:26` — `https://open-api.eos.blockdog.com/`

**The response is then handed to fastjson.** `bch/.../controller/WalletController.java:97` and `:121`, `bch/.../component/Watcher.java:87, 103, 176`, and the equivalents in the other five, all call `JSON.parseObject(retStr)`. The pinned version is **fastjson 1.2.31**, at `vendor/upstream-exchange/01_wallet_rpc/pom.xml:57-58`.

fastjson 1.2.31 predates the 1.2.48 fix for the universal `checkAutoType` bypass, and sits inside the long run of autotype-bypass advisories that began with CVE-2017-18349. The calls here are `parseObject(String)` returning a `JSONObject`, which is the least-exposed form — autotype is not explicitly enabled anywhere in the tree, and no `Feature.SupportAutoType` or `ParserConfig.setAutoTypeSupport` appears in any file.

**What an attacker gains:** the chain is _any network position between the service and the explorer_ → a self-signed certificate, unconditionally trusted → arbitrary JSON delivered to a known-vulnerable parser → potential code execution **inside a process that holds every private key that module has minted**. Even without reaching code execution, that same position lets an attacker fabricate deposits and balances outright, because these explorers are the sole source of truth for crediting on `bch`, `bsv`, `ltc` and `eos`.

**What could not be determined:** whether an exploitable gadget class is on the runtime classpath. That needs `mvn dependency:tree`, which needs Maven, which is not on this host. The honest position is that the TLS defect is certain and the parser is a known-bad version; the last step of the chain is unverified.

**Remediation direction:** delete `SSLClient` and use the default `HttpClients.createDefault()`, which validates; pin fastjson to a version past the autotype rewrite, or replace it.

---

<a id="f9"></a>

### F9 — Unencrypted bitcoinj wallet, plus a race that silently destroys keys · **LIVE**

**Where:** `bch|bsv/.../controller/WalletController.java:41-74` and `ltc/...:41-74` (litecoinj rather than bitcoinj; same code):

```java
41:	@GetMapping("address/{account}")
42:    public MessageResult getNewAddress(@PathVariable String account){
45:        NetworkParameters params  = MainNetParams.get();
47:        final File walletFile = new File(walletPath);
51:			wallet = Wallet.loadFromFile(walletFile);
57:        ECKey key = new ECKey();
59:        Address address = key.toAddress(params);
61:        wallet.importKey(key);
64:			wallet.saveToFile(walletFile);
65:			accountService.saveOne(account, address.toBase58());
```

**Key generation:** `new ECKey()` with no arguments, so entropy comes from the library's internal `SecureRandom`. No application-supplied seed, no HD derivation, no mnemonic anywhere in the tree.

**Storage:** a bitcoinj/litecoinj protobuf wallet at the wallet-path property — `/data/bch/bch.wallet`, `/data/bsv/bsv.wallet`, `/data/ltc/ltc.wallet` (properties line 25). **Nothing encrypts it.** There is no `Wallet.encrypt(...)` call, no `KeyCrypter`, and no wallet password property in any of the three modules. The private keys are at rest in plaintext, and nothing in this tree sets file permissions on that path. `MainNetParams.get()` at `:45` is the only network selector; there is no testnet branch.

**The race, which is the part not previously recorded.** Lines 51 → 61 → 64 are a read-modify-write over a shared file, in a Spring singleton `@RestController`, with **no synchronisation of any kind**. Two concurrent `GET /rpc/address/{account}` requests both load the same wallet snapshot at `:51`, each imports only its own key at `:61`, and whichever reaches `:64` second writes a wallet that does not contain the other's key.

The lost key's address has already been returned to the caller at `:67` and persisted to Mongo at `:65`. bitcoinj's `saveToFile` is temp-file-plus-rename, so the file is never left malformed — **the loss is silent.** Any deposit later sent to that address is permanently unspendable, and nothing anywhere will report an error.

**What an attacker gains:** nothing directly — this is a self-inflicted custody loss, triggered by ordinary concurrency and made trivially reproducible by anyone able to issue two simultaneous requests. It belongs in a custody review because the outcome is identical to theft.

Also note `:51` throws if the wallet file does not yet exist, and nothing in this code creates it; the module cannot bootstrap itself.

**Remediation direction:** encrypt the wallet, and serialise the load-import-save sequence behind a lock.

---

<a id="f10"></a>

### F10 — `act` cannot be shown to have the auth guard, and the gate that checks this is version-blind · **LIVE**

**The closure, verified module by module.** Thirteen modules carry `@SpringBootApplication`. Six of them — `bch`, `bsv`, `btm`, `eos`, `ltc`, `xmr` — ship their **own** copy of `RpcSecurityConfig` and `RpcAuthInterceptor` (the two classes are byte-identical across all six, and none of the six declares a dependency on `rpc-common`). The other seven — `act`, `bitcoin`, `ect`, `erc-token`, `erc-eusdt`, `eth`, `usdt` — reach the guard through `rpc-common` directly or through `eth-support` → `rpc-common`. Because `RpcSecurityConfig` sits in the shared `…​.config` package and every application class is in the shared root package, component scan picks it up.

**The exception:** `act/pom.xml` declares `rpc-common` **twice, with two different versions**:

```xml
49:        <dependency>
50:            <groupId>…</groupId>          <!-- the reactor groupId -->
51:            <artifactId>rpc-common</artifactId>
52:            <version>1.0</version>
53:        </dependency>
...
77:        <dependency>
78:            <groupId>…</groupId>          <!-- the reactor groupId -->
79:            <artifactId>rpc-common</artifactId>
80:            <version>1.2</version>
81:        </dependency>
```

Maven takes the **first** declaration for a duplicate groupId:artifactId, so `act` resolves `rpc-common` at **1.0**. The `rpc-common` in this reactor is version 1.2 (`rpc-common/pom.xml`, `${project-version}` = 1.2 at `pom.xml:36`). There is no `rpc-common:1.0` in this tree. Either the build fails to resolve it, or a stale 1.0 artifact in a local repository satisfies it — and a 1.0 predating the auth work would contain no `RpcSecurityConfig`, in which case **`act` boots with no interceptor and no startup failure**, because nothing else reads `rpc.auth-token`. That is the exact failure mode the auth work was created to eliminate.

I cannot resolve which, from this tree, without Maven.

**This is also a gap in `tooling/ci/wallet-rpc-auth-scan.mjs`.** Its `declaredArtifacts()` collects `<artifactId>` values with a regex and never reads `<version>`, so rule W1 sees the string `rpc-common` in `act/pom.xml` and passes it. The gate proves the _name_ of a guard-providing module appears in the pom; it does not prove the _version_ that resolves contains the guard. `act` is currently green and unproven.

**Remediation direction:** delete the `1.0` declaration; and make W1 compare versions, or fail any pom that declares the same artifact twice.

---

<a id="f11"></a>

### F11 — The depositor chooses which user account gets credited · **LIVE** (`eos`) / **LATENT** (`xmr`)

Both modules use a single shared deposit address and route the credit by a caller-supplied tag.

**`eos/.../component/Watcher.java:123-130`:**

```java
123:								String memo = transData.getString("memo");
125:								Boolean isNumric = memo.matches("^\\d+$");
126:								if(isNumric) {
130:										deposit.setUserId(Long.parseLong(memo));
```

**`xmr/.../component/Watcher.java:112-123`:**

```java
112:						String paymentId = incommObj.getString("payment_id");
115:						StringBuilder uidS = new StringBuilder();
116:						for(int j = 0; j < 8; j++) {
117:							uidS.append(paymentId.charAt(j*8 + 1));
118:	            		}
119:						Long uid = Long.parseLong(uidS.toString(), 16) + 345678;
123:						deposit.setUserId(uid);
```

The only validation on the eos path is that the memo is a digit string. There is **no check that the user id exists**, and the unexplained `+ 345678` offset on the xmr path is undocumented. A depositor sends a minimal amount with a chosen tag and it is credited to whichever account id they named.

This is the intended shared-address design for these two chains, so the finding is not that a tag is used — it is that the tag is trusted without an existence check, and that `Long.parseLong` on an unbounded digit string throws on overflow, which is caught at `eos Watcher.java:145-148` and **discards the whole batch**, so one crafted memo silently drops every legitimate deposit scanned alongside it.

**`xmr` is latent because the watcher does not work at all.** `xmr/.../component/Watcher.java:89-94` builds a `param2` object carrying `min_height` / `max_height` / `in: true`, and then never attaches it — line 100 posts only `param`:

```java
100:			String result = HttpClientUtil.doHttpPost(this.blockApi, param.toJSONString(), headerParam);
```

`get_transfers` is therefore called with no parameters, the height filter is dead, and `obj.getJSONObject("result").getJSONArray("in")` at `:103` will not find what it expects — caught at `:139-142`, returns `null`, and `Watcher.check` rolls the scan height back (`rpc-common/.../component/Watcher.java:45`), so the scanner retries the same range forever. `xmr` credits nothing. Separately, `paymentId.charAt(j*8 + 1)` reads index 57, so any `payment_id` shorter than 58 characters throws.

**Remediation direction:** validate the routing tag against a known account before crediting, and fail one deposit rather than the batch.

---

<a id="f12"></a>

### F12 — `walletpassphrase` and `walletlock` are dead code across the entire tree · **LIVE**

**Where:** `rpc-common/src/main/java/…/util/WalletOperationUtil.java:18-29`

```java
18:    public static void walletpassphrase(BitcoinRPCClient rpcClient, String passphrase) throws BitcoinException {
20:            rpcClient.query("walletpassphrase", passphrase, 60);
22:    }
25:    public static void walletlock(BitcoinRPCClient rpcClient) throws BitcoinException {
27:            rpcClient.query("walletlock");
29:    }
```

The 60-second unlock is confirmed exactly as reported. **What was not previously recorded is that neither method has a single caller anywhere in `01_wallet_rpc`.** A grep for `WalletOperationUtil`, `walletpassphrase` and `walletlock` across all 228 Java files returns only these declarations. There is no other unlock or lock anywhere in the tree.

So the question "is the lock guaranteed on the error path" has an answer that is worse than a missing `finally`: **there is no lock and no unlock on any path.** The odd indentation at `:19-21` and `:26-28` is the residue of a `try` block someone removed.

**What this implies about the deployment,** and both branches are defects:

- If the bitcoind / omnicore wallet is **encrypted**, every value-moving call in `bitcoin` and `usdt` fails — `BitcoinUtil.sendTransaction` (`bitcoin/.../WalletController.java:62`) and `omni_send` (`usdt/.../JsonrpcClient.java:144`) both require an unlocked wallet, and neither unlocks. `usdt/src/main/resources/application.properties:32` sets `coin.password=${USDT_WALLET_PASSWORD}`, which binds to **nothing** — the `Coin` entity has no `password` field, and `CoinConfig` uses the default `ignoreUnknownFields=true`, so it is silently discarded. The passphrase is configured, never read, never sent.
- If the wallet is **not encrypted**, or is permanently unlocked, then **anyone who reaches the node's RPC port has unlimited spend authority** — which is precisely the credential that [F2](#f2) writes to the log at startup.

**Also worth stating for whoever wires this up:** `walletpassphrase` takes the passphrase as an _RPC parameter_. The committed `BitcoinRPCClient` embeds `", params: "` in its exception messages, and those messages are returned to HTTP callers ([F15](#f15)). Connecting this utility naively would put the wallet passphrase into both the logs and the error responses.

**Remediation direction:** decide which branch is true; if the wallet is encrypted, unlock immediately before the send and relock in a `finally`, passing the passphrase somewhere it cannot reach an exception message.

---

<a id="f13"></a>

### F13 — The live mainnet Tether contract, pinned and unmangled · **LIVE** · _known critical, confirmed_

**Where:** `erc-eusdt/src/main/resources/application.properties:39` **— as this review found it. No longer present; see the note below.**

```
contract.address=0xdac17f958d2ee523a2206206994597c13d831ec7
```

> **Status correction, 2026-08-06.** This literal is **gone from the tree.** The property is now `contract.address=${EUSDT_CONTRACT_ADDRESS}` at `erc-eusdt/.../application.properties:60`, an unresolved placeholder, with the reasoning written into the file above it — replaced rather than mangled, precisely so that no one can "repair" it back into a live pin. The corresponding `M4-address` entry was **removed** from the frozen baseline, which is the only direction that baseline may move. F13 as written describes the state at the date of this review and is retained for the record; the finding is **remediated for `erc-eusdt`**. Its `erc-token` twin below is unchanged, still 39 digits, and still frozen. Current state of every contract address in the tree: [§7.4](#74-the-seven-malformed-constants).

Forty valid hex digits, correct, unmangled: the live Ethereum mainnet Tether (USDT) contract. Its twin at `erc-token/src/main/resources/application.properties:39` is `0xdac17f958d2ee5232206206994597c13d831ec7` — thirty-nine digits, mangled in the upstream's style, and inert as written. Both confirmed by digit count and by comparison with the known contract address.

**Every other live-value constant found in the tree**, for completeness — all thirteen properties files were read:

| Module      | File:line                      | Value                                                                                               | Note                                                                                             |
| ----------- | ------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `usdt`      | properties:35                  | `coin.withdraw-address=1QDEimf6f4VrDqCSBmgfh1ReW9L2vHvvg`                                           | BTC mainnet P2PKH; the sweep destination                                                         |
| `xmr`       | properties:31                  | `coin.depositAddress=47ddRY4X…LGnFZnLpBGD8f`                                                        | Monero mainnet standard address                                                                  |
| `eth`       | properties:35                  | `coin.withdraw-wallet=UTC--2019-08-13T06-24-07.378035684Z--672881426632b13d8f474664c039acc7b5610b7` | keystore filename, 39 digits (mangled)                                                           |
| `erc-token` | properties:32                  | `…--67288142662b13d18f474664c039acc7b5610b7`                                                        | **a third distinct mangling of the same account**                                                |
| `erc-eusdt` | properties:32                  | `…--2b7d8aa02fccbd7bc69368fa30cabe22e3c2c2d.json`                                                   | a **different** account; the only `.json` suffix                                                 |
| `eth`       | properties (ignore-from)       | `0x672881426632b13d18f74664c039acc7b5610b7`                                                         | 39 digits; the platform's own hot wallet                                                         |
| `act`       | properties:30                  | `coin.master-address=ACT5i65XW1yRasdeLMD2rFJffRmndn91bho6`                                          | carries the `asd` mangling                                                                       |
| `ect`       | properties:12, :31             | `esV75BQfiEiKdgaivjasdw7EXk3BwJiscX`, `esV75BQfiEiKdasdejEYCt7EXk3BwJiscX`                          | `asd` mangling; the second is the [F1](#f1) address                                              |
| `eos`       | properties:35                  | `coin.depositAddress=AAAAAAAAAAAAA`                                                                 | dummy; eos deposit scanning is non-functional as shipped                                         |
| `btm`       | properties:26                  | `bytom.api.url=http://111.111.111.111:9888/`                                                        | the upstream's "redaction" is a **routable** address, over plain HTTP, carrying the access token |
| `btm`       | properties:32                  | `bytom.alias=<the upstream vendor’s own name>`                                                      | the node-side signing key alias                                                                  |
| `ect`       | properties:7                   | `spring.data.mongodb.uri=mongodb://127.0.0.1:27017/wallet`                                          | the **only** module still hardcoding the Mongo URI                                               |
| all         | properties (init-block-height) | thirteen mainnet start heights                                                                      | already frozen by the mainnet gate                                                               |

All of these except the `erc-eusdt` `.json` keystore and the `ect` Mongo URI are already pinned in the 38-entry frozen baseline of `tooling/ci/wallet-rpc-mainnet-scan.mjs`. ~~**The two mangled `contract.event-topic0` values from [F6](#f6) are not in that baseline and should be**, because they are the only thing currently preventing fake deposit credits and a one-character edit removes them.~~

> **Stale as of 2026-08-06 — fixed, and recorded here rather than deleted so the sequence stays legible.** Both `contract.event-topic0` values, and the `erc-eusdt` `.json` keystore, are now frozen: rule `M4-topic` carries the two topic0 entries with a paragraph instructing the reader not to correct them and not to delete them outside a change that can be built and tested, and `M4-keystore` carries all three keystore filenames. The baseline is no longer 38 entries — it is **54, across 58 recorded occurrences** (`M1:6 M2:2 M3:1 M4-address:8 M4-endpoint:5 M4-height:12 M4-keystore:3 M4-topic:2 M8:1 M9:8 M10-credit-unverified:4 M10-credit-verified:2`), as printed by `pnpm gates` on 2026-08-06. The recommendation in the struck sentence was taken. What is still missing is a rule about **width** rather than about text — freezing a string stops it changing but never says it is malformed. That gap, and the rule that closes it, are [§7.9](#79-proposed-gate-rule--m11-fixed-width-hex-literals-must-have-their-fixed-width).

**Remediation direction:** owner action — this is the highest-priority M4 entry in the existing baseline and nothing changes it.

---

<a id="f14"></a>

### F14 — Service-registry beacon to a routable third-party address · **LIVE**

Ten of thirteen `application.properties` set:

```
eureka.client.serviceUrl.defaultZone=http://111.111.111.111:7000/eureka/
eureka.instance.prefer-ip-address=true
```

(`bch`, `bsv`, `ltc`, `btm`, `eos`, `xmr`, `bitcoin`, `usdt`, `eth`, `erc-token`, `erc-eusdt` at line 15 or 22; `act` and `ect` use `127.0.0.1`.) The same address appears as `spring.kafka.bootstrap-servers=111.111.111.111:9092`.

`111.111.111.111` is the upstream's redaction placeholder, and it is **a routable public address, not a documentation range**. With `prefer-ip-address=true`, a Spring Cloud Eureka client registers itself by publishing its own reachable IP and port to that registry, over plain HTTP, unauthenticated, on a repeating heartbeat.

**What an attacker gains:** whoever controls that address learns the network location and port of every process in the deployment that holds withdrawal keys, without touching the auth token that protects the endpoints. The registry is also a source the client takes instructions from.

**Remediation direction:** make the registry and broker addresses environment placeholders with no default, as the Mongo URI already is.

---

<a id="f15"></a>

### F15 — Raw node and exception text is echoed to HTTP callers · **LIVE**

Every controller in the tree ends its catch blocks with the exception message in the response body. Representative:

- `bch/.../WalletController.java:54, 72, 112, 133` — `return MessageResult.error(500,"error:" + e.getMessage());`
- `bitcoin/.../WalletController.java:35, 51, 69, 84, 100`
- `usdt/.../WalletController.java:41, 67, 108, 133, 154, 170`
- `eth/.../WalletController.java:49, 64, 80, 94, 112, 132, 155`

The committed `BitcoinRPCClient` builds its exception messages from `", params: "`, `", response header: "` and `", response: "` (string constants present in `bitcoin-rpc-1.2.0.jar`), so for the `bitcoin` and `usdt` modules this echoes the raw node response and the RPC parameter array to the caller. Elsewhere it discloses filesystem paths (`"钱包文件不存在"` paths from `WalletUtils.loadCredentials`) and internal state.

Alongside it, `e.printStackTrace()` appears on essentially every catch in the tree — to stdout, unstructured, outside the logging framework.

**What an attacker gains:** node internals and RPC call shapes, which is reconnaissance rather than access — and, on the `walletpassphrase` path if it is ever wired up ([F12](#f12)), the passphrase itself.

**Remediation direction:** return a correlation id; log the detail.

---

<a id="f16"></a>

### F16 — `erc-token` and `erc-eusdt` are the same service twice · **LIVE**

| Property               | `erc-token`       | `erc-eusdt`         |
| ---------------------- | ----------------- | ------------------- |
| `server.port`          | 7004              | **7004**            |
| `coin.name`            | EUSDT             | **EUSDT**           |
| `coin.unit`            | EUSDT             | **EUSDT**           |
| `contract.address`     | mangled Tether    | **live Tether**     |
| `coin.withdraw-wallet` | account `672881…` | account `2b7d8aa0…` |

Two modules, one port — they cannot run on one host. More consequentially, `AccountService.getCollectionName()` (`rpc-common/.../service/AccountService.java:35-37`) derives the Mongo collection from `coin.getUnit()`, so both write to `EUSDT_address_book`, and `DepositEvent` (`:28`) publishes both to the Kafka `deposit` topic under the key `EUSDT`. **Two different contracts sharing one address book and one event stream, with different hot wallets.**

`act` and `bitcoin` also both claim `server.port=7001`.

**Remediation direction:** decide which of the two modules is real and delete the other.

---

<a id="f17"></a>

### F17 — Unbounded block-replay endpoint re-emits deposit events · **LIVE**

- `eth/.../WalletController.java:159` — `@GetMapping("sync-block")` → `watcher.replayBlockInit(startBlock, endBlock)`
- `erc-eusdt/.../WalletController.java:168` and `erc-token` — same

Neither validates the range, orders the bounds, or caps the span. `replayBlockInit` loops one block at a time issuing `ethGetBlockByNumber(..., true)` per iteration, so a single request naming a range of millions of blocks is a self-inflicted denial of service against both the service and its node.

More importantly, the replay path calls `depositEvent.onConfirmed(deposit)` directly for everything it finds. The only dedupe is `DepositEvent.onConfirmed` (`rpc-common/.../event/DepositEvent.java:24-30`), which checks `depositService.exists(deposit)` against this service's own Mongo — a per-service guard with no idempotency key on the emitted Kafka message.

**What could not be determined:** whether re-emission double-credits. That depends on the consumer of the `deposit` topic, which is outside this tree and was not reviewed. The tree's own position is that it emits without an idempotency key and relies on a local existence check.

**Remediation direction:** cap the range, and put an idempotency key on the emitted event.

---

<a id="f18"></a>

### F18 — Shared static HTTP client and response across threads · **LIVE**

**Where:** `bch|bsv|ltc|btm|eos|xmr/.../util/HttpClientUtil.java:31-32`

```java
31:    private static CloseableHttpClient httpClient = null;
32:    private static CloseableHttpResponse response = null;
```

Both are reassigned by every call to `doHttpsGet`, `doHttpsPost` and `doHttpPost` (e.g. `:274`, `:295`), and both are closed in each method's `finally` (`:302-309`). The deposit `Watcher` runs on its own thread (started at `event/ApplicationEvent.java:61` — `new Thread(watcher).start()`), concurrently with Tomcat request threads calling the same static methods.

Two concurrent calls therefore close each other's connections and can read a response object that belongs to a different logical request. `doHttpGet` at `:226` is the only method that correctly uses locals.

**What an attacker gains:** nothing directly, but in a service where the HTTP response decides who is credited how much, cross-request response confusion is a correctness defect with money on the other end of it.

`btm/.../util/ClientUtils.java:9-18` has the same shape — an unsynchronised `if (client == null)` check-then-assign on a static field, so the first caller's URL and access token win permanently.

**Remediation direction:** make the client fields local, or a properly shared thread-safe connection-manager-backed singleton.

---

<a id="f19"></a>

### F19 — Committed node credentials in `main()` harnesses · **LATENT** · _known_

- `act/src/test/java/ActClientTest.java:10` — `new ActClient("http://act:123456@47.74.42.87:8900/rpc")` — a node credential and a public IP, over plain HTTP. This is item **A3** of `OWNER-ACTIONS-WALLET-RPC-SECRETS.md`, deliberately left in the tree as evidence, and frozen by the mainnet gate. Whether that node is ours is still an open owner question ~~and cannot be answered without network access~~ — **and network access is not what was missing** ([§8](#8-correction--this-host-has-network-access)). It is an ownership question, answerable from procurement records, not by probing somebody else's host. Nothing in this review probed it and nothing should.
- `usdt/src/main/java/…/config/JsonrpcClient.java:163` — `new JsonrpcClient("http://bitcoin:bitcoin@127.0.0.1:8888/")` — **this one is in `src/main`, not `src/test`**, so it compiles into the production artifact. Loopback and a trivial credential, so the value is worthless, but it is a `main()` in a shipped class that constructs a node client, and it is not covered by the `${USDT_NODE_RPC_URL}` externalisation.
- `eth-support/.../service/EtherscanApi.java:65-71` — a `main()` with a commented-out `sendRawTransaction` of a real signed transaction, plus a live txid and the real Transfer topic0.
- `ect/.../component/EctApi.java:158-176` — a comment block documenting the **removed** `main()` that held a second hardcoded wallet secret. Item **A2**; the code is gone, the value remains disclosed by history.

Latent because surefire does not run `main()` and nothing invokes these.

**Remediation direction:** owner action A3; delete the `src/main` harness.

---

<a id="f20"></a>

### F20 — A locally rebuilt, unreferenced 1.4 MB crypto library · **LATENT**

Full detail in the [jar inventory](#3-jar-inventory). The two corrections that matter to the framing this review was commissioned with:

**It is not on any classpath** — not `ltc`'s, not `xmr`'s, not any module's. No `pom.xml`, no `.classpath`, and no source file in the repository contains the string `alice`. The modules that mint keys take their crypto library from elsewhere.

**And it is not anonymous.** The archive names its builder and its origin: built by `shaox` with Maven 3.5.3 on JDK 1.8.0_181, from an Eclipse workspace at `E:\ltctest\bitcoinj-alice-master\core`, on 2019-09-15 — one day before the same person, on the same machine, built the `litecoinj` jar that **is** on `ltc`'s classpath and **does** mint `ltc` keys. That is the more useful fact, and it points at the litecoinj jar rather than away from it.

672 of its 674 entries were recompiled in 2019 and wrapped in duplicated 2015 upstream metadata. No injected package, no embedded callout — and no way to check a single class body without a JDK.

**Remediation direction:** delete it; and treat the litecoinj jar from the same workspace as needing the same attribution it never got.

---

<a id="f21"></a>

### F21 — This tree has never been compiled by anyone · **LIVE**

Two independent proofs, either sufficient:

1. `vendor/upstream-exchange/01_wallet_rpc/pom.xml:21` declares `<module>xrp</module>`. There is no `xrp` directory on disk, and no file matching `*xrp*` anywhere under the tree. Maven fails immediately on _"Child module .../xrp does not exist"_, so the reactor cannot even be resolved, let alone built.
2. `ect/.../controller/WalletController.java:7` imports `com.spark.blockchain.rpcclient.BitcoinUtil`, and `ect/pom.xml` declares no dependency that supplies it — Maven does not propagate `rpc-common`'s system-scoped `bitcoin-rpc` to consumers. An unresolvable import is a compile error whether or not the class is used. **`ect` cannot compile**, and `eth-support/pom.xml:51-57` documents the identical failure having already been hit and worked around by hand in a different module.

Neither is a vulnerability. Both are stated as findings because together they establish the central premise of this review's method section: **nothing in this tree has ever been compiled, in this repository, by anyone.** Every judgement in this document — and in every prior document about this tree — is a judgement about source that no compiler has ever checked, in a tree whose own build file names a module that does not exist.

**Remediation direction:** none from this review; whether `xrp` is restored or removed is an owner decision.

---

## 3. Jar inventory

**Eighteen `.jar` files under `01_wallet_rpc`, but only three distinct artifacts.** The framing "eighteen binaries" is technically right and materially misleading: fourteen of the eighteen are the same 68,230-byte file copied into fourteen module directories. SHA-256 confirms byte-identity within each group.

| Artifact                                | Copies | Size        | SHA-256 (abbrev.)   | On a classpath? |
| --------------------------------------- | ------ | ----------- | ------------------- | --------------- |
| `bitcoin-rpc-1.2.0.jar`                 | 14     | 68,230 B    | `19DE7854…4C030F0F` | **3 of 14**     |
| `litecoinj-core-0.15.20190219.jar`      | 2      | 1,560,079 B | `0A150406…7C454B6E` | 2 of 2          |
| `bitcoinj-core-0.13-alice-SNAPSHOT.jar` | 2      | 1,399,770 B | `82A12432…89BF1294` | **0 of 2**      |

**Repository-wide count.** 45 `.jar` files exist in the repository. 13 of those sit under a `target/` directory and are build outputs of the other vendored trees (`admin-api.jar`, `exchange.jar`, `wallet.jar`, and so on). 45 − 13 = **32 checked-in library jars repo-wide**, which is the figure the brief cites. The 18 under `01_wallet_rpc` were enumerated and opened for this review; the other 14 are outside this scope and were not examined.

### Can any of them be verified?

**No. Not one of the three can be checksum-verified against anything, and that is the honest answer for all three — not only for the `-SNAPSHOT`.** ~~There is no network on this host, so no coordinate can be checked against Maven Central;~~ there is no JDK, so `jarsigner -verify` cannot run and no class body can be decompiled or byte-compared; and none of the three ships a detached signature or a checksum file. All three archives _did_ open — a jar is a zip — so what follows is what each one says about itself.

> **Correction, 2026-08-06 — the network clause was false, and the corrected answer is worse, not better.** Maven Central _was_ queried for this addendum. `com.spark.bc:bitcoin-rpc` — the most trust-critical binary in this tree — **is not published on Maven Central at all**, so the conclusion is no longer "we had no way to check" but "we checked, and there is nothing to check it against." `org.litecoinj` is likewise absent. Full result in [§8.3](#83-what-leaned-on-it). The verdict of this section stands; only its reason changes.

#### `bitcoin-rpc-1.2.0.jar` — the most trust-critical binary in the tree

```
Manifest-Version: 1.0        META-INF/maven/com.spark.bc/bitcoin-rpc/pom.properties:
Archiver-Version: Plexus Archiver    #Fri Jul 20 14:11:53 CST 2018
Built-By: yanqizheng                 version=1.2.0
Created-By: Apache Maven 3.5.0       groupId=com.spark.bc
Build-Jdk: 1.8.0_65                  artifactId=bitcoin-rpc
```

No `Implementation-Title`, `Implementation-Version` or `Implementation-Vendor` — those fields do not exist in this manifest. 72 entries, packages `com.spark.blockchain.rpcclient` and `com.spark.blockchain.util`, providing `BitcoinRPCClient`, `BitcoinRawTxBuilder`, `BitcoinAcceptor`, `Base64Coder`. Compiled at `<source>1.6</source>`, and its own embedded pom depends on `com.alibaba:fastjson:1.2.31`.

This is the client through which `bitcoin` and `usdt` reach their nodes — it builds, signs and broadcasts raw Bitcoin transactions, and it constructs the `Authorization: Basic` header from the credential in [F2](#f2). Nothing in the tree or on this host can establish that it is what it claims to be.

**It also carries the only non-standard host embedded in any of the 18 jars** — a deploy target recorded at the vendor's build time, inside its own pom:

```xml
<distributionManagement><repository>
    <url>http://maven.xinhuokj.com/repository/maven-releases/</url>
</repository></distributionManagement>
```

Metadata only, never read from a system-scoped jar, so not a runtime callout. Recorded because it is the one third-party host name attached to the tree's most privileged binary.

**Eleven of the fourteen copies are referenced by nothing.** Only `rpc-common/pom.xml:55-60`, `bitcoin/pom.xml:53-58` and `usdt/pom.xml:41-46` wire it in with `<scope>system</scope>` and a `<systemPath>`. The copies in `lib/`, `act`, `bch`, `bsv`, `btm`, `ect`, `eos`, `erc-eusdt`, `erc-token`, `eth` and `eth-support` are dead weight.

And `ect` has the inverse problem: `ect/.../controller/WalletController.java:7` imports `com.spark.blockchain.rpcclient.BitcoinUtil`, and `ect/pom.xml` declares no `bitcoin-rpc` dependency at all. Maven does not propagate a system-scoped dependency transitively, so `rpc-common` does not supply it — **`ect` cannot compile.** `eth-support/pom.xml:51-57` carries an in-tree comment confirming this is a known, previously-hit failure mode:

> _"Maven drops rpc-common's transitive dependencies for consumers because its bitcoin-rpc entry is system-scoped with an unresolvable systemPath, so this module did not compile at all."_

#### `litecoinj-core-0.15.20190219.jar` — the library that mints `ltc` keys

```
Built-By: shaox · Apache Maven 3.5.3 · Build-Jdk 1.8.0_181
META-INF/maven/org.litecoinj/litecoinj-core/pom.properties:
  #Mon Sep 16 10:03:42 CST 2019
  version=0.15.20190219 · groupId=org.litecoinj
  m2e.projectLocation=E:\ltctest\litecoinj-master\core
```

A locally-built jar, produced from an Eclipse workspace at `E:\ltctest\` on somebody's Windows machine on 2019-09-16. It is referenced honestly and explicitly at `ltc/pom.xml:62-69` and `xmr/pom.xml:62-69` — but under **fictitious coordinates**: the pom declares `org.litecoin:litecoin-core`, while the jar's own embedded metadata says `org.litecoinj:litecoinj-core`. Harmless under system scope, where the path wins, and worth knowing because the GAV in the pom identifies nothing.

This is the crypto library that generates and stores every `ltc` private key ([F9](#f9)). Unverifiable.

#### `bitcoinj-core-0.13-alice-SNAPSHOT.jar` — attributable, and on no classpath at all

The brief describes this as _"a snapshot build of an unnamed fork, on the classpath of the two modules that mint keys."_ Both halves need correcting.

**It is not unnamed, and it is not anonymous.** The archive opens and names its builder:

```
Built-By: shaox · Apache Maven 3.5.3 · Build-Jdk 1.8.0_181
META-INF/maven/org.bitcoinj/bitcoinj-core/pom.properties:
  #Sun Sep 15 15:30:47 CST 2019
  version=0.13-alice-SNAPSHOT · groupId=org.bitcoinj
  m2e.projectLocation=E:\ltctest\bitcoinj-alice-master\core
```

Same builder, same machine, same `E:\ltctest\` workspace, one day before the litecoinj jar. "alice" is the source directory name of a fork — `bitcoinj-alice-master` — not an upstream bitcoinj release qualifier. Upstream has never published `0.13-alice-SNAPSHOT`, and `-SNAPSHOT` means the coordinate does not identify these bytes even in principle.

**It is on no classpath.** No `pom.xml`, no `.classpath`, no `.project` and no `.java` file anywhere in the repository contains the string `alice`. The two modules that hold it, `ltc` and `xmr`, take their crypto library from the litecoinj jar above via an explicit `<systemPath>` and import `org.litecoinj.*` exclusively — never `org.bitcoinj.*`. The four modules that _do_ import `org.bitcoinj.*` — `bch`, `bsv`, `btm`, `eos` — resolve it from the Maven coordinate `cash.bitcoinj:bitcoinj-core:0.14.5.2`, a third-party Bitcoin Cash fork, not from this file.

So the corrected statement is: **it is not on the classpath of the modules that mint keys, or of any module.** `bch` and `bsv` mint keys from a Maven-resolved fork; `ltc` mints keys from the litecoinj jar; `xmr` mints nothing.

**What is inside it.** 674 entries. The package inventory is clean — `org/bitcoinj/{core,crypto,params,script,store,wallet,…}` plus `org/bitcoin/{NativeSecp256k1,paymentchannel/Protos,protocols/payments/Protos}`, all of which are standard upstream bitcoinj 0.13 members. **No foreign or injected package exists in the archive.** A decompressed-content scan for URLs and IP literals found only the bundled CA/CRL endpoints in `org/bitcoinj/crypto/cacerts`, the stock upstream DNS seeds (`seed.bitnodes.io`, `bitcoin.petertodd.org`, and so on), `127.0.0.1`, and a false positive from the spongycastle version string. **No hardcoded external IP, no embedded callout.**

**What cannot be established.** 672 of the 674 entries are dated 2019-09; only 2 carry the original 2015-01 timestamps. The archive contains _duplicate_ `META-INF/maven/org.bitcoinj/bitcoinj-core/` metadata — one `pom.xml` at `2015-01-22 17:31` and one at `2019-09-15 15:30`, both 23,896 bytes — which a clean Maven build does not produce. So this is upstream 0.13 metadata wrapped around classes recompiled locally in 2019 from a fork. **Whether those recompiled class bodies differ from upstream cannot be determined without a JDK**, and the package inventory being clean says nothing about it: a one-line change inside `org.bitcoinj.core.ECKey`'s constructor adds no new class name.

**Verdict on this jar:** latent rather than live, and no less serious for it. 1.4 MB of locally rebuilt, unsigned, checksum-unverifiable crypto library, sitting in the `lib/` directories of two key-handling modules where the local convention is that `lib/` jars become system-scoped dependencies — one `<systemPath>` line away from being the code that generates private keys, and with the one property that matters, the behaviour of its `ECKey` constructor, unverified. It is the only artifact here whose honest answer to "what is this" is _nobody in this repository can say_.

---

## 4. Dependency versions and CVE surface

Only versions **written in a pom** are listed. Nothing was resolved, so transitive versions are unknown and no transitive CVE claim is made.

| Coordinate                                            | Version as literally written | Declared at                                                 |
| ----------------------------------------------------- | ---------------------------- | ----------------------------------------------------------- |
| `org.springframework.boot:spring-boot-starter-parent` | **1.5.10.RELEASE**           | `pom.xml:32-33`                                             |
| `spring-cloud-dependencies`                           | **Edgware.RELEASE**          | `pom.xml:45-46` (`${spring-cloud.version}`, `:39`)          |
| `com.alibaba:fastjson`                                | **1.2.31**                   | `pom.xml:57-58`                                             |
| `org.web3j:core`                                      | **3.3.1**                    | `pom.xml:62-63` **and again at** `:95-96` (duplicate entry) |
| `cash.bitcoinj:bitcoinj-core`                         | **0.14.5.2**                 | inline in `bch`, `bsv`, `btm`, `eos` (`pom.xml:17-19`)      |
| `org.litecoin:litecoin-core` (system jar)             | **0.15.20190219**            | `ltc                                                        | xmr/pom.xml:62-69` — GAV does not match the jar |
| `com.spark.bc:bitcoin-rpc` (system jar)               | **1.2.0**                    | `pom.xml:76-82`                                             |
| `com.github.briandilley.jsonrpc4j:jsonrpc4j`          | **1.4.6**                    | inline in 11 modules                                        |
| `com.mashape.unirest:unirest-java`                    | **1.4.9**                    | `pom.xml:100-101`; **no version** in `ect`                  |
| `org.apache.commons:commons-lang3`                    | **3.4**                      | `pom.xml:38` (`${commons-lang3.version}`)                   |
| `org.projectlombok:lombok`                            | **1.16.20**                  | `pom.xml:72-74`                                             |
| `spring-boot-devtools`                                | **1.5.9.RELEASE**            | `pom.xml:67-68`                                             |
| `io.reactivex:rxjava`                                 | **1.3.4**                    | inline in `eth`, `act`, `ect`, `erc-token`, `erc-eusdt`     |
| `com.google.guava:guava`                              | **16.0.1**                   | inline in `ltc`, `xmr`                                      |
| `com.google.protobuf:protobuf-java`                   | **2.5.0**                    | inline in `ltc`, `xmr`                                      |
| `com.madgag.spongycastle:core`                        | **1.51.0.0**                 | inline in `ltc`, `xmr`                                      |
| `com.lambdaworks:scrypt`                              | **1.4.0**                    | inline in `ltc`, `xmr`                                      |
| `io.bytom:bytom-sdk-java`                             | **1.0.2**                    | inline in `btm`                                             |
| Jackson                                               | **not stated in any pom**    | inherited from the Boot 1.5.10 BOM                          |
| Mongo driver                                          | **not stated in any pom**    | inherited from the Boot 1.5.10 BOM                          |
| Kafka client                                          | **not stated in any pom**    | inherited from the Boot 1.5.10 BOM                          |
| `commons-codec`                                       | **not stated in any pom**    | inherited; declared without a version in `act`, `ect`       |

Java source/target is `1.8` in every module that sets it. `bitcoin/pom.xml` is the only module that never configures `maven-compiler-plugin` at all, so its Java level is not stated. `erc-token` and `erc-eusdt` version themselves with `${parent.version}`, a deprecated Maven 2 expression; it resolves, but it is a latent portability issue. **No `<repository>` or `<pluginRepository>` is declared anywhere in the reactor** — every non-system dependency must come from Maven Central.

**What can be said honestly about this set:**

- **fastjson 1.2.31** is the one that matters, and it matters because of [F8](#f8). It predates the 1.2.48 `checkAutoType` rewrite and sits inside the autotype-bypass series that began with CVE-2017-18349. The tree never enables autotype explicitly, and all parsing is `parseObject(String)` — the least-exposed form. Whether a usable gadget is on the runtime classpath is **unknown**, because that needs `mvn dependency:tree`.
- **Spring Boot 1.5.10.RELEASE** (Jan 2018) is long past end of life and pulls Spring Framework 4.3.x, a line with published advisories including CVE-2018-1270, CVE-2018-1271, CVE-2018-1272 and CVE-2018-15756. **This review does not assert any of these is reachable here** — reachability depends on which starters resolve, which is exactly what could not be determined. The honest statement is: the platform is eight years unmaintained and its transitive set was never enumerated.
- **`spring-boot-devtools`** appearing in `dependencyManagement` is worth a second look by whoever resolves the tree: devtools ships a remote-restart endpoint that is a remote code execution primitive when enabled. It is version-managed here, not necessarily depended on; no module's direct dependency on it was found, but the transitive set is unknown.
- **web3j 3.3.1** (2018) is the library whose `Credentials` accessors [F3](#f3) depends on. It has now been opened — note that the two classes live in `org.web3j:crypto`, which arrives transitively, not in the `core` artifact this table pins. See the [F3 follow-up of 2026-08-06](#f3-2026-08-06).
- **`cash.bitcoinj:bitcoinj-core:0.14.5.2`** is a third-party fork of bitcoinj under a groupId that is not `org.bitcoinj`. Whether that coordinate resolves to a public artifact, who publishes it, and what its checksum is are all **unverified** — it is a Maven-resolved dependency in the four modules that generate or handle Bitcoin-family keys, and it deserves the same scrutiny as the committed jars.

---

## 5. What this review does **not** cover

Stated plainly, because a review's boundary is part of its result.

1. **Anything dynamic.** No compilation, no execution, no tests, no fuzzing, no runtime observation. No JDK, JRE or Maven on `PATH` in any session that has written to this document. Every finding is static. (This clause is correct as written. The separate claim that there is **no network** was not — see [§8](#8-correction--this-host-has-network-access).)
2. **The transitive dependency graph.** Never enumerated. All CVE discussion is limited to directly declared versions, and no claim of reachability is made for any advisory.
3. **The class bodies of the committed `.jar`s.** All three distinct archives in the tree were opened and their manifests, embedded coordinates and package inventories read — see [§3](#3-jar-inventory). None was checksum-verified against a published artifact, and **no committed class body was compared to upstream**. A modification inside an existing method is invisible to everything this review could do.

   **Amended 2026-08-06.** "That needs a JDK" was wrong, and correcting it is the most transferable thing in this document. A `.class` file's constant pool, access flags, member tables and `Code` attribute parse out of the bytes with no JVM involved, which is how the fastjson chain and then the [web3j accessor chain](#f3-2026-08-06) were both read. This does **not** retroactively cover the three committed jars — nobody has done that read on them — but it removes the stated reason for not doing it. `bitcoin-rpc-1.2.0.jar` is the one that would pay for itself: it would settle the unresolved `logger.info("client={}",client)` question in [F2](#f2), which is currently frozen on the pessimistic reading precisely because "its superclass lives in a committed jar that cannot be decompiled without a JDK."

4. **Any deployed environment.** Every `${VAR}` value is unknown, including whether `WALLET_RPC_AUTH_TOKEN` is shared across services — which decides the blast radius of [F5](#f5).
5. **Filesystem and container posture.** Permissions on `/data/*/​*.wallet` and `/data/eth/data/keystore`, backup policy, log retention, and who can read stdout — the last of which is what turns [F1](#f1), [F2](#f2) and [F3](#f3) from findings into losses.
6. **Downstream consumers.** The Kafka `deposit` and `withdraw-notify` consumers were not reviewed, so the money impact of [F17](#f17) is stated as a dependency, not a conclusion.
7. **The chains and nodes themselves.** No balance was checked at any address named here, and whether the node at `47.74.42.87` is ours ([F19](#f19)) is still open.
8. **Cryptographic implementation.** `new ECKey()`'s entropy is delegated to the library's `SecureRandom`. For `bch` and `bsv` that library is a Maven-resolved third-party fork (`cash.bitcoinj`) that was never resolved or inspected; for `ltc` it is a jar built on one person's Windows machine in 2019 whose class bodies could not be read ([§3](#3-jar-inventory)). If either RNG were weakened, every key those three modules have ever minted would be predictable, and **nothing in this review would have detected it.**
9. **The other 14 checked-in jars** outside `01_wallet_rpc`, and the 13 build outputs under `target/`.
10. **The rest of the vendored exchange.** This review covers `01_wallet_rpc` only. The brief's figure of 878 Java files repo-wide means roughly 74% of the vendored tree remains unread.

---

## 6. Verdict

**No. This tree must not be pointed at real value in its current state, and no amount of configuration makes it safe.**

The three findings this review was commissioned to confirm are all real, and all three are confirmed with the exact call paths ([F4](#f4), [F13](#f13)). But they are not the reason for the verdict, because each is at least arguably a configuration problem — a hardcoded URL, a missing argument, a contract address.

The reason for the verdict is that **three separate services write a live spending credential to a log sink on an ordinary success path**:

- `eth-support` writes the ETH hot-wallet **private key** to the log every thirty seconds, up to a hundred times per withdrawal ([F3](#f3)) — **confirmed 2026-08-06, and the worst of the three, because a private key is the one credential here that cannot be rotated**
- `ect` prints the withdrawal signing secret on every withdrawal ([F1](#f1))
- `bitcoin`, `usdt` and `act` print node RPC credentials at startup ([F2](#f2))

Those are not settings. They are code, on the happy path, and they mean that in this tree **the security boundary of the hot wallets is the read permission on the log files**. Anyone who can read logs — an operator, an aggregator, a backup, a support engineer, a compromised sidecar — can drain them. Rotating the secrets identified in `OWNER-ACTIONS-WALLET-RPC-SECRETS.md` does not help: the code prints the _replacement_ just as freely as the original.

Underneath that sit two structural properties that no fix to individual lines will change:

**The authorization model is one bit.** One static shared token, sent as a plain header, gates everything from reading a block height to sweeping the entire float to an arbitrary address in a single HTTP GET ([F5](#f5)). There is no destination allowlist, no cap, no second approval, no idempotency. That is not a wallet service; it is a remote control with a password on it.

**And the deposit side trusts what it should verify.** Success checks are absent or commented out ([F6](#f6)), the function selector is never checked ([F7](#f7)), the transport that carries the deposit truth trusts every certificate presented to it and hands the result to a known-vulnerable parser ([F8](#f8)), and the only reason the ERC modules are not currently minting free credit is that somebody mangled a constant ([F6](#f6)). A control that works because a typo points the safe way is not a control.

**On "point it at a testnet."** That option does not exist for this tree, and this review confirms why with the code rather than by assertion. Withdrawals are signed without a chain id ([F4](#f4)), so a testnet-signed transaction is a valid mainnet transaction, and the same transaction is then broadcast a second time to a hardcoded mainnet Etherscan endpoint by a bean that is defined unconditionally ([F4](#f4)). The mainnet copy is the one that lands.

**What this verdict is not.** It is not a claim that the tree is unfixable, and it is not a finding count. Several of these are three-line changes. The claim is narrower and firmer: **the current state is not a starting point that a custody decision can rest on**, because the same reading that found the known criticals also found that a service prints its own hot-wallet key — and that finding was in a file that four previous documents about this tree had cited without opening.

~~The one thing that should be treated as more urgent than the rest of this document: **[F3](#f3) rests on an inference about two libraries this host could not open.** Confirming or refuting it takes minutes on a machine with a JDK, and it is the difference between "the ETH hot-wallet key is in the logs" and "it is not." Nothing else here changes as much on one check.~~

**Resolved 2026-08-06 — and it resolved the wrong way.** Both libraries have now been read, neither needed a JDK, and the answer is that **the ETH hot-wallet key is in the logs.** Every link is read rather than assumed: fastjson walks the getters and recurses, `Credentials.getEcKeyPair()` and `ECKeyPair.getPrivateKey()` are public no-arg getters over non-transient unannotated fields, and `BigInteger` is on fastjson's keep-verbatim list so the key is not dropped on the way out. See the [F3 follow-up](#f3-2026-08-06).

That does not change this verdict; it removes the last reason to hope the verdict was too harsh. ~~The one open item left on F3 is not the behaviour but the **provenance of the jar**~~ — **that item is closed. The `.sha1` was fetched from Maven Central the same day and it matches ([gap-closed note](#f3-2026-08-06), [§8.3](#83-what-leaned-on-it)); F3 now carries no conditional of any kind.** What remains open is the same bytecode read on `bitcoin-rpc-1.2.0.jar`, which is the most privileged binary in the tree, is still unread inside, and — per [§8.3](#83-what-leaned-on-it) — **is not published on Maven Central at all**, so no checksum comparison exists to close it the same way.

---

## 7. Fixed-width hex constant audit (addendum, 2026-08-06)

### 7.1 Why this section exists

[F6](#f6) records that `contract.event-topic0` is wrong in both erc modules. The part worth stopping on is that **each is missing a different digit**: `erc-token` drops the `a` at index 36, `erc-eusdt` drops the `6` at index 47. A bad copy is wrong the same way twice. Two independent corruptions of one canonical constant means the value was **typed**, not copied.

And the tree contains the proof. The correct, unmangled, 64-digit ERC-20 `Transfer` topic0 is sitting in this same repository at `eth-support/.../EtherscanApi.java:80`, inside a `main()` harness, in the argument list of a `checkEventLog` call — the very method the two mangled properties feed. Whoever wrote those properties files had the right answer in the same file as the method that consumes their wrong one, and did not copy it.

That makes every other fixed-width hex constant in this tree suspect until it has been measured. This section measures all of them. It is an inventory. **Nothing was fixed**, for the reason [F6](#f6) and the `M4-topic` baseline entries already give at length: several of these are load-bearing in a direction that makes correcting them a behaviour change needing a JDK build and a deposit fixture.

### 7.2 Method

Every file under the tree was scanned — 228 `.java`, 13 `.properties`, 20 `.xml`, 15 `.classpath`, 15 `.project`, 47 `.prefs`, 16 `.gitignore` — for `0x`-prefixed hex literals and for bare hex runs of eight digits or more. Each hit was tested three ways:

1. **Width** against the width its role requires — address 40, topic/hash/digest 64, private key 64, public key 128 or 130.
2. **EIP-55 checksum**, where the literal is a 40-digit address written in mixed case.
3. **Equality with the canonical value**, where the constant is a well-known one, plus a single-edit-distance test against those canonicals so a near-miss is named rather than merely counted.

keccak-256 was implemented locally for this addendum rather than quoting canonical values from memory, and validated against the published `keccak256("")` before use. The `Transfer` topic0, the `Approval` topic0 and the `transfer(address,uint256)` selector quoted below were all derived, not recalled.

Static, like the rest of this review. Nothing was compiled or run.

### 7.3 The population, and the shape of the result

**Thirteen distinct fixed-width hex constants exist in the tree, across fourteen sites.** Seven are in `.properties`. Six are in `.java`.

| Where         | Constants | Malformed | Well-formed |
| ------------- | --------- | --------- | ----------- |
| `.properties` | 7         | **7**     | 0           |
| `.java`       | 6         | 0         | 6           |
| IDE metadata  | 0         | —         | —           |
| **Total**     | **13**    | **7**     | **6**       |

**Every malformed constant is in a properties file. Every hex constant in the Java is correct. All seven defects are exactly one digit short — none is long, none is a substitution, none is a transposition.**

That is a provenance result as much as a correctness one. The Java constants look like the residue of a system that worked: the txid, contract address and topic0 in `EtherscanApi.main()` are a coherent Etherscan query somebody actually ran, and they are internally consistent. The properties were retyped for publication, by hand, one digit at a time, and the hand slipped seven times.

### 7.4 The seven malformed constants

> **Status, 2026-08-06 (PR `fix/wallet-rpc-fail-open-constants`): six, not seven.** H4 — the only one of the seven that failed OPEN — is corrected. The other six are unchanged, still frozen, and now also reported as malformed on every gate run by rule M11. See [§7.11](#711-what-landed-h4-corrected-and-m11-built).

All seven are one hex digit short. All seven are already frozen by exact text in `tooling/ci/wallet-rpc-mainnet-scan.mjs`, so none can change silently — see [§7.9](#79-gate-rule--m11-fixed-width-hex-literals-must-have-their-fixed-width) for what freezing does and does not buy.

Ranked by what happens today if somebody "fixes" it.

| #      | Where                                     | Role                           | Digits    | What it should be                                                                            | Live? |
| ------ | ----------------------------------------- | ------------------------------ | --------- | -------------------------------------------------------------------------------------------- | ----- |
| H1     | `erc-token/.../application.properties:51` | ERC-20 `Transfer` topic0       | **63**/64 | canonical topic0; missing the `a` at index 36                                                | LIVE  |
| H2     | `erc-eusdt/.../application.properties:72` | ERC-20 `Transfer` topic0       | **63**/64 | canonical topic0; missing the `6` at index 47                                                | LIVE  |
| H3     | `erc-token/.../application.properties:39` | ERC-20 contract address        | **39**/40 | mainnet Tether; missing the `a` at index 16                                                  | LIVE  |
| ~~H4~~ | ~~`eth/.../application.properties:39`~~   | ~~`coin.ignore-from-address`~~ | **FIXED** | **corrected to the 40-digit account — [§7.11](#711-what-landed-h4-corrected-and-m11-built)** | —     |
| H5     | `eth/.../application.properties:35`       | keystore account               | **39**/40 | the same hot wallet; missing the `1` at index 16                                             | LIVE  |
| H6     | `erc-token/.../application.properties:32` | keystore account               | **39**/40 | the same hot wallet again; missing the `3` at index 10                                       | LIVE  |
| H7     | `erc-eusdt/.../application.properties:32` | keystore account               | **39**/40 | **unknown** — a different account, one sample, unrecoverable                                 | LIVE  |

"LIVE" carries the meaning [§1.3](#13-live-vs-latent) gives it: reachable the first time somebody supplies the environment and starts the service.

#### What each one does today — and which way it fails

**H1, H2 — the topic0s. They fail CLOSED, and that is the whole problem with them.**

`contract.event-topic0` binds to `Contract.eventTopic0` (`rpc-common/.../entity/Contract.java`), which `TokenWatcher` reads before calling `EtherscanApi.checkEventLog`. A topic0 is a 32-byte keccak hash. A 63-digit value cannot equal any log topic that has ever been emitted, so `checkEventLog` returns false, `continue` fires, and **neither erc module credits any deposit at all.** Today that means no fake deposits — and no real ones. Correcting either constant activates a Transfer-log check that has never executed once, in the crediting path of a watcher whose receipt-status check is commented out ([F6](#f6)) and which never compares a function selector ([F7](#f7)). The correct value is the right end state and reaching it is a behaviour change, not a typo fix. Setting the property empty is strictly worse than leaving it wrong: `StringUtils.isNotEmpty` then skips the check entirely.

**H3 — the mangled Tether address. It fails CLOSED, and it is the single most dangerous line in this table.** `erc-token` cannot address a contract at 39 digits, so it watches nothing and transfers nothing. The one-character edit that makes it well-formed makes it **the live Ethereum mainnet Tether contract**, and turns the module into a real USDT mover. Its `erc-eusdt` twin, which carried this same address unmangled and correct, has since been replaced by a placeholder for exactly this reason ([F13](#f13)) — replaced rather than mangled, because a mangled literal's only defence is that nobody tidies it up.

**H4 — `coin.ignore-from-address`. This is the one that fails OPEN, and it is not [F6](#f6).**

```java
// eth/.../component/EthWatcher.java
48:  if (StringUtils.isNotEmpty(transaction.getTo())
49:          && accountService.isAddressExist(transaction.getTo())
50:          && !transaction.getFrom().equalsIgnoreCase(getCoin().getIgnoreFromAddress())) {
```

The property binds to `Coin.ignoreFromAddress`, and the account it names is the platform's **own withdrawal wallet** — the same account `coin.withdraw-wallet` loads a keystore for, and the same account `EthService.transferFromWithdrawWallet` (`:106-107`) signs every ETH withdrawal from. The clause exists to stop money the platform sends _out_ from being read back as money a customer sent _in_.

Because the configured value is 39 digits, it can never equal a `from` address returned by a node, which always has 40. **The exclusion never matches, so line 50 is always true and the filter never excludes anything.**

The routine way that costs money: a customer withdraws to an address that is also a watched deposit address — their own deposit address on this same platform, which people do constantly. `from` is the hot wallet, `to` is watched, `isAddressExist` returns true, and the withdrawal is **credited straight back to them as a fresh deposit.** No attacker required. The same happens to any operational top-up sent from the hot wallet to a deposit address.

H1, H2, H3, H5, H6 and H7 all break something that was _preventing_ an action. **H4 breaks something that was preventing a credit**, which is why it is listed separately from the fail-closed six. It is also the only one of the seven where correcting the constant is unambiguously safe: restoring the 40th digit can cause strictly fewer credits, never more, and it needs no fixture to prove that.

**H5, H6 — keystore filenames.** `coin.withdraw-wallet` names a go-ethereum keystore file to load from `coin.keystore-path`. A 39-digit account means the filename does not exist on disk, `WalletUtils.loadCredentials` throws, and the withdrawal path fails at startup or first use with a filesystem path in the error message ([F15](#f15)). Fails closed: no withdrawals, rather than withdrawals from the wrong account.

**H7 — the `erc-eusdt` keystore account.** Same failure mode as H5/H6, and the only one of the seven whose correct value **cannot be recovered from this repository.** See below.

### 7.5 The mangling is one deleted digit, and it is reversible

H4, H5 and H6 name the same Ethereum account, mangled at three different indices. Deleting one digit is lossy — a 39-digit string has 40 possible 40-digit sources — but three independent samples of one string intersect at exactly one candidate:

```
T  = 0x672881426632b13d18f474664c039acc7b5610b7      (40 digits)

eth/…:35        keystore  = T minus index 16  (the '1')
eth/…:39        ignore-from = T minus index 19  (the '4')
erc-token/…:32  keystore  = T minus index 10  (the '3')
```

Each of the three is exactly `T` with one character removed, and no other 40-digit string satisfies all three. **The upstream's redaction is not a redaction.** The platform's own Ethereum hot-wallet account — the one [F3](#f3) is about, the one `eth` and `erc-token` both draw withdrawals from — is recoverable from this repository by anyone who notices that three lines name one address three different ways.

This discloses no key. An EVM address is public by construction and its balance is public whether or not a properties file names it. What it discloses is **which** account, to anyone reading the repo, without them needing to already know — and it establishes that the same one-digit-deletion technique was applied to the other four, which is the part that generalises.

Six of the seven are therefore recoverable: H1, H2 and H3 because the canonical value is known, and H4, H5, H6 by the intersection above. **H7 is the exception.** It appears once, so it has 40 deletion positions × 16 possible digits = 640 candidates and nothing to choose between them. It is a different account from `T`, and this repository cannot say which.

### 7.6 What the audit did not find

The negative results carry as much weight as the positive ones, because three of them are the confirming half of findings this review states from the other side.

- **No function selector constant exists anywhere in the tree.** `a9059cbb`, `095ea7b3`, `23b872dd`, `70a08231`, `18160ddd`, `dd62ed3e` — none appears in any of the 228 Java files or 13 properties files. This is the positive confirmation of [F7](#f7): the token watcher does not fail to compare the selector correctly, it has **no selector constant to compare against at all**. Fixing F7 means introducing a constant, not correcting one.
- **No chain id exists anywhere**, in Java or in configuration. The configuration-side confirmation of [F4](#f4).
- **No private key and no public key.** No 64-hex secp256k1 private key, no 128- or 130-digit public key. The only 64-hex value resembling a secret is a SHA-256 digest that is a digest on purpose (below).
- **Not one address in the tree is written in mixed case.** There are six EVM address literals — five in properties (`erc-token:32`, `erc-token:39`, `erc-eusdt:32`, `eth:35`, `eth:39`) and one in Java (`EtherscanApi.java:80`) — and all six are entirely lowercase. **EIP-55 is therefore unavailable as a check on every single address in this tree**: six of six are valid but unverifiable. This matters more than it reads: EIP-55 exists precisely to catch a mistyped address, and writing addresses in a single case discards it everywhere. It would not have caught these seven — a 39-digit string is not a checksummable address, and length is what catches a deletion — but the two checks are complementary, not redundant: length catches insertions and deletions, EIP-55 catches substitutions and transpositions, and this tree currently has neither.
- **No hex constants in IDE metadata.** The 47 `.prefs`, 15 `.classpath` and 15 `.project` files are clean.

#### The six well-formed hex constants, and the one whose correctness is load-bearing

| Where                                                          | Value                                             | Role                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `eth-support/.../EtherscanApi.java:80`                         | `0xddf252ad…523b3ef` (64)                         | **the canonical `Transfer` topic0** — correct, and the proof H1/H2 were typed |
| `eth-support/.../EtherscanApi.java:80`                         | `0x0b42c73446e4090a7c1db8ac00ad46a38ccbc2ac` (40) | a mainnet contract address; frozen under `M8`                                 |
| `eth-support/.../EtherscanApi.java:79`                         | `0x4d95cdb7…58129c97` (64)                        | a mainnet txid, in the same `main()` harness                                  |
| `eth-support/.../EthService.java:251`                          | `0x0000…0000` (64)                                | the zero block hash, in `isTransactionSuccess`                                |
| `btm/.../Watcher.java:104`, `btm/.../WalletController.java:93` | `ffff…ffff` (64)                                  | the Bytom native BTM asset id — correct, and it gates a deposit credit        |
| `ect/.../EctWithdrawSecretConfig.java:48`                      | `feafc645…2c7dd89b` (64)                          | **repo-authored SHA-256 — and the only fail-OPEN constant here**              |

The last row is the sharpest argument in this section, and it is about **our** code, not the vendor's.

`EctWithdrawSecretConfig` is the guard this repository added so that a service refuses to boot on the ECT withdrawal secret that git history has already disclosed ([F1](#f1)). It works by comparing a stored digest against a freshly computed one:

> The value is elided here. It is a SHA-256 of a _known-disclosed_ secret, so it is not itself
> a credential — but quoting it in full copies a 64-hex literal out of the vendor tree into
> `docs/`, where gitleaks’ `vendor/` exemption does not reach. That is the third time a gate or
> a document has tripped this by freezing a constant into our own source. **What matters here is
> the width, not the value.**

```java
48:    private static final String DISCLOSED_SECRET_SHA256 =
49:            "feafc645… 2c7dd89b";   // elided — 64 digits; see the width note below
...
61:        if (DISCLOSED_SECRET_SHA256.equals(sha256Hex(withdrawWalletSecret.trim()))) {
```

It is 64 digits today and it is correct. **Drop one digit from it and it can never equal any SHA-256 hex string.** The comparison silently becomes permanently false, the "you have pasted the disclosed secret back in" check stops firing, and the service boots happily on the compromised key that signs every ECT withdrawal — with no error, no log line, and a green test suite, because nothing asserts the digest's width.

Every one of the seven vendor defects fails closed or, in H4's case, breaks an exclusion. This one would fail open, straight into the exact scenario the class was written to prevent. It is the reason the gate rule below is worth building rather than filing.

### 7.7 Non-hex constants: heights, ports, gas, intervals

Same transcription risk, different alphabet.

**Three pinned mainnet start heights are bound to nothing.** `coin.init-block-height` (`usdt:34` = 592417, `ect:13` = 39610, `eth:33` = 8336120) and `coin.step` (`usdt:33`, `eth:34`) are bound by `@ConfigurationProperties(prefix = "coin")` to the `Coin` entity — which has **no `initBlockHeight` field and no `step` field**. `CoinConfig` leaves `ignoreUnknownFields` at its default of `true`, so these are silently discarded: the identical mechanism [F12](#f12) documents for `coin.password`. The watcher's start height comes from `WatcherSetting` (prefix `watcher`), whose `initBlockHeight` defaults to the string `"latest"`.

`eth` also sets `watcher.init-block-height=8347300`, which does bind, so `eth` is unaffected. **`usdt` and `ect` set no `watcher.*` properties at all**, so both begin scanning at the chain tip rather than at the height their own file names. Fail direction: every deposit between the pinned height and first boot is never seen. The module **loses** deposits; it does not invent them. Fails closed. Worth recording because the summary in [F13](#f13) counts "thirteen mainnet start heights" as live constants and two of them are read by nothing. The frozen baseline is still right to freeze them — an inert constant is one binding fix from being live — but they should be understood as inert.

**Heights are otherwise all plausible.** Every `watcher.init-block-height` sits where its chain actually was in August–September 2019, consistent with the `2019-08-13` and `2019-09-11` timestamps in the keystore filenames in the same files: BTC 592417, ETH 8347300 and 8551979, BCH 600000, BSV 600350, LTC 1703228, XMR 1926300, BTM 334504, EOS 79953165, ECT 39610. No factor-of-ten slip, no transposition landing in the wrong era.

**`bitcoin` pins no start height at all**, and no `watcher.*` of any kind, so it inherits `"latest"` plus the 5000 ms / step 5 / confirmation 3 defaults. `BitcoinWatcher` is still started — `rpc-common`'s `ApplicationEvent` autowires `Watcher` with `required = false` and the shared package is component-scanned — so this is a gap rather than a defect: starting at the tip is the safe default, and starting at block 1 (which `Watcher.currentBlockHeight = 0L` would have meant) is the outcome the `"latest"` branch avoids.

**`contract.gas-limit=50000`** in both erc modules is below what an ERC-20 `transfer()` costs when it writes a recipient's balance slot from zero to non-zero — around 60,000 gas for USDT, against roughly 41,000–46,000 for a recipient who already holds a balance. Fail direction: the withdrawal reverts out of gas, the gas is spent, no tokens move, and because `PaymentHandler` does check receipt status on the **withdrawal** path (unlike the deposit path), the failure is at least visible. Latent — the module cannot boot. Flagged as implausible, not as a transcription error.

**`eth`'s `coin.gas-limit=40000`** against a 21,000-gas plain ether transfer is ample. **Intervals** are unremarkable: 20,000 ms everywhere except `eth` at 5,000 and `xmr` at 300,000. `eos` is the only module whose `confirmation=200` / `step=100` pair looks tuned rather than copied, and it is consistent with EOS block times. **Ports collide twice**, as [F16](#f16) records: 7001 (`act`, `bitcoin`) and 7004 (`erc-token`, `erc-eusdt`) — eleven distinct ports for thirteen services.

### 7.8 What the existing gates already do, and the three things they do not

All seven malformed constants are frozen today, by exact text, under `M4-address`, `M4-keystore`, `M4-topic` and `M8`. That is real coverage and it was not there when this review was written. Freezing means none of the seven can be corrected, deleted or re-pointed without a human reading the paragraph attached to it — which, for H1 and H2 especially, is the correct control.

Three gaps remain, and they are not gaps in the baseline, they are gaps in what the **rules** assert:

1. **No rule anywhere checks a width.** The baseline pins text; text-pinning stops change, it never says a value is malformed. `KEYSTORE_FILENAME` is `/^UTC--[0-9T:.\-]+Z?--[0-9a-fA-F]{38,40}(\.json)?$/` — it **actively tolerates 38 to 40 digits**, so a keystore account is recognised as well-formed at three different lengths. `classifyAddress` describes a short address as "EVM-shaped but short — a mangled/redacted address literal", which is a message, not a verdict. Only `classifyTopic` genuinely checks a width, and only for topics.
2. **The scope is one vendor tree.** The same defect class in `packages/`, `services/` or the other vendored trees is entirely unguarded — and those modules can actually boot.
3. **The one fail-open constant in the tree is repo-authored and unprotected.** `DISCLOSED_SECRET_SHA256` ([§7.6](#76-what-the-audit-did-not-find)) is not an address, not a topic, and not in any baseline. Nothing asserts it is 64 characters long.

### 7.9 Gate rule — M11: fixed-width hex literals must have their fixed width

> **Implemented 2026-08-06**, in `tooling/ci/wallet-rpc-mainnet-scan.mjs`, substantially as specified below. What shipped and what did not: [§7.11](#711-what-landed-h4-corrected-and-m11-built).

~~**Proposed, not implemented.**~~ Sketched to the shape of the existing rules in `tooling/ci/wallet-rpc-mainnet-scan.mjs` so it can be built without redesign.

**M11.** A hex literal occupying a role with a fixed width must have that width. Roles are inferred from position, and only these are claimed:

| Role                             | Detected by                                                                               | Required digits |
| -------------------------------- | ----------------------------------------------------------------------------------------- | --------------- |
| EVM address                      | `0x` literal under a properties key ending `address`; bare `0x` literal in an address arg | 40              |
| go-ethereum keystore account     | the digit run after the second `--` in a `UTC--…--…` filename                             | 40              |
| event topic, tx hash, block hash | `0x` literal under a key matching `topic\d+$`; Java literal named `txid`/`hash`/`topic`   | 64              |
| SHA-256 / keccak digest constant | Java `static final String` whose name matches `SHA256`/`KECCAK`/`DIGEST`                  | 64              |
| secp256k1 private key            | any identifier matching `privateKey`/`privkey`                                            | 64              |
| secp256k1 public key             | any identifier matching `publicKey`/`pubkey`                                              | 128 or 130      |

A literal in one of these roles at the wrong width fails, and the message states observed width, required width and the signed delta. **A delta of exactly ±1 is reported as `TRANSCRIPTION` rather than `MALFORMED`** — off-by-one is this class's signature and deserves its own word.

Two supporting clauses, both of which do more work than the bare length check:

**M11-known.** A literal within one deletion, insertion or substitution of a canonical constant the gate knows — the ERC-20 `Transfer` and `Approval` topic0s, the standard ERC-20 selectors, the zero address, the zero word — fails and **names the canonical value it is near, and the index of the edit**. This is what turns "63 digits" into "the `Transfer` topic0 with the `a` at index 36 removed", which is the sentence that makes a finding actionable rather than merely alarming. Near-miss detection is the real rule; the width check is the case of it that needs no dictionary. It is also what would have caught H3 as _Tether_ rather than as _some short address_.

**M11-checksum.** A 40-digit address in mixed case must satisfy EIP-55. An address in a single case is accepted, and the line reads `checksum unavailable — single-case literal`, so the count of unverifiable addresses is printed on every run instead of being a thing nobody measured. That count is currently **six of six**, and [§7.6](#76-what-the-audit-did-not-find) is the first document to say so.

**Interaction with the baseline — the part most likely to be got wrong.** M11 must run **before** the freeze check, and being frozen must **not** suppress it. Freezing the seven is right; it is also a different claim from well-formedness, and the gate currently only makes the first. M11 should print all seven every run as _known malformed, frozen deliberately, see §F6 and §7.4_ — a standing visible count rather than silence. A gate that reads a value and says nothing about it is how the second mangled topic0 sat beside the first without anyone noticing they were mangled differently.

**Scope and sequence.** Land it inside the wallet tree, where the baseline already exists and the seven known failures give it immediate proof-of-life — the same argument the `M8` entry makes for itself. Then lift M11 to a repo-wide gate: the class is not vendor-specific, `packages/ledger-client` and the `svc-*` services will acquire EVM constants, and there the failure mode is worse because those modules boot.

**Cost.** A regex sweep over roughly 330 files plus a keccak-256 implementation of about sixty lines. Comfortably inside the ~2 s budget the other fourteen doctrine gates share.

**What it would have caught:** all seven, on the commit that introduced them — and, going forward, a single dropped digit in `DISCLOSED_SECRET_SHA256`, which is the one that fails open.

### 7.10 What this changes in the verdict

Nothing. [§6](#6-verdict) stands exactly as written. Not one of these seven makes the tree safer or more dangerous than a service that prints its own hot-wallet key on the happy path.

Two things it does sharpen. First, [§6](#6-verdict)'s line that _"the only reason the ERC modules are not currently minting free credit is that somebody mangled a constant"_ is now measurable rather than rhetorical: **seven constants were mangled, six of them the same way, by the same hand, and in six of the seven cases the accident points the safe way.** H4 is the counter-example that keeps this from being a comfortable story — one of the seven mangled a value whose job was to _prevent_ a credit, and broke it open.

Second, this is the class of defect that argues hardest against adopting the tree by inspection. Seven single-character errors in thirteen constants is a 54% defect rate in the one part of a codebase that can be checked mechanically, exhaustively, and without a compiler. The 228 Java files cannot be checked that way, and nothing about this result suggests the hand that typed them was steadier.

### 7.11 What landed — H4 corrected, and M11 built

_Addendum, 2026-08-06, PR `fix/wallet-rpc-fail-open-constants`._

**H4 is corrected.** `coin.ignore-from-address` in `eth/src/main/resources/application.properties` now carries forty digits. The path was re-verified end to end before the edit rather than taken from [§7.4](#74-the-seven-malformed-constants): the property binds through `CoinConfig#getCoin` (`@ConfigurationProperties(prefix = "coin")`) to `Coin.ignoreFromAddress`, which **does** exist as a field — unlike `coin.password`, `coin.init-block-height` and `coin.step`, which [F12](#f12) and [§7.7](#77-non-hex-constants-heights-ports-gas-intervals) record as binding to nothing. `ApplicationEvent:54` calls `watcher.setCoin(coin)`, and `EthWatcher` reads it at `:50` (scheduled) and `:95` (replay). The comparison is `String.equalsIgnoreCase`, so case is handled and the `0x` prefix is required and present; there is no trim on either side.

**The address was derived, not copied.** The three 39-digit samples were read out of the files and the set of 40-digit strings from which each is one deletion was intersected:

| Sample                      | Digits | Distinct 40-digit supersequences |
| --------------------------- | ------ | -------------------------------- |
| `eth:35` keystore           | 39     | 601                              |
| `eth:39` ignore-from        | 39     | 601                              |
| `erc-token:32` keystore     | 39     | 601                              |
| **intersection, all three** | —      | **1**                            |

`T = 0x672881426632b13d18f474664c039acc7b5610b7`, with the deletions at indices 16, 19 and 10 respectively — reproducing [§7.5](#75-the-mangling-is-one-deleted-digit-and-it-is-reversible) exactly, from the files rather than from the paragraph. Each **pair** also intersects to one, so the reconstruction is corroborated three times independently rather than once.

**One caveat, and it does not change the fix.** `T` has nonce 0, no code and a zero balance on Ethereum mainnet, checked against a public node. So the string the upstream mangled has no on-chain history and this repository still cannot say whether it was ever a real hot wallet. The correction stands regardless, for two reasons: restoring the width can only turn an exclusion that matched **never** into one that matches **sometimes**, so it produces strictly fewer credits and cannot produce more; and the invariant that matters is internal — `ignore-from-address` must name the same account as `coin.withdraw-wallet`, and both were mangled from `T`. H5 is deliberately left at 39 digits (it fails closed, and correcting it turns the withdrawal path on), with a note that when it is corrected it must be corrected to `T`.

**The other fail-open constant, `DISCLOSED_SECRET_SHA256`, now has a structural width.** [§7.6](#76-what-the-audit-did-not-find) named it as the sharpest argument in this section and it is repo-authored, so there was no vendor-tree restriction. The literal is passed through `requireSha256Hex` in the **static initialiser**: mangle it and the class fails to load, so the module does not boot with a dead guard — it does not boot at all, which is the failure direction a guard of this kind is supposed to have. Lowercase is required as well as the length, because `String.equals` is case-sensitive and an uppercased digest would be exactly as permanently-false as a short one. `sha256Hex` asserts its own output width for the same reason, closing the symmetric hole where someone weakens the algorithm string instead of the constant.

A JUnit test was **not** added, and the reason is worth recording: `ect/pom.xml` configures `maven-surefire-plugin` with `<skip>true</skip>`, so a test in that module would never run. Adding one would have been the "check that reports on nothing" defect this repository keeps naming. M11 is the check that actually runs in CI, and it reads this literal directly.

**M11 shipped as specified, with two deviations, both stated.**

- **M11-checksum is NOT implemented.** EIP-55 over mixed-case addresses was specified in [§7.9](#79-gate-rule--m11-fixed-width-hex-literals-must-have-their-fixed-width) and is not built. Its measured value today is a printed count of six-of-six unverifiable single-case addresses, and the keccak-256 it would need is already present, so it is cheap to add later — but it asserts nothing about this tree as it stands, and the branch's mandate was the two fail-open constants and the width rule.
- **The canonical dictionary is derived, not quoted.** A local keccak-256 (self-tested at load against `keccak256("")`, `keccak256("abc")` and the `transfer(address,uint256)` selector) computes the Transfer and Approval topic0s. A rule whose job is catching a mistyped constant must not itself depend on one. Its derived `Transfer` topic0 is byte-identical to the correct literal already sitting in the tree at `eth-support/.../EtherscanApi.java:80`, and M11-known independently reproduces this section's "index 36" and "index 47" from the two mangled properties.

**Sequencing, which was the load-bearing note.** M11 runs before the freeze check and keeps its own baseline (`HEX_BASELINE`, six entries). Removing a constant's M11 entry while leaving it frozen under `M4-address` still goes red — that case is mutation-proved, not asserted. The malformed set prints on every run, green or red, with the count in the summary line the gate runner shows.

**And a correction to [F21](#f21), which this branch is the first thing here able to make.** With a JDK and Maven on the host, and with `<module>xrp</module>` removed, **the whole reactor compiles** — all fifteen modules, from `mvn clean compile`, in about ten seconds. That disposes of both of F21's proofs: the first is the `xrp` line itself, and the second — _"`ect` cannot compile"_, because it imports `BitcoinUtil` and declares no `bitcoin-rpc` dependency — is simply **false**. `ect` compiles. The reasoning that Maven does not propagate a system-scoped dependency to consumers is right in general and does not hold for this reactor as configured. F21's headline claim, that nothing here had ever been compiled by anyone, was true when written; it is not true now.

**What CI covers, and what it does not.** No CI job in this repository compiles Java — that is rule M7 of the same gate, and it is deliberate. The Maven run above is a local proof on one machine, and the Java change on this branch ships marked **UNVERIFIED — no CI compiles Java** for that reason. What CI does cover is M11 reading the constant's width out of the source text on every push, which is why the width was made structural in two places rather than one.

---

## 8. Correction — this host has network access

### 8.1 The claim, and that it is false

This review states in five places that there is no network on this host, and uses it as the reason several questions could not be answered. **That is false.** Directly re-tested for this addendum:

| Check                                              | Result                      |
| -------------------------------------------------- | --------------------------- |
| DNS `api.adoptium.net`                             | resolves — `104.18.20.66`   |
| DNS `github.com`                                   | resolves — `20.205.243.166` |
| DNS `repo1.maven.org`                              | resolves — `104.18.19.12`   |
| TCP/443 to all three                               | connects                    |
| Maven Central search API                           | answers queries             |
| `repo1.maven.org` artifact bytes and `.sha1` files | served over HTTPS           |

**On whether it was false on 2026-08-05, this addendum takes no position.** It was not tested then, and it cannot be tested retroactively. The [F3 follow-up](#f3-2026-08-06) reads the evidence as "true when written, since gone stale"; this section reads it as a standing property of the host that the document asserts and that is not the case. Nothing anywhere in the document turns on which is right, and neither reading is worth more words than this paragraph. What matters is that the sentence is in the document **now**, in the present tense, in the section a reader consults to learn what is still open — and that it is not true.

A JDK and Maven were obtained subsequently on that basis. **Neither was on `PATH` in the session that wrote this addendum**, and nothing here was compiled or executed — see [§8.4](#84-what-does-not-change). The one artifact fetched during this addendum was a 40-byte `.sha1` text file.

### 8.2 Where the claim appears

Corrected in place, each pointing here: [§1.2](#12-what-could-not-be-done-and-why) (the "Reach the network" row, plus the two rows that depended on it), the [F3](#f3) follow-up, [§3](#3-jar-inventory) ("Can any of them be verified?"), [F19](#f19), [§5](#5-what-this-review-does-not-cover) item 1, and the closing italic line.

Struck rather than deleted, throughout. A security review that quietly rewrites its own premises is harder to trust than one that shows where it was wrong.

### 8.3 What leaned on it

**1 — [F3](#f3), and this is the big one.** [§6](#6-verdict) names F3 _"the one thing that should be treated as more urgent than the rest of this document"_. As originally written, the F3 follow-up said confirmation _"still needs `org.web3j:core:3.3.1` on disk"_ — and the reason it was not on disk was given as: there is no network.

**That is the whole case for why a false entry in a "what we could not do" table is not a clerical matter.** The document's own top-priority finding sat unconfirmed behind an obstacle that did not exist. The moment somebody used the network, F3 resolved — and it resolved the bad way. The sequence, all on 2026-08-06:

| Step                                                                              | Result                                                |
| --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| The jar is fetched over the network the review said it did not have               | `crypto-3.3.1.jar`, 44,008 bytes                      |
| It is read as bytes, no JVM — the review's own fastjson technique                 | the accessor chain is exactly as inferred             |
| [F3](#f3) is promoted from inference to finding ([follow-up](#f3-2026-08-06))     | **`eth-support` logs the ETH hot-wallet private key** |
| Its one residual caveat — the jar's provenance — is left open, awaiting a network | one `curl` of a `.sha1`                               |
| That `curl` is run for this addendum                                              | **matches. F3 has no remaining conditional.**         |

Published `crypto-3.3.1.jar.sha1` is `8e07f435838a1d840765656d8df6b8e8e2c5f4e4`; the jar on this host hashes to the same value, and its SHA-256 matches what the follow-up recorded. Details in the [gap-closed note](#f3-2026-08-06).

Two corrections fall out of this that the original table got wrong on their own terms, independent of the network:

- **The coordinate was misnamed.** `Credentials` and `ECKeyPair` are in `org.web3j:`**`crypto`**, not `org.web3j:`**`core`**. `core-3.3.1.jar` contains neither class. Anyone who obtained `core` — as this addendum first did, quoting its SHA-1 `1738c99a…` — would have found nothing and could plausibly have concluded the opposite of the truth.
- **`org.web3j:core:3.3.1` is nonetheless published and fetchable** (HTTP 206 to a range request), so the row asserting it could not be resolved was wrong twice over: wrong that it was unreachable, and wrong about which artifact was wanted.

**2 — [§3](#3-jar-inventory), jar verification. Partly answered, and the rest of the answer is worse than "unverifiable".** Three further coordinates were queried:

| Coordinate                    | On Maven Central                     | Consequence                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `com.spark.bc:bitcoin-rpc`    | **No — zero artifacts, any version** | The tree's most trust-critical binary, which builds, signs and broadcasts raw Bitcoin transactions for `bitcoin` and `usdt`, has **no published counterpart to check against.** Not "we lacked the means" — we looked, and there is nothing there. Its only stated origin remains the `maven.xinhuokj.com` deploy target inside its own pom. |
| `org.litecoinj`               | **No**                               | Consistent with [§3](#3-jar-inventory)'s finding that it was built on one person's Windows machine in 2019. The GAV identifies nothing public.                                                                                                                                                                                               |
| `cash.bitcoinj:bitcoinj-core` | **Yes** — 0.14.5, 0.14.5.1, 0.14.5.2 | Answers [§4](#4-dependency-versions-and-cve-surface): the coordinate the four Bitcoin-family key-minting modules resolve **does** exist publicly. Who publishes it, and whether its `ECKey` RNG is sound, remain open — [§5](#5-what-this-review-does-not-cover) item 8 stands untouched.                                                    |

**3 — [F19](#f19), the `47.74.42.87` node.** "Cannot be answered without network access" was the wrong diagnosis. Whether that node is ours is an **ownership** question, answerable from procurement records. It was not probed for this addendum and should not be: probing a third-party host is not a decision this review gets to make.

**4 — [§5](#5-what-this-review-does-not-cover) item 7, balances.** Checkable now, at every address named in this document — including the hot-wallet account reconstructed in [§7.5](#75-the-mangling-is-one-deleted-digit-and-it-is-reversible). Not done, and no longer impossible.

### 8.4 What does not change

**Every static finding, F1 through F21, stands unaltered.** They were read out of source that has not moved, and a working socket neither adds nor removes a line of it. Nothing in this correction touches the [verdict](#6-verdict).

**The transitive dependency graph is still unenumerated**, and network access does not help: that needs a resolved build, not a socket.

**And nothing has been compiled.** [§5](#5-what-this-review-does-not-cover) item 1 and [F21](#f21) are correct as written and are not weakened here. The distinction this correction turns on is narrow and worth stating plainly: _"we could not reach the artifact"_ was false; _"we did not compile anything"_ was true then and is true now.

The reason to record this at length rather than quietly amend a table is that the false claim **was doing real work, and the record now shows exactly how much.** It converted four open items into impossible ones. It retired the document's own stated top priority on a premise nobody tested. And when the premise was finally ignored, [F3](#f3) went from _"almost certainly"_ to confirmed inside a day, and from confirmed to unconditional inside a few hours more — on evidence that had been one HTTPS GET away the whole time, while the review said it was out of reach.

**A review's list of what it could not do is load-bearing, and it needs checking as carefully as its findings.** An overstated obstacle is not a modest error in a security document. It is an instruction to everyone downstream to stop looking.

---

_Static analysis only. Nothing in this tree was compiled, executed, or dynamically tested, by this review or — per [F21](#f21) — by anything else. **No JDK, JRE or Maven has been on `PATH` in any session that wrote to this document**, and class files were read as bytes throughout, which needs no JVM. The claim that **no network** was available is false and is corrected in [§8](#8-correction--this-host-has-network-access); it is not known whether it was true on 2026-08-05, and no conclusion here depends on which._

_Addenda, 2026-08-06: [F3 follow-up](#f3-2026-08-06) (F3 confirmed, provenance closed) · [§7](#7-fixed-width-hex-constant-audit-addendum-2026-08-06) (hex constant audit) · [§7.11](#711-what-landed-h4-corrected-and-m11-built) (H4 corrected, M11 built, [F21](#f21) disproved — the tree compiles) · [§8](#8-correction--this-host-has-network-access) (network correction)._
