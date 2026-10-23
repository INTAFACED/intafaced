# Java Grade D empty + jar honesty (D26-P2-07 / D-S-17)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** executed ratchet — not a runtime safety certificate.  
**Does not claim:** “the Java book is closed.”  
**Sibling law:** [`adr/2026-08-04-java-dual-book-residual.md`](adr/2026-08-04-java-dual-book-residual.md).  
**Gate:** `pnpm scan:vendor-java-jar-truth` (`tooling/ci/vendor-java-jar-truth.mjs`).

---

## Grade D allowlist

`tooling/ci/vendor-java-money-scan.mjs` `VENDOR_JAVA_ALLOWLIST` keeps a **Grade D** band. That band is **empty (count = 0)**. Ungated reward mints (`Reward*Setting = null` / one-line re-arm) were deleted earlier; a new object under that heading is a new ungated mint, not old debt.

This sheet does **not** mass-delete remaining Java. Grades A/B and listed non-writes stay on the money-scan ratchet (owned by the vendor-java-money scan). Grade D staying empty is the only delete-class this mountain ratchets.

---

## Gitignored jars are not scanned source

Compose launches `<module>/target/<module>.jar` under `vendor/upstream-exchange/00_framework`. Those paths are **gitignored** (`vendor/.gitignore` `**/target/` and per-module `/target/`).

`vendor-java-money-scan` walks **`.java` files** and **skips `target/`**. Gitignored compose jars are **not the scan object**. A green source scan is therefore a statement about committed source, not about the binary compose would run.

| Object                       | Tracked? | What the money scan sees                                     |
| ---------------------------- | -------- | ------------------------------------------------------------ |
| `**/src/main/java/**/*.java` | yes      | Yes — this is the scan object                                |
| Compose `*/target/*.jar`     | **no**   | **No** — gitignored; skipped as `target/`                    |
| Committed classpath `.jar`   | yes      | **No** — not `.java`; residual inventory, not Grade D source |

**Rule:** no Java runtime-safety claim may cite the source scan as evidence.

---

## Jar residual (measured)

**32** committed `.jar` files under `vendor/` (git `ls-files`). That is the classpath residual the adoption ADR already named (correcting the stale “31” comment). **Zero** of them are compose boot jars under `*/target/`.

Eighteen of the 32 sit in `01_wallet_rpc` (including `bitcoinj-core-0.13-alice-SNAPSHOT.jar`). Owner-gated; this mountain does not rebuild or delete them.

Compose boot jars, when present on disk, are local/gitignored. Absent is the honest **runtime UNVERIFIED** state.

---

## Rebuild path (named, real)

Do **not** add a jar to force a boot.

1. Local: `pnpm vendor-java:rebuild` → `tooling/scripts/vendor-java-rebuild.mjs`  
   `mvn -B -q -pl <compose modules> -am -DskipTests package` in `vendor/upstream-exchange/00_framework`.
2. CI (advisory): `.github/workflows/vendor-compile.yml` job `package-compose-jars` — same `package` invocation under `maven:3.8.8-eclipse-temurin-8`.
3. Compile-only probe (advisory): same workflow, `mvn … -pl core -am -DskipTests compile`.

A green package job still is not a JVM safety claim. A missing JDK/Maven is exit 2 on the local rebuild script — honest, not a silent skip.

---

## What still open

- Grade A/B dual-book queue (throws / no-ops) — not closed.
- Grade C / admin-without-compose residual — not this mountain.
- Wallet RPC committed jars — owner / Class X.
- Java book **not** closed.
