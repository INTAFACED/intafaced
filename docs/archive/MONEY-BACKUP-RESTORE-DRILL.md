# Money data backup / restore drill (D26-P3-09)

**Date:** 2026-08-15 · **Lane:** `denon-d26-p3-09-backup-restore` · **Branch:** `feat/d26-p3-09-money-backup-restore`  
**Done bar:** one exercised restore path documented — dump contents, restore order, post-restore hash-chain / reconciliation proof, and what this machine did **not** run.  
**Leverage (Phase A IN):** compose Postgres 16 (`docker-compose.yml` `postgres`) + `svc-ledger` hash-chain / `runReconciliation` (`services/svc-ledger/src/ledger/reconcile.ts`). No second book. No new backup product.

This is a **runbook**, not a backup policy. Retention location, encryption at rest, and whether staging data is disposable remain owner decisions ([`THREAT-MODEL-STAGING-DEPLOY.md`](THREAT-MODEL-STAGING-DEPLOY.md) §8 residual / D4). This file does not invent those. It does not edit [`THREAT-MODEL-CURRENT.md`](THREAT-MODEL-CURRENT.md).

**No production host exists.** Nothing here is a prod restore. Do not restore over the live compose database `intafaced`.

---

## 0 · Verdict from this host (2026-08-15)

| Question                                                | Answer                                                                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose Postgres present?                               | **Yes** — `intafaced-postgres` healthy, image `postgres:16-alpine`, `pg_dump` **16.13**, host map `${POSTGRES_HOST_PORT:-5433}:5432`.                                           |
| Live ledger schema present?                             | **Yes** — schema `ledger` with eight relations (see §1).                                                                                                                        |
| Dump exercised?                                         | **Yes** — custom-format `pg_dump --schema=ledger --no-owner` inside the container, **105394 bytes**, written to `/tmp` only. **Not committed. Not retained.**                   |
| Restore exercised?                                      | **Yes, throwaway only** — `CREATE DATABASE intafaced_restore_drill`, `pg_restore --no-owner`, SQL proofs in §3, then **`DROP DATABASE`**. Live `intafaced` was not overwritten. |
| Full `verifyChain` / `hashTx` SHA recompute?            | **Not run** — needs the Node path in `postgres-ledger.ts`. SQL predecessor-link check **was** run and was clean (necessary, not sufficient).                                    |
| `POST /operator/reconcile` (`admin:treasury`+MFA)?      | **Not run** — no operator token was minted and none will be invented.                                                                                                           |
| Restore onto live `intafaced`?                          | **Not run** (destructive).                                                                                                                                                      |
| Staging pre-deploy backup / prod PITR / off-host store? | **Unexercised** — no staging backup policy, no prod, no retention target.                                                                                                       |

The dump file and the throwaway database are **gone**. Repeating the drill requires taking a new dump.

---

## 1 · What to dump (the money book)

Doctrine §0.6: the only book is `packages/ledger-client` + `svc-ledger`. A dump of pay / trade / bank / identity **is not a money restore**. Those schemas may be dumped separately for product state; they do not replace this one.

Dump **schema `ledger` only**, including sequences. On this host the live relations were:

| Relation                   | Role                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| `ledger.assets`            | Registered assets (scale / identity of the book)                   |
| `ledger.accounts`          | Identity + denormalised `balance` cache                            |
| `ledger.ledger_tx`         | Hash-chained journal (`seq`, `hash`, `previous_hash`)              |
| `ledger.ledger_entries`    | Posting lines; replay source for `reconcileBalances`               |
| `ledger.chain_tip`         | Singleton tip (`seq` + `hash`); posting lock target                |
| `ledger.posting_freeze`    | Durable kill-switch                                                |
| `ledger.balance_snapshots` | Hourly anchors (`writeSnapshots`) — large; include them            |
| `ledger.__migrations`      | Drizzle history — restore without it and the next migrate will lie |

**Do not dump** `pgdata` volume files as the restore path. The exercised path is `pg_dump` / `pg_restore`.

### 1.1 · Command (compose, inside the container)

Freeze posting **before** a dump you intend to restore from (§2). This drill’s dump was taken while `intafaced-svc-ledger` was healthy and posting was **not** frozen; the restored book still proved consistent (counts below). That is luck on a 52-transaction journal, not procedure.

```bash
docker exec intafaced-postgres pg_dump \
  -U intafaced -d intafaced \
  --schema=ledger --no-owner --format=custom \
  -f /tmp/ledger.dump
```

Host-side equivalent (port **5433**, not 5432): same flags against `localhost`. Use the compose superuser from `docker-compose.yml`. Do not put the password in this file, in git, or in a ticket.

`--no-owner` is load-bearing for a throwaway restore: the dump must not require the original role OIDs. `--format=custom` is the restore tool `pg_restore` expects.

---

## 2 · Restore order

**Never** this order on the live compose DB. The exercised path is a **new empty database** on the same instance.

1. **Halt writers.** `POST /operator/freeze` (`admin:treasury` + MFA) or `LEDGER_POSTING_ENABLED=false` (can freeze, cannot thaw — see `services/svc-ledger/README.md`). Stop `intafaced-svc-ledger` and every other poster. Reads may continue; posts must not.
2. **Forensic dump of the damaged book** (if this is an incident), stored off the instance. Do not skip this to “save time”.
3. **Create an empty database.** Do not drop `intafaced` to make room.

   ```bash
   docker exec intafaced-postgres psql -U intafaced -d postgres \
     -c "CREATE DATABASE intafaced_restore_drill;"
   ```

4. **Restore schema `ledger` into that database.**

   ```bash
   docker exec intafaced-postgres pg_restore \
     -U intafaced -d intafaced_restore_drill --no-owner \
     /tmp/ledger.dump
   ```

5. **Prove the restored book** (§3) **before** any cutover. If proofs fail, the dump is not a book — keep the forensic copy and stop.
6. **Cutover (unexercised here).** Only after proofs: point a stopped `svc-ledger` at the restored database (or swap names under a freeze), migrate check (`__migrations` present), boot, `POST /operator/reconcile`, thaw only if `ok: true`.
7. **Destroy the throwaway** when the drill is done:

   ```bash
   docker exec intafaced-postgres psql -U intafaced -d postgres \
     -c "DROP DATABASE intafaced_restore_drill;"
   docker exec intafaced-postgres rm -f /tmp/ledger.dump
   ```

This host executed steps 3–5 and 7 against a dump from the live `ledger` schema. It did **not** execute steps 1, 2, or 6.

---

## 3 · How to prove hash-chain and reconciliation after restore

Three independent checks, same split as `runReconciliation` in `reconcile.ts`:

1. **`reconcileBalances`** — cached `accounts.balance` vs replay of `ledger_entries`.
2. **`verifyChain`** — every `hash` recomputed with `hashTx` from its predecessor (SHA-256 of `previousHash ‖ canonical JSON`).
3. **`totalsByAsset`** — every asset nets to `0` across accounts.

### 3.1 · SQL proofs (exercised on `intafaced_restore_drill`)

These do **not** recompute SHA-256. They prove row counts, tip alignment, predecessor **linkage**, balance replay, and per-asset zero. That is the fail-closed floor when Node `verifyChain` is not run.

Live source counts (schema `ledger` on `intafaced`) and restored counts were identical:

| Relation             | Count |
| -------------------- | ----- |
| `ledger_tx`          | 52    |
| `ledger_entries`     | 120   |
| `accounts`           | 58    |
| `assets`             | 22    |
| `balance_snapshots`  | 12172 |
| `chain_tip.seq`      | 52    |
| `max(ledger_tx.seq)` | 52    |

Proof queries (no money amounts printed — mismatches only):

```sql
-- Tip must equal the journal.
SELECT seq FROM ledger.chain_tip WHERE id = true;
SELECT COALESCE(max(seq), 0) AS max_tx_seq, count(*) AS tx_count FROM ledger.ledger_tx;

-- Predecessor links (NULL previous_hash only on the first seq).
WITH ordered AS (
  SELECT seq, hash, previous_hash,
         lag(hash) OVER (ORDER BY seq) AS expected_prev
  FROM ledger.ledger_tx
)
SELECT count(*) FILTER (WHERE previous_hash IS DISTINCT FROM expected_prev)
  AS predecessor_breaks
FROM ordered;

-- Cached balance vs entry replay (same CASE as reconcileBalances).
SELECT count(*) AS balance_replay_mismatches FROM (
  SELECT a.id,
         a.balance::numeric AS cached,
         COALESCE(SUM(CASE WHEN e.direction = 'debit' THEN e.amount ELSE -e.amount END), 0) AS replayed
    FROM ledger.accounts a
    LEFT JOIN ledger.ledger_entries e ON e.account_id = a.id
   GROUP BY a.id, a.balance
) s WHERE cached IS DISTINCT FROM replayed;

-- Per-asset zero (same idea as totalsByAsset).
SELECT count(*) AS unbalanced_assets FROM (
  SELECT asset_id FROM ledger.accounts GROUP BY asset_id HAVING SUM(balance) <> 0
) u;
```

**This drill:** `predecessor_breaks = 0`, `balance_replay_mismatches = 0`, `unbalanced_assets = 0`, `chain_tip.seq = max(seq) = tx_count = 52`.

If any of those is non-zero, **do not thaw and do not cut over**.

### 3.2 · Node / operator proofs (not exercised)

After pointing a **stopped** `svc-ledger` at the restored database:

- Boot must see `chain_tip` (`services/svc-ledger/src/index.ts` throws if the singleton is missing).
- `POST /operator/reconcile` with `admin:treasury` + MFA. Success shape: `ok: true`, `chainLength` equal to `ledger_tx` count, `unbalancedAssets: []`. Failure **self-freezes** posting before the response (`operator-http.ts`).
- Equivalent in-process: `runReconciliation(sql)` which runs `verifyChain` (recomputes `hashTx`) + `reconcileBalances` + `totalsByAsset`.

Do **not** treat a green SQL predecessor check as a substitute for `verifyChain`. A linked chain of stored hashes can still be a chain of **wrong** hashes if someone rewrote both `hash` and `previous_hash`. Only `hashTx` catches that.

---

## 4 · What is unexercised on this machine

| Item                                                   | Why it stayed unexercised                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Restore onto live database `intafaced`                 | Destructive. Fleet including `svc-ledger` was healthy and posting.                                                        |
| Production restore                                     | There is no production host.                                                                                              |
| Staging pre-migrate backup                             | Staging ADR D4 / §8 — no retention policy, no staging host backup. Rebuild-staging is the named residual, not this drill. |
| `verifyChain` / `hashTx` SHA recompute                 | Not invoked; would require a Node harness or operator reconcile against the throwaway.                                    |
| `POST /operator/reconcile`                             | Requires `admin:treasury` + MFA. No token was created.                                                                    |
| Freeze-then-dump procedure                             | Drill dump was a read of a live book. Procedure for a restore-quality dump is freeze first (§2 step 1).                   |
| WAL / PITR (`restore_command`, base backup + WAL ship) | Not configured on compose.                                                                                                |
| Encrypted off-host retention                           | Owner decision (Class X / ops). No bucket, no vault path invented.                                                        |
| Other service schemas as money SoT                     | Forbidden.                                                                                                                |
| Volume-file copy of `pgdata`                           | Not the documented path.                                                                                                  |

---

## 5 · Fail-closed rules

- If `pg_dump` / `pg_restore` is missing, or schema `ledger` is absent, **stop and write that**. Do not paste a green restore you did not run.
- If proofs fail, the restore is not a book.
- If you do not have MFA treasury, you have not run operator reconcile. Say so.
- Do not restore “just the balances” without `ledger_tx` / `ledger_entries` / `chain_tip`. That is a second book.
- Do not commit dumps. They are money and PII-adjacent.

---

## 6 · Related law (read, not duplicated)

- [`services/svc-ledger/README.md`](../services/svc-ledger/README.md) — invariants, `verifyChain`, freeze.
- [`THREAT-MODEL-STAGING-DEPLOY.md`](THREAT-MODEL-STAGING-DEPLOY.md) §8–§9 — no pre-deploy backup on a host that does not exist.
- Internet leverage: Phase A compose Postgres + ledger hash-chain. No Formance / TigerBeetle / Java wallet tables as SoT.
