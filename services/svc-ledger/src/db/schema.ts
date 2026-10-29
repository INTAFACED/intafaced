import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { amount, createdAt, tstz, updatedAt } from '@intafaced/db';

/**
 * THE BALANCE GRAPH (§4.2).
 *
 * This service's schema, and only this service's schema. Nothing else in the OS
 * reads these tables — Doctrine §0.6 and the per-service Postgres roles both
 * enforce it.
 *
 *
 * THIS FILE IS A DESCRIPTION OF THE DATABASE, NOT A PROPOSAL FOR ONE.
 *
 * `drizzle/*.sql` is the source of truth: those files have run against real
 * data and cannot be rewritten. This file must say the same thing they do —
 * every column, every index, every CHECK.
 *
 * It had drifted, and the drift was loaded. Until this commit the file had no
 * `purpose` column (added by 0001), still declared the pre-0001 identity index,
 * declared `chain_tip.seq` as `bigserial` rather than the `bigint DEFAULT 0` the
 * migration wrote, and declared none of the eight CHECK constraints.
 *
 * Diffing the drifted file against a snapshot of the database as it actually is
 * emits 21 statements, 15 of which drop something. Measured with drizzle-kit
 * 0.30.6 — not estimated, and reproduced in full rather than summarised,
 * because a header that rounds its own evidence is not evidence:
 *
 *      1  ALTER TABLE "ledger"."accounts" DROP CONSTRAINT "accounts_non_negative_ck";
 *      2  ALTER TABLE "ledger"."accounts" DROP CONSTRAINT "accounts_purpose_len_ck";
 *      3  ALTER TABLE "ledger"."accounts" DROP CONSTRAINT "accounts_hold_purposed_ck";
 *      4  ALTER TABLE "ledger"."accounts" DROP CONSTRAINT "accounts_owner_id_space_ck";
 *      5  ALTER TABLE "ledger"."chain_tip" DROP CONSTRAINT "chain_tip_singleton_ck";
 *      6  ALTER TABLE "ledger"."ledger_entries" DROP CONSTRAINT "ledger_entries_positive_ck";
 *      7  ALTER TABLE "ledger"."posting_freeze" DROP CONSTRAINT "posting_freeze_singleton_ck";
 *      8  ALTER TABLE "ledger"."posting_freeze" DROP CONSTRAINT "posting_freeze_attributed_ck";
 *      9  ALTER TABLE "ledger"."balance_snapshots" DROP CONSTRAINT "balance_snapshots_account_id_fkey";
 *     10  ALTER TABLE "ledger"."ledger_entries" DROP CONSTRAINT "ledger_entries_tx_id_fkey";
 *     11  ALTER TABLE "ledger"."ledger_entries" DROP CONSTRAINT "ledger_entries_account_id_fkey";
 *     12  DROP INDEX "ledger"."accounts_identity_purpose_idx";
 *     13  DROP INDEX "ledger"."accounts_hold_purpose_idx";
 *     14  ALTER TABLE "ledger"."accounts" ALTER COLUMN "balance" SET DEFAULT '0';
 *     15  ALTER TABLE "ledger"."chain_tip" ALTER COLUMN "seq" SET DATA TYPE bigserial;
 *     16  ALTER TABLE "ledger"."chain_tip" ALTER COLUMN "seq" DROP DEFAULT;
 *     17  ALTER TABLE "ledger"."balance_snapshots" ADD CONSTRAINT "balance_snapshots_account_id_accounts_id_fk" FOREIGN KEY …;
 *     18  ALTER TABLE "ledger"."ledger_entries" ADD CONSTRAINT "ledger_entries_tx_id_ledger_tx_id_fk" FOREIGN KEY …;
 *     19  ALTER TABLE "ledger"."ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_accounts_id_fk" FOREIGN KEY …;
 *     20  CREATE UNIQUE INDEX "accounts_identity_idx" ON "ledger"."accounts" ("owner_type","owner_id","asset_id","kind");
 *     21  ALTER TABLE "ledger"."accounts" DROP COLUMN "purpose";
 *
 * Lines 1-8 are all eight of §4.2's database-level money invariants. Line 12 is
 * the identity index that keeps two holds in one asset from unsecuring each
 * other, and line 20 puts the pre-0001 four-column version back — which is the
 * commingled-hold bug, restored. Line 21 drops the column `assertPurposedHolds`
 * and `accounts_hold_purposed_ck` are both keyed on. All of it removed by
 * someone doing nothing more reckless than regenerating a migration.
 *
 * Lines 9-11 and 17-19 are the same three foreign keys dropped and immediately
 * re-added under drizzle's default names — no invariant changes, but each
 * re-add revalidates the whole journal table, so the "harmless rename" half of
 * this diff is also the half that takes the longest lock. That is why the FKs
 * below are named explicitly: see the note on `ledger_entries`.
 *
 * HOW CLOSE IS THAT, HONESTLY. Not one command away today: svc-ledger has no
 * `drizzle.config.ts`, no `db:generate` script and no `drizzle/meta/` snapshot,
 * so a bare generate against an empty snapshot emits only CREATEs. It is one
 * `drizzle-kit pull` — or one service adopting the `db:generate` line that
 * tooling/agent-protocol/SERVICE_TEMPLATE.md prescribes as standard — away.
 * The gate exists so that step is safe to take rather than something nobody
 * dares do.
 *
 * `schema-drift.test.ts` now fails if this file and `drizzle/` ever disagree
 * again. Read that file before changing this one: the answer to a red drift
 * test is almost always to correct THIS file, because the migrations have
 * already run somewhere and this has not.
 */
export const ledger = pgSchema('ledger');

export const ownerTypeEnum = ledger.enum('owner_type', ['user', 'subaccount', 'module', 'house', 'treasury']);
export const accountKindEnum = ledger.enum('account_kind', ['available', 'hold', 'escrow', 'stake', 'collateral']);
/** `commodity` added by 0003 — the metals and energies the instrument catalogue lists. */
export const assetKindEnum = ledger.enum('asset_kind', ['crypto', 'fiat', 'native', 'commodity']);
export const directionEnum = ledger.enum('direction', ['debit', 'credit']);

export const assets = ledger.table(
  'assets',
  {
    id: text('id').primaryKey(),
    kind: assetKindEnum('kind').notNull(),
    /**
     * DECLARED SCALE. NOTHING READS IT — and that is the honest description
     * (STOP §4.2b #5).
     *
     * 0004 says this is "the scale the ledger reconciles the asset at, and it is
     * not cosmetic". Both halves were false. Every balance is `numeric(38,18)`,
     * reconciliation compares at 18 decimal places for every asset regardless of
     * this column (`reconcile.ts`), and `mulBps` rounds `ceil` at 18 dp — so a fee
     * on a 2 dp fiat or an 8 dp metal accrues a remainder below the asset's own
     * smallest unit, which no rail can move out and no reconciliation flags.
     *
     * Setting `JPY` to 2 or to 18 changes nothing anywhere in the system today.
     * The column is a declaration of intent that no code consults, which is the
     * same shape as the refusal declared and never emitted (#1035) and the builder
     * every post refuses (#1054) — with the difference that this one reads as a
     * safety property, so anyone auditing the book would reasonably believe scale
     * was enforced.
     *
     * NOT wired here on purpose. Enforcing it means choosing what happens to the
     * sub-unit remainder — refuse the post, round to the asset's scale and send the
     * dust somewhere named, or keep 18 dp internally and expose a rounded view —
     * and every one of those is a fee/rounding policy with a house account and a
     * user-visible consequence. There is no law in the doctrine to read it off, so
     * an agent picking one would be inventing a fee policy. `assets-decimals.test.ts`
     * pins the current state so that the day someone wires it, they have to decide
     * deliberately rather than discover the dust later.
     */
    decimals: integer('decimals').notNull().default(18),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    /**
     * The registry (0025, W-balances-05). `precision` is NULL until a founder edit publishes it, and is never read from
     * `decimals` above: a NULL precision refuses `ledger.asset_precision_unset`. `networks` is the `AssetNetwork[]` of
     * `packages/contracts/src/asset-registry.ts`; `revision` is the action approval's `expectedVersion`.
     */
    precision: integer('precision'),
    networks: jsonb('networks')
      .default(sql`'[]'::jsonb`)
      .notNull(),
    defaultNetworkId: text('default_network_id'),
    allowedActions: text('allowed_actions')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    state: text('state').default('active').notNull(),
    revision: integer('revision').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    check('assets_precision_ck', sql`${t.precision} IS NULL OR (${t.precision} >= 0 AND ${t.precision} <= 18)`),
    check('assets_networks_array_ck', sql`jsonb_typeof(${t.networks}) = 'array'`),
    check('assets_state_ck', sql`${t.state} IN ('active', 'halted', 'retired')`),
    check('assets_allowed_actions_ck', sql`${t.allowedActions} <@ ARRAY['deposit', 'withdraw', 'trade', 'transfer']::text[]`),
    check('assets_revision_ck', sql`${t.revision} >= 0`),
  ],
);

export const accounts = ledger.table(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerType: ownerTypeEnum('owner_type').notNull(),
    ownerId: text('owner_id').notNull(),
    assetId: text('asset_id').notNull(),
    kind: accountKindEnum('kind').notNull(),
    /**
     * DENORMALISED running balance.
     *
     * The authoritative record is `ledger_entries`; this column is a cache so a
     * balance read is O(1) instead of a full scan. It is written only inside the
     * same serializable transaction that writes the entries, and the
     * reconciliation job (src/ledger/reconcile.ts) replays every entry and
     * compares — any divergence pages the operator and freezes the module.
     *
     * This is the one denormalisation the doctrine permits, and only because it
     * comes with that job.
     *
     * The default is raw SQL rather than the string `'0'`: the migration wrote a
     * bare numeric literal, so the stored default is `0`, not `'0'::numeric`.
     * Money is still never a JS `number` here — this is DDL text, not a value.
     */
    balance: amount('balance')
      .notNull()
      .default(sql`0`),
    createdAt: createdAt(),
    /**
     * The fifth component of account identity (0001, P0-3).
     *
     * `NOT NULL DEFAULT ''` rather than nullable, because a UNIQUE index treats
     * NULLs as DISTINCT — a nullable `purpose` would let the commingled hold
     * bucket back in as duplicate rows that look identical. See
     * 0001_purpose_keyed_holds.sql, which explains it at length.
     */
    purpose: text('purpose').notNull().default(''),
  },
  (t) => [
    /**
     * Identity, including `purpose` (0001). The pre-0001 `accounts_identity_idx`
     * — the same four columns without `purpose` — was dropped by that migration
     * and must NOT reappear here: it is the index whose missing fifth column
     * was the commingled-hold bug.
     */
    uniqueIndex('accounts_identity_purpose_idx').on(t.ownerType, t.ownerId, t.assetId, t.kind, t.purpose),
    index('accounts_owner_idx').on(t.ownerType, t.ownerId),
    /** "What is held for this user, and what for" — without a sequential scan. */
    index('accounts_hold_purpose_idx')
      .on(t.ownerId, t.assetId, t.purpose)
      .where(sql`kind = 'hold'`),
    /**
     * 0006 — an account may only exist in an asset the ledger knows.
     *
     * The migration's comments had claimed this since 0003; nothing enforced it,
     * so a typo opened a second book that balanced and reconciled and could
     * never be spent. `RESTRICT` because retiring an asset that still holds
     * balances must fail loudly — `active = false` is how one is withdrawn.
     */
    foreignKey({ columns: [t.assetId], foreignColumns: [assets.id], name: 'accounts_asset_id_fk' }).onDelete('restrict'),
    /**
     * 0010 — the target of `ledger_entries_account_asset_fk`, and nothing more.
     *
     * `id` is already the primary key, so this pair is trivially unique and this
     * constraint adds no invariant. Postgres simply requires a declared unique
     * constraint on the exact column list a composite foreign key references, so
     * for the entries table to be able to say "your asset must be this account's
     * asset", the pair has to be referenceable.
     */
    unique('accounts_id_asset_uq').on(t.id, t.assetId),
    /**
     * Not for the key — its check reads `assets.id`, already a primary key.
     * This serves the reconciliation job's GROUP BY asset_id and the RESTRICT
     * check. `ledger_entries` deliberately has no counterpart: nothing queries
     * entries by asset, and the posting path is globally serial (0006).
     */
    index('accounts_asset_id_idx').on(t.assetId),

    /** Only the treasury boundary may run negative (0000). */
    check('accounts_non_negative_ck', sql`owner_type = 'treasury' OR balance >= 0`),
    /** A purpose is a business key, and it participates in an index (0001). */
    check('accounts_purpose_len_ck', sql`length(purpose) <= 128`),
    /**
     * Every lock pot names its claim in the database, not only in TypeScript
     * (0001 hold; 0007 escrow/stake/collateral — STOP §4.2b #1; 0008 fail-closed;
     * 0011 trim + available empty — mirrors client `accountPurpose` / available law).
     *
     * Phrased as "everything except `available`" rather than as a list of locked
     * kinds. 0007 listed the four locked kinds, which meant a fifth would have
     * been unconstrained the moment someone added it to `account_kind` — the
     * constraint failed open on precisely the change most likely to need it.
     * `available` is the only kind that reserves nothing, so it is the only
     * exemption, and a new kind is covered from the moment it exists.
     *
     * `legacy:%` is refused because 0007's backfill minted purposes of the form
     * `legacy:<the row's own id>`, which name the row rather than the claim it
     * secures — see 0008 for why that is worse than an empty purpose.
     *
     * 0011: purpose must equal trimmed form so padded claims cannot open a
     * second pot beside the trimmed identity; `available` must store `''` only.
     * 0014: pad set is what `String.trim()` strips — space/tab/LF/VT/FF/CR,
     * NBSP, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000,
     * and U+FEFF — not bare `btrim()` (space only).
     */
    check(
      'accounts_lock_purposed_ck',
      sql`(kind = 'available' AND purpose = '') OR (kind <> 'available' AND purpose = btrim(purpose, E' \\t\\n\\r\\f' || chr(11) || chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279)) AND length(purpose) > 0 AND purpose NOT LIKE 'legacy:%')`,
    ),
    /**
     * Every `owner_id` is drawn from the space its `owner_type` declares (0005).
     * Kept character-for-character identical to `isValidOwnerId` in
     * packages/ledger-client/src/types.ts; equivalence is asserted against a
     * live Postgres in src/ledger/owner-identity.test.ts.
     */
    check(
      'accounts_owner_id_space_ck',
      sql`CASE
      WHEN owner_type IN ('user', 'subaccount')
        THEN owner_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ELSE owner_id ~ '^[a-z][a-z0-9_-]*(:[A-Za-z0-9._-]+)*$'
       AND owner_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    END`,
    ),
  ],
);

export const ledgerTx = ledger.table(
  'ledger_tx',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Commit order. The hash chain follows this sequence exactly. */
    seq: bigserial('seq', { mode: 'bigint' }).notNull(),
    /**
     * Retry protection. A repeated key returns the original transaction when the body is the same;
     * a different body is a mismatch (`ledger_posted_keys.request_fingerprint`, 0021): refused
     * `ledger.idempotency_conflict` in `refuse` mode, logged in `detect` mode.
     *
     * At least 8 characters, in the database as well as in `assertValidPost`
     * (0009). The key is the IDENTITY of a movement, and after #1060 `post()`
     * returns the existing transaction for a known key before it validates the
     * body — so a row holding `''` means the next caller whose key normalises to
     * empty is handed that transaction and told its own movement succeeded, with
     * nothing having moved and no error raised anywhere.
     */
    idempotencyKey: text('idempotency_key').notNull(),
    module: text('module').notNull(),
    reason: text('reason').notNull(),
    meta: jsonb('meta').notNull().default({}),
    postedAt: timestamp('posted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /**
     * Hex-encoded SHA-256 of (previousHash ‖ canonical form). Tamper-evident.
     * The original digest remains unchanged. The key and meta columns
     * are immutable (0016), with an append-only claim: rewriting the key used to leave the chain green
     * and let the original key post the movement again.
     */
    hash: text('hash').notNull(),
    previousHash: text('previous_hash'),
  },
  (t) => [
    uniqueIndex('ledger_tx_idempotency_idx').on(t.idempotencyKey),
    index('ledger_tx_seq_idx').on(t.seq),
    index('ledger_tx_module_idx').on(t.module, t.postedAt),
    /** The 8-character minimum `assertValidPost` states, enforced here too (0009). */
    check('ledger_tx_idempotency_key_len_ck', sql`length(idempotency_key) >= 8`),
  ],
);

/**
 * The posted idempotency claim (0017, 0018, 0021). Not a second book: no balance.
 *
 * `posted_hash` and `posted_meta` are the hash and meta stored at insert.
 * Append-only is a trigger (`ledger_posted_keys_immutable`), not a CHECK.
 */
export const ledgerPostedKeys = ledger.table(
  'ledger_posted_keys',
  {
    idempotencyKey: text('idempotency_key').primaryKey(),
    txId: uuid('tx_id').notNull(),
    postedHash: text('posted_hash').notNull(),
    postedMeta: jsonb('posted_meta').notNull(),
    /** 0021: digest of what the post moved (null for rows booked before 0021). */
    requestFingerprint: text('request_fingerprint'),
  },
  (t) => [
    uniqueIndex('ledger_posted_keys_tx_idx').on(t.txId),
    foreignKey({
      columns: [t.txId],
      foreignColumns: [ledgerTx.id],
      name: 'ledger_posted_keys_tx_id_fkey',
    }),
  ],
);

export const ledgerEntries = ledger.table(
  'ledger_entries',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    txId: uuid('tx_id').notNull(),
    accountId: uuid('account_id').notNull(),
    assetId: text('asset_id').notNull(),
    direction: directionEnum('direction').notNull(),
    amount: amount('amount').notNull(),
    /** Account balance immediately after this entry — the audit trail. */
    balanceAfter: amount('balance_after').notNull(),
  },
  (t) => [
    index('ledger_entries_tx_idx').on(t.txId),
    index('ledger_entries_account_idx').on(t.accountId, t.id),
    /**
     * Named explicitly to match the database. 0000 declared these inline
     * (`REFERENCES "ledger"."ledger_tx"("id")`), so Postgres named them
     * `<table>_<column>_fkey`. Drizzle's default name would be
     * `ledger_entries_tx_id_ledger_tx_id_fk` — a different name for the
     * identical constraint, which the drift gate would correctly report as a
     * difference. The database is the truth, so the database's names win.
     */
    foreignKey({ columns: [t.txId], foreignColumns: [ledgerTx.id], name: 'ledger_entries_tx_id_fkey' }),
    foreignKey({ columns: [t.accountId], foreignColumns: [accounts.id], name: 'ledger_entries_account_id_fkey' }),
    /**
     * 0006 — an entry may only name an asset the ledger knows. Denormalised
     * from the account, but written independently, so it is constrained
     * independently.
     */
    foreignKey({ columns: [t.assetId], foreignColumns: [assets.id], name: 'ledger_entries_asset_id_fk' }).onDelete('restrict'),
    /**
     * 0010 — and it must be the account's OWN asset.
     *
     * "Written independently" above was the whole gap: each column was
     * individually valid while the pair could disagree, so raw SQL could record a
     * `USDT` entry against a `BTC` account. The entry then lands in one asset's
     * book while `balance_after` describes a balance in another, and every guard
     * passes — the amount is positive, both assets are registered, and
     * reconciliation replays per asset so it re-derives the same wrong answer and
     * reports green.
     *
     * `postgres-ledger.ts` writes `entry.account.assetId` into both columns and
     * cannot produce a mismatch. Same argument as #1044, #1050 and #1067: that is
     * not the only insert path the README says will exist.
     */
    foreignKey({
      columns: [t.accountId, t.assetId],
      foreignColumns: [accounts.id, accounts.assetId],
      name: 'ledger_entries_account_asset_fk',
    })
      .onUpdate('restrict')
      .onDelete('restrict'),
    /** Direction carries the sign; the amount never does (0000). */
    check('ledger_entries_positive_ck', sql`amount > 0`),
  ],
);

export const balanceSnapshots = ledger.table(
  'balance_snapshots',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    accountId: uuid('account_id').notNull(),
    asOf: tstz('as_of').notNull(),
    balance: amount('balance').notNull(),
    /** Last entry included — where a replay check starts from. Not the chain tip. */
    throughEntryId: text('through_entry_id'),
    /**
     * `chain_tip.seq` held `FOR UPDATE` while `balance` was read (0015).
     * Null only on rows written before that column existed — a seq is never invented.
     */
    chainTipSeq: bigint('chain_tip_seq', { mode: 'bigint' }),
    /** `chain_tip.hash` under that same lock. Null at genesis and on pre-0015 rows. */
    chainTipHash: text('chain_tip_hash'),
  },
  (t) => [
    index('balance_snapshots_account_idx').on(t.accountId, t.asOf),
    foreignKey({ columns: [t.accountId], foreignColumns: [accounts.id], name: 'balance_snapshots_account_id_fkey' }),
  ],
);

/**
 * Single-row table holding the tip of the hash chain.
 *
 * Every post takes `FOR UPDATE` on this row, which is what makes the chain a
 * chain: transactions commit in a total order and each links to exactly one
 * predecessor. It also caps write throughput at one post at a time — an
 * accepted trade-off at soft-launch volume, and the §13 socket for sharding it
 * (per-asset chains with a periodic cross-chain anchor) is noted in the README.
 */
export const chainTip = ledger.table(
  'chain_tip',
  {
    id: boolean('id').primaryKey().default(true),
    hash: text('hash'),
    /**
     * `bigint DEFAULT 0`, not `bigserial`.
     *
     * This column mirrors `ledger_tx.seq`; it is assigned from that sequence,
     * never from one of its own. The file previously declared `bigserial` here,
     * which the generator turned into `truncate table chain_tip cascade` —
     * emptying the hash chain's tip in order to change a column type, on the
     * table whose single row IS the chain's anchor.
     *
     * Raw SQL for the default because drizzle-kit cannot JSON-serialise a
     * BigInt and throws while generating.
     */
    seq: bigint('seq', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  () => [check('chain_tip_singleton_ck', sql`id = true`)],
);

/**
 * Durable `ledgerTxPosted` publish intent (0013).
 *
 * Written in the same transaction as `ledger_tx`. `published_at` is null until
 * the bus accepts the event. Crash-after-commit recovery reads this table, not
 * the journal — historical txs from before 0013 have no row on purpose (they
 * may already have been published; re-firing them is not recover).
 *
 * Amounts in `payload.entries[].amount` are decimal strings. Postgres forbids
 * subqueries in CHECK, so the live rule is `jsonb_path_query_array`, not
 * `jsonb_array_elements`. A missing `entries` key fails. A JSON number amount
 * fails. An empty entries array passes. Forward migration 0019 installs the
 * complete decimal-string rule on databases that already applied 0013.
 */
export const ledgerTxOutbox = ledger.table(
  'ledger_tx_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    txId: uuid('tx_id').notNull(),
    payload: jsonb('payload').notNull(),
    correlationId: text('correlation_id').notNull(),
    createdAt: createdAt(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('ledger_tx_outbox_tx_idx').on(t.txId),
    index('ledger_tx_outbox_unpublished_idx')
      .on(t.createdAt)
      .where(sql`published_at IS NULL`),
    foreignKey({ columns: [t.txId], foreignColumns: [ledgerTx.id], name: 'ledger_tx_outbox_tx_id_fkey' }),
    check(
      'ledger_tx_outbox_amount_string_ck',
      sql`CASE WHEN jsonb_typeof(payload) = 'object' AND jsonb_typeof(payload -> 'entries') = 'array' THEN jsonb_array_length(jsonb_path_query_array(payload, 'strict $.entries[*] ? (@.type() == "object" && exists(@.amount) && @.amount.type() == "string" && @.amount like_regex "^-?[0-9]+([.][0-9]+)?$")', '{}'::jsonb, true)) = jsonb_array_length(payload -> 'entries') ELSE false END`,
    ),
  ],
);

/**
 * Durable `ledgerFreezeUpdated` publish intent (0020).
 *
 * Written in the same transaction as the `posting_freeze` update. `published_at`
 * is null until the bus accepts the event. A same-attribution retry does not
 * move the switch; it publishes this row. The payload is the freeze state the
 * bus already carries. It holds no amount.
 */
export const ledgerFreezeOutbox = ledger.table(
  'ledger_freeze_outbox',
  {
    switchSeq: bigserial('switch_seq', { mode: 'bigint' }).notNull(),
    id: uuid('id').primaryKey().defaultRandom(),
    idempotencyKey: text('idempotency_key').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: createdAt(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('ledger_freeze_outbox_switch_idx').on(t.switchSeq),
    uniqueIndex('ledger_freeze_outbox_key_idx').on(t.idempotencyKey),
    index('ledger_freeze_outbox_unpublished_idx')
      .on(t.switchSeq)
      .where(sql`published_at IS NULL`),
    check(
      'ledger_freeze_outbox_payload_ck',
      sql`coalesce(jsonb_typeof(payload) = 'object' AND jsonb_typeof(payload -> 'frozen') = 'boolean' AND jsonb_typeof(payload -> 'actor') = 'string' AND length(payload ->> 'actor') > 0 AND jsonb_typeof(payload -> 'changedAt') = 'string' AND length(payload ->> 'changedAt') > 0 AND (((payload ->> 'frozen') = 'false' AND jsonb_typeof(payload -> 'reason') = 'null') OR ((payload ->> 'frozen') = 'true' AND jsonb_typeof(payload -> 'reason') = 'string' AND length(payload ->> 'reason') > 0)), false)`,
    ),
  ],
);

/**
 * One row per reconciliation attempt that reached an outcome (0022).
 *
 * The covered tip is read in the proof's REPEATABLE READ snapshot. A short
 * READ COMMITTED transaction then commits either staged anchors + ok, or a
 * mismatch + durable freeze + outbox. Incomplete attempts freeze nothing;
 * staleness reporting measures from the last proved prefix.
 */
export const reconcileRuns = ledger.table(
  'reconcile_runs',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    startedAt: tstz('started_at').notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    outcome: text('outcome').notNull(),
    kind: text('kind').notNull().default('full'),
    throughSeq: bigint('through_seq', { mode: 'bigint' }),
    throughEntryId: text('through_entry_id'),
    tipHash: text('tip_hash'),
    errorCode: text('error_code'),
    detail: jsonb('detail'),
  },
  (t) => [
    index('reconcile_runs_ok_idx')
      .on(t.throughSeq.desc(), t.id.desc())
      .where(sql`outcome = 'ok'`),
    check('reconcile_runs_outcome_ck', sql`outcome IN ('ok', 'mismatch', 'incomplete')`),
    check('reconcile_runs_kind_ck', sql`kind IN ('full', 'incremental')`),
    check('reconcile_runs_ok_has_tip_ck', sql`outcome <> 'ok' OR through_seq IS NOT NULL`),
  ],
);

/**
 * Single-row table holding the posting freeze — the platform kill-switch.
 *
 * Durable rather than a field on LedgerService, because the freeze outranks the
 * process that set it: a restart must not resume posting on a book that
 * reconciliation halted, and a second replica must not keep writing to it.
 *
 * Read inside the same `FOR UPDATE` on `chain_tip` that every post already
 * takes (see postgres-ledger.ts) — so the check costs no extra round trip and,
 * more importantly, cannot be raced by a post already in flight.
 */
export const postingFreeze = ledger.table(
  'posting_freeze',
  {
    id: boolean('id').primaryKey().default(true),
    frozen: boolean('frozen').notNull().default(false),
    /** What a human reads at 3am to decide whether the halt can be lifted. */
    reason: text('reason'),
    /** Operator principal id, 'reconciliation', or 'env:LEDGER_POSTING_ENABLED'. */
    actor: text('actor'),
    changedAt: timestamp('changed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  () => [
    check('posting_freeze_singleton_ck', sql`id = true`),
    /** A freeze with no reason and no actor is unactionable (0002). */
    check('posting_freeze_attributed_ck', sql`frozen = false OR (length(coalesce(reason, '')) > 0 AND length(coalesce(actor, '')) > 0)`),
  ],
);

/**
 * One row per operator read of an owner's account detail (0024), lookup of one transaction (0026), or page of the ledger desk's list or address search (0028). Append-only by trigger; written BEFORE the read is
 * answered, so a read that cannot be recorded is refused.
 */
export const operatorAccessLog = ledger.table(
  'operator_access_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    targetOwnerType: text('target_owner_type').notNull(),
    targetOwnerId: text('target_owner_id').notNull(),
    requestId: text('request_id'),
    accessedAt: timestamp('accessed_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (t) => [
    index('operator_access_log_target_idx').on(t.targetOwnerType, t.targetOwnerId, t.accessedAt),
    check('operator_access_log_actor_ck', sql`length(actor_id) > 0`),
    check(
      'operator_access_log_action_ck',
      sql`action IN ('owner_balances.read', 'transaction.read', 'trace.read', 'transactions.list', 'accounts.search', 'account_metadata.read')`,
    ),
  ],
);

/**
 * One row per applied registry edit (0025). Append-only by trigger. The operation id makes a retried apply return the
 * first answer; the approval id and (asset, revision) can each be used once.
 */
export const assetEdits = ledger.table(
  'asset_edits',
  {
    operationId: text('operation_id').primaryKey(),
    approvalId: text('approval_id').notNull(),
    assetId: text('asset_id').notNull(),
    revision: integer('revision').notNull(),
    requesterId: text('requester_id').notNull(),
    approverId: text('approver_id').notNull(),
    operatorId: text('operator_id').notNull(),
    edit: jsonb('edit').notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.assetId], foreignColumns: [assets.id], name: 'asset_edits_asset_id_fk' }).onDelete('restrict'),
    unique('asset_edits_approval_uq').on(t.approvalId),
    unique('asset_edits_asset_revision_uq').on(t.assetId, t.revision),
    check('asset_edits_distinct_pair_ck', sql`${t.requesterId} <> ${t.approverId}`),
  ],
);

/**
 * Operator reconciliation controls (0027, OPS-reconciliation-01). The three built-in
 * rows are seeded by the migration. Deletes are refused by trigger, which this
 * description does not emit; schema-drift compares columns, checks and indexes.
 */
export const reconciliationControls = ledger.table(
  'reconciliation_controls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    builtin: boolean('builtin').notNull().default(false),
    builtinKey: text('builtin_key'),
    template: text('template').notNull(),
    checkKind: text('check_kind'),
    state: text('state').notNull().default('draft'),
    explanation: text('explanation').notNull().default(''),
    labels: jsonb('labels')
      .notNull()
      .default(sql`'[]'::jsonb`),
    schedule: jsonb('schedule'),
    severity: text('severity'),
    period: text('period'),
    tolerance: jsonb('tolerance'),
    margin: text('margin'),
    accountSet: jsonb('account_set').notNull(),
    threshold: jsonb('threshold'),
    version: integer('version').notNull().default(1),
    resumedAt: timestamp('resumed_at', { withTimezone: true, mode: 'date' }),
    definedBy: text('defined_by').notNull(),
    definedReason: text('defined_reason').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('reconciliation_controls_builtin_key_uq')
      .on(t.builtinKey)
      .where(sql`builtin_key IS NOT NULL`),
    check('reconciliation_controls_template_ck', sql`template IN ('ledger_invariant', 'outside_balance', 'threshold', 'source_parity')`),
    check('reconciliation_controls_state_ck', sql`state IN ('draft', 'active', 'paused', 'retired')`),
    check(
      'reconciliation_controls_check_kind_ck',
      sql`check_kind IS NULL OR check_kind IN ('replay', 'chain', 'netting', 'replay_and_netting')`,
    ),
    check('reconciliation_controls_severity_ck', sql`severity IS NULL OR severity IN ('info', 'warning', 'critical')`),
    check('reconciliation_controls_period_ck', sql`period IS NULL OR period IN ('hour', 'day', 'iso_week', 'month')`),
    check('reconciliation_controls_builtin_key_ck', sql`builtin = false OR builtin_key IS NOT NULL`),
    check('reconciliation_controls_builtin_active_ck', sql`builtin = false OR state = 'active'`),
    check('reconciliation_controls_explanation_ck', sql`length(explanation) <= 2000`),
    check('reconciliation_controls_labels_ck', sql`jsonb_typeof(labels) = 'array'`),
    check('reconciliation_controls_account_set_ck', sql`jsonb_typeof(account_set) = 'object'`),
    check('reconciliation_controls_tolerance_ck', sql`tolerance IS NULL OR jsonb_typeof(tolerance) = 'object'`),
    check('reconciliation_controls_schedule_ck', sql`schedule IS NULL OR jsonb_typeof(schedule) = 'object'`),
    check('reconciliation_controls_threshold_ck', sql`threshold IS NULL OR jsonb_typeof(threshold) = 'object'`),
    check('reconciliation_controls_margin_ck', sql`margin IS NULL OR margin ~ '^[0-9]+([.][0-9]{1,18})?$'`),
    check('reconciliation_controls_version_ck', sql`version >= 1`),
    check('reconciliation_controls_defined_by_ck', sql`length(defined_by) > 0`),
    check('reconciliation_controls_defined_reason_ck', sql`length(defined_reason) >= 12`),
  ],
);

export const reconciliationControlAudit = ledger.table(
  'reconciliation_control_audit',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    controlId: uuid('control_id').notNull(),
    actorId: text('actor_id').notNull(),
    reason: text('reason').notNull(),
    action: text('action').notNull(),
    requestId: text('request_id'),
    detail: jsonb('detail').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.controlId],
      foreignColumns: [reconciliationControls.id],
      name: 'reconciliation_control_audit_control_id_fkey',
    }),
    index('reconciliation_control_audit_control_idx').on(t.controlId, t.recordedAt),
    check('reconciliation_control_audit_actor_ck', sql`length(actor_id) > 0`),
    check('reconciliation_control_audit_reason_ck', sql`length(reason) > 0`),
    check('reconciliation_control_audit_action_ck', sql`action IN ('define', 'update', 'run')`),
    check('reconciliation_control_audit_detail_ck', sql`jsonb_typeof(detail) = 'object'`),
  ],
);

export const reconciliationControlRuns = ledger.table(
  'reconciliation_control_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    controlId: uuid('control_id').notNull(),
    operationId: text('operation_id'),
    fingerprint: text('fingerprint').notNull(),
    status: text('status').notNull(),
    phase: text('phase').notNull().default(''),
    errorCode: text('error_code').notNull().default(''),
    asOf: timestamp('as_of', { withTimezone: true, mode: 'date' }).notNull(),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }).notNull(),
    margin: text('margin').notNull(),
    sources: jsonb('sources').notNull(),
    evidence: jsonb('evidence')
      .notNull()
      .default(sql`'{}'::jsonb`),
    outsideSide: text('outside_side').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true, mode: 'date' }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true, mode: 'date' }).notNull(),
    actorId: text('actor_id').notNull(),
    reason: text('reason').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    foreignKey({
      columns: [t.controlId],
      foreignColumns: [reconciliationControls.id],
      name: 'reconciliation_control_runs_control_id_fkey',
    }),
    uniqueIndex('reconciliation_control_runs_operation_uq')
      .on(t.operationId)
      .where(sql`operation_id IS NOT NULL`),
    index('reconciliation_control_runs_control_idx').on(t.controlId, t.periodStart),
    check('reconciliation_control_runs_status_ck', sql`status IN ('started', 'PASS', 'FAIL', 'ERROR', 'UNSET')`),
    check('reconciliation_control_runs_margin_ck', sql`margin = 'unset' OR margin ~ '^[0-9]+([.][0-9]{1,18})?$'`),
    check('reconciliation_control_runs_outside_ck', sql`outside_side IN ('unset', 'snapshot', 'unavailable', 'not_applicable')`),
    check('reconciliation_control_runs_sources_ck', sql`jsonb_typeof(sources) = 'object'`),
    check('reconciliation_control_runs_evidence_ck', sql`jsonb_typeof(evidence) = 'object'`),
    check('reconciliation_control_runs_actor_ck', sql`length(actor_id) > 0`),
    check('reconciliation_control_runs_reason_ck', sql`length(reason) >= 12`),
    check('reconciliation_control_runs_fingerprint_ck', sql`length(fingerprint) > 0`),
  ],
);

/**
 * Operator metadata on a ledger account (0029, OPS-ledger-desk-01): one row per key with its current value. A deleted
 * key keeps its row with a NULL value, so the revision only grows. Not a posting and not part of the hash chain.
 */
export const accountMetadata = ledger.table(
  'account_metadata',
  {
    accountId: uuid('account_id').notNull(),
    key: text('key').notNull(),
    value: text('value'),
    revision: integer('revision').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedBy: text('updated_by').notNull(),
  },
  (t) => [
    primaryKey({ name: 'account_metadata_pk', columns: [t.accountId, t.key] }),
    foreignKey({ columns: [t.accountId], foreignColumns: [accounts.id], name: 'account_metadata_account_fk' }).onDelete('restrict'),
    check('account_metadata_key_ck', sql`key ~ '^[a-z][a-z0-9_.:-]{0,63}$'`),
    check('account_metadata_value_ck', sql`value IS NULL OR (length(value) BETWEEN 1 AND 500)`),
    check('account_metadata_revision_ck', sql`revision >= 1`),
  ],
);

/**
 * Every set and delete of account metadata (0029), with the value before and after, who asked, who approved a delete
 * and why. Append-only by trigger.
 */
export const accountMetadataChanges = ledger.table(
  'account_metadata_changes',
  {
    seq: bigserial('seq', { mode: 'bigint' }).primaryKey(),
    accountId: uuid('account_id').notNull(),
    key: text('key').notNull(),
    action: text('action').notNull(),
    before: text('before'),
    after: text('after'),
    revision: integer('revision').notNull(),
    requesterId: text('requester_id').notNull(),
    approverId: text('approver_id'),
    approvalId: text('approval_id'),
    reason: text('reason').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.accountId], foreignColumns: [accounts.id], name: 'account_metadata_changes_account_fk' }).onDelete('restrict'),
    unique('account_metadata_changes_revision_uq').on(t.accountId, t.key, t.revision),
    unique('account_metadata_changes_approval_uq').on(t.approvalId),
    index('account_metadata_changes_account_idx').on(t.accountId, t.seq),
    check('account_metadata_changes_action_ck', sql`action IN ('set', 'delete')`),
    check('account_metadata_changes_reason_ck', sql`length(reason) BETWEEN 12 AND 500`),
    check('account_metadata_changes_requester_ck', sql`length(requester_id) > 0`),
    check(
      'account_metadata_changes_shape_ck',
      sql`(action = 'set' AND after IS NOT NULL AND approval_id IS NULL AND approver_id IS NULL) OR (action = 'delete' AND after IS NULL AND before IS NOT NULL AND approval_id IS NOT NULL AND approver_id IS NOT NULL AND approver_id <> requester_id)`,
    ),
  ],
);

export const schema = {
  assets,
  accounts,
  ledgerTx,
  ledgerPostedKeys,
  ledgerEntries,
  balanceSnapshots,
  chainTip,
  postingFreeze,
  ledgerTxOutbox,
  ledgerFreezeOutbox,
};
