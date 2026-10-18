# Runbook — re-encrypting ETH-family deposit keystores

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** procedure only. **Nothing in this file has been executed.** Board item A1.4.
**Written:** 2026-07-30, against `origin/main` at the time of writing.
**Who runs it:** the owner. Not an agent, not CI. There is real money behind these keys.

> **What I did not run, stated plainly.** I did not decrypt a keystore, did not write a
> keystore, did not start a wallet RPC service, did not connect to a MongoDB holding an
> address book, and did not set `ETH_KEYSTORE_PASSWORD` anywhere. Every command below is
> written to be run by a human who can see the output and stop. The verification steps are
> written so that each one fails loudly rather than passing quietly — that is the only
> property of this document worth anything.

---

## The finding that changes the shape of this job

**In the deployment on this machine there are no ETH keystores to migrate.** Checked, not
assumed:

| Check                                                         | Result                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker ps` — any `01_wallet_rpc` service running             | **none.** No `service-rpc-eth`, `-eusdt`, `-btc`, or any sibling                                                                                                                                                                      |
| `/data/eth/data/keystore` inside each running container       | does not exist                                                                                                                                                                                                                        |
| `find … -name '*.jar' -path '*target*'` under `01_wallet_rpc` | no build output — the tree has never been compiled here                                                                                                                                                                               |
| `01_wallet_rpc/pom.xml` `<modules>`                           | lists `xrp`; **`vendor/upstream-exchange/01_wallet_rpc/xrp` is not tracked in git** — the reactor cannot resolve it                                                                                                                   |
| the wallet address book in MongoDB                            | `coinex-mongo` **is** running, and `listDatabases` returns `admin`, `job-module`, `config`, `local`. **There is no `wallet` database** — so no `ETH_address_book`, no `EUSDT_address_book`; not empty collections, no database at all |

So on this host the migration is a **pre-flight**, not a rescue: set the password _before_
the first `GET /rpc/address/{account}` ever runs and there is nothing to re-encrypt, because
every keystore will be born with the right password.

This runbook still has to exist, for two reasons:

1. If a legacy or production deployment of this wallet tree exists anywhere else, its
   deposit keystores **are** empty-password and this is the procedure for them.
2. The pre-flight itself has a verifiable definition of done, and §7 below is it.

Confirm which case you are in **before** doing anything else — §1 is that confirmation.

---

## Why the files stop decrypting

Before `#86`, three things were true in `vendor/upstream-exchange/01_wallet_rpc`:

| Path                                                             | Before `#86`                                                                                                                                                       | Now on `main`                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `eth/…/WalletController.getNewAddress`                           | `@RequestParam(required = false, defaultValue = "") String password` — the encryption password came from the **HTTP query string, defaulting to the empty string** | parameter removed; `createNewWallet(account)` only               |
| `eth-support/…/EthService.createNewWallet`                       | encrypted with the caller's `password`                                                                                                                             | encrypts with `coin.getKeystorePassword()`, and refuses if blank |
| `eth-support/…/EthService.transferFromWallet` / `.transferToken` | unlocked deposit keystores with the **literal `""`**                                                                                                               | unlock with `requireKeystorePassword()`                          |

The sweep path hard-coded `""`. That is the load-bearing fact: whatever a caller could have
passed, the only deposit keystores this system could ever sweep are the ones encrypted with
the empty string. `coin.keystore-password` was **absent** from `eth/application.properties`
entirely, so there was no configured value either.

`coin.withdraw-wallet-password` is a **separate** population of exactly one file
(`coin.withdraw-wallet`). Its old value was a committed literal, not the empty string, and it
now reads `${ETH_WITHDRAW_WALLET_PASSWORD}`. Treat it separately — §6.

Today `KeystorePasswordValidator` (`eth-support/…/config/KeystorePasswordValidator.java`)
refuses to start any service with `coin.keystore-path` set unless both passwords are
non-blank. So the failure mode is **not** silent: with `ETH_KEYSTORE_PASSWORD` unset the
service will not boot; with it set to a new value the service boots and then throws
`CipherException` on the first sweep of a pre-existing keystore.

**Which services are affected:** the three modules that set `coin.keystore-path` —
`eth`, `erc-token`, `erc-eusdt`. They share `coin.keystore-path=/data/eth/data/keystore`,
which means **one directory, one password, three services**. A partially migrated directory
breaks all three.

---

## Ground truth: where the two records live

There are two independent records and the migration must keep them agreed.

**1. The keystore files.** On disk at `coin.keystore-path` (`/data/eth/data/keystore`).
Standard web3j / go-ethereum V3 JSON, named
`UTC--<iso-timestamp>--<address-without-0x>.json`. Each file contains its own `address`
field.

**2. The address book.** MongoDB, database `wallet` (from
`spring.data.mongodb.uri`), collection **`<COIN_UNIT>_address_book`** —
`AccountService.getCollectionName()` returns `coin.getUnit() + "_address_book"`. So `ETH`
uses `ETH_address_book` and both `erc-token` and `erc-eusdt` use `EUSDT_address_book`
(both set `coin.unit=EUSDT`; that collision is itself worth a look). Document shape from
`rpc-common/…/entity/Account.java`:

```
{ account: "<platform username>", address: "0x…", walletFile: "UTC--…json",
  balance: <Decimal>, gas: <Decimal> }
```

`walletFile` is the join key. **Every step below keeps the filename unchanged**, so this
collection is never written to. That is deliberate: a migration that has to update a
database _and_ rewrite files has two failure modes that can disagree with each other.

---

## Cryptographic parameters — get this right or you silently weaken the keys

`createNewWallet` calls `WalletUtils.generateNewWalletFile(password, dir, /* useFullScrypt */ true)`.
`true` means **full** scrypt: `n = 262144, p = 1, r = 8, dklen = 32`. The "light"
alternative is `n = 4096`, which is 64× cheaper to brute-force.

Re-encryption must use `Wallet.createStandard(...)` (full), **not** `Wallet.createLight(...)`.
A re-encryption that quietly drops to light parameters is a security regression wearing the
costume of a security fix. §5 verifies the parameters, not just that the file opens.

---

## 0 · Freeze — before anything else

Nothing in this migration is safe while a service can write to the keystore directory or
send a transaction.

```bash
# 1. Stop every service that can touch a keystore or trigger a sweep.
docker ps --format '{{.Names}}\t{{.Ports}}' | grep -Ei 'rpc-(eth|eusdt|token)|wallet'
docker stop <each name printed above>

# 2. Prove they are down. Expect zero rows.
docker ps --format '{{.Names}}' | grep -Ei 'rpc-(eth|eusdt|token)'; echo "exit=$?"   # exit=1 is success
```

Also stop the `00_framework` `wallet` service — it is the caller that drives withdrawals and
collections against these RPCs. Leaving it up means an unattended scheduled job can fire
mid-migration.

**Verifiable:** the second command must print nothing and exit 1.
**Rollback:** `docker start` the same names. Nothing has changed yet.

---

## 1 · Enumerate — and find out whether you have anything to do

```bash
KS=/data/eth/data/keystore     # coin.keystore-path

# A. Files on disk.
ls -1 "$KS" | wc -l
ls -1 "$KS"                    # eyeball the UTC--…--<address>.json shape

# B. Address-book rows, per collection.
mongosh "<WALLET_MONGO_URI>" --quiet --eval '
  ["ETH_address_book","EUSDT_address_book"].forEach(function (c) {
    print(c + ": " + db.getCollection(c).countDocuments({}));
  });
'

# C. Reconcile the two sets. Orphans in either direction are a finding, not noise.
mongosh "<WALLET_MONGO_URI>" --quiet --eval '
  ["ETH_address_book","EUSDT_address_book"].forEach(function (c) {
    db.getCollection(c).find({}, {walletFile:1, address:1, _id:0}).forEach(printjson);
  });
' > /tmp/book.json
```

**Verifiable:** you end §1 with three numbers — files on disk, rows in the book, and rows
whose `walletFile` has no file (or file with no row). Write them down; §5 compares against
them.

**If files-on-disk is 0 and rows-in-book is 0** — you are in the pre-flight case. **Skip to
§7.** There is nothing to migrate and running §3 on an empty directory proves nothing.

**Rollback:** none needed. Everything here is read-only.

---

## 2 · Snapshot — the only thing that makes the rest reversible

Nothing after this point is attempted until a restorable snapshot exists. "Restorable" means
you restored it and compared, not that the tar command exited 0.

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SNAP=/secure/keystore-snapshots            # NOT inside $KS, NOT in the repo, NOT in a container layer

mkdir -p "$SNAP"
tar -C "$(dirname "$KS")" -czf "$SNAP/keystore-$STAMP.tar.gz" "$(basename "$KS")"

# Checksum every file, before and after, so a corrupted archive cannot pass as a good one.
( cd "$KS" && find . -type f -exec sha256sum {} + | sort ) > "$SNAP/keystore-$STAMP.sha256"

# PROVE the archive restores. This is the step people skip.
rm -rf /tmp/restore-test && mkdir -p /tmp/restore-test
tar -C /tmp/restore-test -xzf "$SNAP/keystore-$STAMP.tar.gz"
( cd "/tmp/restore-test/$(basename "$KS")" && find . -type f -exec sha256sum {} + | sort ) \
  > /tmp/restore-test.sha256
diff "$SNAP/keystore-$STAMP.sha256" /tmp/restore-test.sha256 && echo "SNAPSHOT VERIFIED"
```

Also snapshot the address book, even though this procedure does not write to it — it is the
only record of which address belongs to which user:

```bash
mongodump --uri "<WALLET_MONGO_URI>" --out "$SNAP/wallet-mongo-$STAMP"
```

**Verifiable:** `diff` prints nothing and you see `SNAPSHOT VERIFIED`.
**Rollback:** n/a — this step only creates.
**Do not proceed without `SNAPSHOT VERIFIED`.** A keystore snapshot is a private-key
backup: `/secure` must be encrypted at rest and access-controlled like the keys themselves,
because that is what it is.

---

## 3 · Classify — which files open with the old (empty) password

Read-only. `WalletUtils.loadCredentials` does not modify the file.

Run this as a throwaway JVM utility against the same web3j the services use. Do **not** add
it to the repo as a permanent script — a tool whose whole job is to decrypt every private key
in custody should not be sitting in a git checkout waiting to be run by accident.

```java
// Classify.java — read-only. Prints one line per file; writes nothing.
import org.web3j.crypto.*;
import java.io.File;
import java.nio.file.*;

public class Classify {
  public static void main(String[] a) throws Exception {
    String dir = a[0], oldPw = a.length > 1 ? a[1] : "";   // default "" = the old password
    File[] files = new File(dir).listFiles((d, n) -> n.endsWith(".json"));
    int ok = 0, fail = 0;
    for (File f : files) {
      try {
        Credentials c = WalletUtils.loadCredentials(oldPw, f);
        // Three-way agreement: filename, in-file address field, and derived address.
        String derived = c.getAddress().toLowerCase().replace("0x", "");
        boolean nameOk = f.getName().toLowerCase().endsWith(derived + ".json");
        System.out.println("OLD_OK\t" + f.getName() + "\t0x" + derived + "\tnameMatch=" + nameOk);
        ok++;
      } catch (CipherException e) {
        System.out.println("OLD_FAIL\t" + f.getName() + "\t" + e.getMessage());
        fail++;
      }
    }
    System.err.println("total=" + files.length + " old_ok=" + ok + " old_fail=" + fail);
  }
}
```

```bash
# Same JVM and web3j version the services use, so the scrypt behaviour is identical.
docker run --rm -v "$KS:/ks:ro" -v "$PWD:/work" -w /work maven:3-jdk-8 \
  sh -c 'mvn -q dependency:get -Dartifact=org.web3j:core:3.6.0 \
      && javac -cp "$(mvn -q dependency:build-classpath -Dmdep.outputFile=/dev/stdout -Dartifact=org.web3j:core:3.6.0 2>/dev/null | tail -1)" Classify.java \
      && java  -cp ".:$(…same classpath…)" Classify /ks ""' \
  > classify-before.tsv
```

_(Resolve the web3j version from `01_wallet_rpc/pom.xml` rather than trusting `3.6.0` here —
if the version differs, use the one the build resolves.)_

**Verifiable — three assertions, all of which must hold:**

1. `old_ok + old_fail == <files on disk from §1>`. Nothing was skipped.
2. `nameMatch=true` on **every** `OLD_OK` row. A filename that disagrees with the key it
   contains means the address book's `walletFile` join is lying, and the migration stops
   here.
3. Every `walletFile` in `/tmp/book.json` appears in `classify-before.tsv`.

**If `old_fail > 0`:** stop. A mixed population means some files were created with a
caller-supplied password through the old query parameter. Those passwords are **not
recoverable** and those keys can only be dealt with by sweeping (§4, option B) _if_ the
password can be found, or reported as unrecoverable if it cannot. Do not continue a
whole-directory re-encryption over a mixed set — you will produce a directory that no single
password opens, which is worse than what you started with.

**Rollback:** nothing to roll back; read-only.

---

## 4 · Choose: re-encrypt in place, or sweep out

|                                      | **A · Re-encrypt (recommended)**                                  | **B · Sweep out**                                                                     |
| ------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| What it does                         | decrypt with `""`, re-encrypt with the new password, same address | send each balance to the hot wallet, abandon the deposit address                      |
| On-chain                             | nothing                                                           | one transaction per address                                                           |
| Cost                                 | none                                                              | gas per address, plus ERC-20 gas funding for token addresses that hold no ETH         |
| Reversible                           | **yes** — restore §2's snapshot                                   | **no.** A transaction cannot be recalled                                              |
| Deposit addresses users already hold | keep working                                                      | **stop being swept.** Money sent to them afterwards is stranded until someone notices |
| Failure mode                         | a file fails to re-encrypt; retry it                              | a transaction is mined and the address is now unmonitored                             |

**Recommendation: A.** B is the right answer only for addresses whose password is genuinely
unrecoverable, because it is the only option that does not need the password to be
known — and even then it needs _the private key_, which needs the password. B is therefore
mostly theatre for the empty-password case: if you can sweep it, you can re-encrypt it, and
re-encryption is free and reversible.

The real argument for B is different and worth stating: **an address whose private key was
ever encrypted with the empty string should arguably not hold value again**, because the
keystore file may have been copied while it was trivially decryptable. If the keystore
directory has ever been in a backup, an image, a shared volume or a repo, treat the keys as
**potentially disclosed** and choose B — then B is not a migration, it is an incident
response, and it needs the owner's decision plus a new deposit address per user.

**This choice is the owner's and it is the reason this runbook is not executed.**

---

## 5 · Re-encrypt (option A) — one file at a time, atomically

Non-negotiables:

- **Never** decrypt-then-write over the original. Write a new file, verify it, then swap.
- **Same filename at the end**, so the address book needs no update.
- Full scrypt (`Wallet.createStandard`), never light.
- One file at a time, with per-file verification, so a halt leaves a known state.

```java
// Reencrypt.java — writes <name>.new, verifies it, then atomically replaces <name>.
import org.web3j.crypto.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.File;
import java.nio.file.*;

public class Reencrypt {
  public static void main(String[] a) throws Exception {
    String dir = a[0], oldPw = a[1], newPw = a[2];
    if (newPw.isEmpty()) throw new IllegalArgumentException("refusing to encrypt with an empty password");
    ObjectMapper om = new ObjectMapper();
    for (File f : new File(dir).listFiles((d, n) -> n.endsWith(".json"))) {
      Credentials before = WalletUtils.loadCredentials(oldPw, f);        // must succeed
      WalletFile wf = Wallet.createStandard(newPw, before.getEcKeyPair()); // FULL scrypt
      Path tmp = Paths.get(dir, f.getName() + ".new");
      om.writeValue(tmp.toFile(), wf);

      // Verify the NEW file before it replaces anything.
      Credentials after = WalletUtils.loadCredentials(newPw, tmp.toFile());
      if (!after.getAddress().equalsIgnoreCase(before.getAddress()))
        throw new IllegalStateException("ADDRESS CHANGED for " + f.getName() + " — aborting, original untouched");
      ScryptKdfParams p = (ScryptKdfParams) wf.getCrypto().getKdfparams();
      if (p.getN() != 262144 || p.getP() != 1 || p.getR() != 8)
        throw new IllegalStateException("WEAK KDF for " + f.getName() + " — aborting, original untouched");

      Files.move(tmp, f.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
      System.out.println("REENCRYPTED\t" + f.getName() + "\t" + after.getAddress());
    }
  }
}
```

Supply the new password through a file or stdin, never as an argv string — argv is visible in
`ps` and lands in shell history.

**Verifiable, per file:** the address is unchanged and the KDF is full scrypt, both asserted
_before_ the swap. Any failure throws with the original still in place.

**Verifiable, per directory** — re-run §3's classifier twice:

```bash
# 1. Nothing opens with the OLD password any more. Expect old_ok=0.
java … Classify "$KS" ""            > classify-after-old.tsv

# 2. Everything opens with the NEW password. Expect old_ok == <file count>, old_fail=0,
#    and nameMatch=true on every row.
java … Classify "$KS" "<new-pw>"    > classify-after-new.tsv

# 3. The set of addresses is IDENTICAL to before. This is the assertion that matters.
cut -f3 classify-before.tsv | sort > /tmp/addr-before
cut -f3 classify-after-new.tsv | sort > /tmp/addr-after
diff /tmp/addr-before /tmp/addr-after && echo "ADDRESS SET UNCHANGED"
```

**If it fails halfway.** Because each file is swapped atomically and independently, a halt
leaves a directory where some files open with the new password and some with the old. That
state is **safe to store and fatal to run**: `transferFromWallet` uses one password for the
whole set, so the service must not be started until the directory is homogeneous.

- **To resume:** the script is idempotent-by-failure, not by design — re-running it will throw
  on the first already-migrated file (it cannot open it with `oldPw`). Change the loop to
  `try { oldPw } catch { try { newPw → already done, skip } catch { hard fail } }`, or run
  §3's classifier and pass it only the `OLD_OK` files. Prefer the second: an explicit
  worklist beats a clever loop when the payload is private keys.
- **To roll back:** stop, restore from §2, re-verify the checksums, and unset the env var:

```bash
mv "$KS" "$KS.aborted-$STAMP"
tar -C "$(dirname "$KS")" -xzf "$SNAP/keystore-$STAMP.tar.gz"
( cd "$KS" && find . -type f -exec sha256sum {} + | sort ) | diff - "$SNAP/keystore-$STAMP.sha256" \
  && echo "ROLLBACK VERIFIED"
```

Keep `$KS.aborted-$STAMP` — do not delete it until §7 has passed. It holds private keys, so
it is subject to the same handling as the snapshot.

---

## 6 · The hot withdraw wallet — separate file, separate password, separate risk

`coin.withdraw-wallet` names one file, and its password was a committed literal (now
`${ETH_WITHDRAW_WALLET_PASSWORD}`). Two differences from §5 that matter:

1. **This key is disclosed.** Its password sat in a git-tracked file and is in git history.
   Re-encrypting it does not undo that. If it has ever held value on a live chain, the
   correct action is **not** re-encryption but **key rotation**: generate a new hot wallet,
   move the balance to it, update `coin.withdraw-wallet`, and retire the old address.
   Re-encryption alone leaves a key whose old ciphertext plus its published password are
   both recoverable from history.
2. Two of the three modules name a **different** withdraw wallet file
   (`eth` and `erc-token` name one, `erc-eusdt` names another), so there is more than one to
   account for. Enumerate from the properties, not from memory.

**Owner decision, and I am not making it:** rotate rather than re-encrypt. Recorded here
rather than executed.

---

## 7 · Cut over and prove it — this is also the pre-flight checklist

Applies whether you migrated or started empty.

```bash
# 1. Password present in the environment, absent from the tree.
grep -rn 'coin.keystore-password' vendor/upstream-exchange/01_wallet_rpc --include=application.properties
#    every hit must read: coin.keystore-password=${ETH_KEYSTORE_PASSWORD}

# 2. Start ONE service, with the env var set, and read the log.
#    Expect a normal Spring start. A blank password gives you the
#    KeystorePasswordValidator IllegalStateException instead — which is the guard working.
docker logs <eth-rpc-container> 2>&1 | grep -Ei 'keystore-password|Started|IllegalState'

# 3. Prove the auth wall is up (from #86, but verify it here — it is one command).
curl -s -o /dev/null -w '%{http_code}\n' 'http://<host>:7003/rpc/height'                      # expect 401/403
curl -s -o /dev/null -w '%{http_code}\n' -H "X-Rpc-Auth-Token: $WALLET_RPC_AUTH_TOKEN" \
     'http://<host>:7003/rpc/height'                                                          # expect 200

# 4. Create ONE new address and prove it was born with the new password.
curl -s -H "X-Rpc-Auth-Token: $WALLET_RPC_AUTH_TOKEN" 'http://<host>:7003/rpc/address/probe-acct'
java … Classify "$KS" "<new-pw>" | grep -c OLD_OK    # must equal the new file count
java … Classify "$KS" ""         | grep -c OLD_OK    # must be 0

# 5. Prove the SWEEP path opens a pre-existing keystore, not just a new one.
#    This is the step that would have failed silently. Use the smallest possible amount
#    on a testnet, or against an address you control, and confirm the tx.
```

**Step 5 is the one that matters.** Steps 1–4 prove the new files are fine; only a real
sweep of a _migrated_ keystore proves the migration worked. Do it on a testnet first.

**Done means:**

- [ ] Every keystore opens with the new password; none opens with the empty string.
- [ ] The address set is byte-identical to the pre-migration set.
- [ ] Every `walletFile` in every `<UNIT>_address_book` resolves to a file that opens.
- [ ] KDF is full scrypt (`n = 262144`) on every re-encrypted file.
- [ ] A sweep of a migrated deposit keystore succeeded on-chain.
- [ ] A withdrawal from the hot wallet succeeded — **after** the §6 rotation decision.
- [ ] `ETH_KEYSTORE_PASSWORD` is in the secret store, not in a shell profile or compose file.
- [ ] The verified snapshot is retained, encrypted, with the retention date written down.
- [ ] `$KS.aborted-*` directories from any abandoned attempt are securely destroyed.

---

## What is deliberately not in this file

- **The new password.** Generate it at execution time (`openssl rand -base64 32`) and put it
  straight into the secret store. It must never exist in a doc, a commit, a compose file or
  a shell history.
- **A ready-to-run script.** The two Java utilities are printed so they can be read and
  compiled at execution time, deliberately not committed. A committed tool that decrypts
  every private key in custody is a liability with a filename.
- **A schedule.** Sequencing a live custody operation is the owner's call.
