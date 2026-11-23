-- svc-ledger · the identifier space of accounts.owner_id (§4.2)
-- Reversal: 0005_owner_identifier_space.down.sql
--
-- intafaced:destructive — STEP 2 DELETEs account rows that provably hold nothing
-- and have never appeared in the journal. Justified in full at that step; no
-- balance, entry, or snapshot is reachable from any row it can touch.
--
--
-- WHAT WAS WRONG
--
-- `owner_type` said what ROLE an owner plays. Nothing said which IDENTIFIER
-- SPACE `owner_id` was drawn from, and `owner_id` is `text`, so it took any.
--
--   identity.users.id            uuid      (services/svc-identity/drizzle/0000, line 21)
--   vendored member.id           bigint    (vendor/.../entity/Member.java, line 29)
--   ledger.accounts.owner_id     text      (this service, 0000_ledger_init.sql, line 37)
--
-- The 2026-08-02 ADR accepted keeping the vendored product's money controllers
-- and redirecting only their balance writes into this book through an adapter.
-- An adapter that passes `String(member.id)` where a user UUID belongs does not
-- fail. It opens a SECOND, perfectly conformant account for the same human:
--
--   ('user', '1042',                                 'USDT', 'available', '')
--   ('user', '0007e7f3-2e25-4dc9-88b4-146db6d491f0', 'USDT', 'available', '')
--
-- Both are distinct under `accounts_identity_purpose_idx`, so nothing raises.
-- Both satisfy `accounts_non_negative_ck`. Their transactions sum to zero, the
-- hash chain verifies, `reconcileBalances` replays every entry and finds no
-- drift, and `pnpm gate svc-ledger` is green. There is no query over this book
-- that distinguishes the two — the balances are individually correct, and the
-- only thing that is wrong is that they belong to one person. That is the
-- dual-book failure the ADR exists to prevent, re-entering through the adapter
-- the ADR itself introduced, and it is invisible from inside the ledger.
--
--
-- THE FIX, AND WHY IT IS NOT A NEW COLUMN
--
-- The obvious move is an `owner_ns` column declaring the space. It does not
-- work: the namespace would be supplied by the same caller that supplies the
-- id, so an adapter passing a bigint would pass `ns='member'` next to it and
-- the pair would be internally consistent and accepted. It relocates the hole.
--
-- The space must be a function of something the ledger already knows without
-- asking, and `owner_type` is exactly that. So the constraint BINDS the two:
--
--   user, subaccount          → a lowercase canonical UUID
--   module, house, treasury   → a namespaced platform slug (`fees:trade`)
--
-- Application code checks the identical rule first (`assertOwnerIdentifierSpace`
-- in packages/ledger-client/src/client.ts) for a legible error. This CHECK is
-- what makes it true. An adapter is precisely the kind of caller that reaches
-- around a client library, and §4.2's other invariants already live down here
-- for the same reason.
--
--
-- ORDER MATTERS: BACKFILL, THEN CONSTRAIN
--
-- A constraint added ahead of its backfill passes on an empty database and
-- fails on a populated one — which is a deploy that stops mid-flight, not a
-- test that goes red. Steps 1-3 make the table conform, and only then does
-- step 4 constrain it.

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1 · CANONICALISE — lossless, and it closes a second door.
--
-- '550E8400-…' and '550e8400-…' are the same human and two different rows under
-- the identity index: the dual-book failure again, in different clothing. The
-- canonical form is the only one anything legitimately emits (Postgres renders
-- `uuid` lowercase; so do `crypto.randomUUID()` and Java's `UUID.toString()`),
-- so lowercasing changes no owner — it only merges spellings of one.
--
-- Refuse rather than merge if the lowercase form already exists as its own row.
-- Combining two balances is a value movement, and a value movement is a
-- double-entry post (§0.6). A migration that did it with an UPDATE would be
-- moving money outside the ledger, in the migration that exists to protect the
-- ledger.
DO $$
DECLARE
  colliding bigint;
BEGIN
  SELECT count(*) INTO colliding
    FROM "ledger"."accounts" a
   WHERE a."owner_type" IN ('user', 'subaccount')
     AND a."owner_id" <> lower(a."owner_id")
     AND EXISTS (
       SELECT 1 FROM "ledger"."accounts" b
        WHERE b."owner_type" = a."owner_type"
          AND b."owner_id"   = lower(a."owner_id")
          AND b."asset_id"   = a."asset_id"
          AND b."kind"       = a."kind"
          AND b."purpose"    = a."purpose"
     );

  IF colliding > 0 THEN
    RAISE EXCEPTION
      'Cannot apply 0005: % account row(s) differ from an existing row only by the CASE of a UUID owner_id. '
      'That is one human holding two balances, and merging them is a value movement that must be a ledger '
      'post, not an UPDATE in a migration (Doctrine 0.6). Settle one side to zero through ledger-client '
      'first, then re-run.', colliding;
  END IF;
END $$;

UPDATE "ledger"."accounts"
   SET "owner_id" = lower("owner_id")
 WHERE "owner_type" IN ('user', 'subaccount')
   AND "owner_id" <> lower("owner_id")
   AND "owner_id" ~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$';

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2 · RECLAIM — delete violating rows that have never held anything.
--
-- An account row can exist having never participated in the book: `upsertAccount`
-- creates it during a post, and a wrong-space id is exactly the mistake a new
-- adapter makes while it is being wired up in staging. Such a row has balance 0,
-- no entries and no snapshots. Deleting it destroys no value and no audit trail
-- — there is, provably, none to destroy — and it is the difference between the
-- migration completing and a developer having to hand-clean staging before a
-- production deploy can proceed.
--
-- All three conditions are required. Balance alone is not enough: an account
-- that moved value and came back to zero still has a journal, and that journal
-- is the record of what happened to it.
DELETE FROM "ledger"."accounts" a
 WHERE (
         (a."owner_type" IN ('user', 'subaccount')
          AND a."owner_id" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      OR (a."owner_type" IN ('module', 'house', 'treasury')
          AND (a."owner_id" !~ '^[a-z][a-z0-9_-]*(:[A-Za-z0-9._-]+)*$'
               OR a."owner_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
       )
   AND a."balance" = 0
   AND NOT EXISTS (SELECT 1 FROM "ledger"."ledger_entries"     e WHERE e."account_id" = a."id")
   AND NOT EXISTS (SELECT 1 FROM "ledger"."balance_snapshots"  s WHERE s."account_id" = a."id");

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3 · REFUSE — anything left holds value under an owner we cannot name.
--
-- There is no honest automatic repair for it. The mapping from a vendored
-- `member.id` to a user UUID lives in the adapter, which does not exist yet;
-- guessing one would move a real balance to a possibly-wrong human, and
-- deleting it would destroy value. Precedent: 0001's reversal refuses on the
-- same principle rather than silently merging holds.
--
-- Failing here is the point. It fails at migrate time, naming every offending
-- row, on the populated database where the problem actually is — instead of
-- succeeding on an empty one and taking the service down on deploy.
DO $$
DECLARE
  offenders text;
  n bigint;
BEGIN
  SELECT count(*), string_agg(format('%s/%s %s %s = %s', "owner_type", "owner_id", "asset_id", "kind", "balance"), E'\n  ')
    INTO n, offenders
    FROM "ledger"."accounts"
   WHERE (
           ("owner_type" IN ('user', 'subaccount')
            AND "owner_id" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
        OR ("owner_type" IN ('module', 'house', 'treasury')
            AND ("owner_id" !~ '^[a-z][a-z0-9_-]*(:[A-Za-z0-9._-]+)*$'
                 OR "owner_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
         );

  IF n > 0 THEN
    RAISE EXCEPTION
      E'Cannot apply 0005: % account row(s) hold value under an owner_id that is not from the space their '
      'owner_type declares. Each one is a candidate second book for a human who may already have an '
      'account.\n  %\n'
      'user/subaccount owner_id must be a lowercase UUID; module/house/treasury must be a namespaced slug '
      'such as "fees:trade". Resolve each by moving the balance to the correct owner through '
      'packages/ledger-client (a post, never an UPDATE), then re-run this migration.', n, offenders;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4 · CONSTRAIN.
--
-- Kept character-for-character identical to `isValidOwnerId` in
-- packages/ledger-client/src/types.ts. Equivalence is asserted case-for-case,
-- against a live Postgres, in src/ledger/owner-identity.pg.test.ts — a comment
-- claiming two regexes agree is not evidence that they do.
--
-- Later slug segments stay permissive because they legitimately carry UUIDs and
-- venue codes (`pay:clearing:<merchantId>`, `venue:BINANCE`). The FIRST
-- character is what does the work: a lowercase letter is required, so a bare
-- `1042` cannot land in a platform account either. The `!~` UUID clause covers
-- the remaining overlap — a UUID beginning with a hex letter (`a50e8400-…`)
-- otherwise satisfies the slug grammar, which would let a user id sit in a
-- `house` or `treasury` account: the same confusion running the other way.
ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_owner_id_space_ck";
ALTER TABLE "ledger"."accounts" ADD CONSTRAINT "accounts_owner_id_space_ck"
  CHECK (
    CASE
      WHEN "owner_type" IN ('user', 'subaccount')
        THEN "owner_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ELSE "owner_id" ~ '^[a-z][a-z0-9_-]*(:[A-Za-z0-9._-]+)*$'
       AND "owner_id" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    END
  );
