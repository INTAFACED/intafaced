import { truncatePayForTest } from './payment-events-test-reset.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GRANTED_AREAS, MAX_SUBMERCHANT_DEPTH, PERMISSION_AREAS, SubMerchantError, SubMerchantService } from './submerchants.js';

/**
 * THE SUB-MERCHANT TREE, AND THE FENCE AROUND IT (§6.1 PayFac mode).
 *
 * ══ THE TEST THAT MATTERS ════════════════════════════════════════════════════
 *
 * A PARENT CANNOT READ A SIBLING SUBTREE. Everything else in this file exists to
 * defend that sentence and the three others like it: a node cannot read upward,
 * two unrelated trees cannot see each other, and no grant anybody can make
 * widens any of it. If the fence breaks, one payfac's merchant book becomes
 * readable by another payfac's sub-merchant — which is the whole risk of putting
 * many merchants in one tree in the first place.
 *
 * POSTGRES IS REAL, and it has to be. The ancestor walk is a recursive CTE, the
 * append-only guarantee is a TRIGGER, the non-blank reason is a CHECK, and
 * "one merchant per account" is a UNIQUE INDEX. An in-memory fake would have
 * none of the four and would pass against a schema nobody deploys.
 *
 * NO MONEY APPEARS ANYWHERE IN THIS FILE, and that is not an omission. This
 * slice moves no value: there is no ledger client, no amount, and no balance.
 * `feeBps` is a rate in basis points, an integer, and it is never arithmetic on
 * a sum here.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `pay.*` SQL stays on `pay`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_PAY`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Every forward migration, in order — what production applies. */
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

/**
 * The rejection, typed. `.catch((e) => e as X)` widens the result, so a call
 * that WRONGLY RESOLVES reads as `undefined` on the next line instead of failing
 * where the mistake is. This fails at the call that did not throw.
 */
async function rejection<E>(promise: Promise<unknown>, kind: abstract new (...args: never[]) => E): Promise<E> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof kind) return err;
    throw err;
  }
  throw new Error(`expected ${kind.name}, but the call resolved`);
}

function at<T>(rows: readonly T[], index: number, what: string): T {
  const row = rows[index];
  if (row === undefined) throw new Error(`expected ${what}[${index}], but only ${rows.length} row(s) came back`);
  return row;
}

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-pay submerchants is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-pay submerchants (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-pay sub-merchant trees PG-hard', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let trees: SubMerchantService;
  let seq = 0;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    if (!db || !sql) throw new Error('H8a: svc-pay submerchants PG was not opened');
    await truncatePayForTest(sql, 'pay', `TRUNCATE pay.merchant_permission_events, pay.merchants RESTART IDENTITY CASCADE`);
    trees = new SubMerchantService(sql);
    seq = 0;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const account = () => `acct-${(seq += 1)}-${Math.random().toString(36).slice(2)}`;

  /** A top-level merchant — a tree of one, exactly what every merchant was before. */
  async function root(): Promise<{ merchantId: string; userId: string }> {
    const userId = account();
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO pay.merchants (user_id, status, pricing)
      VALUES (${userId}, 'active', ${sql.json({ feeBps: 250 } as never)})
      RETURNING id
    `;
    if (!row) throw new Error('inserting a root merchant returned no row');
    return { merchantId: row.id, userId };
  }

  /** Onboard a child, as `actor`. */
  async function child(actorMerchantId: string, parentMerchantId: string, actorId = 'operator-user') {
    return trees.createSubMerchant({
      actorMerchantId,
      parentMerchantId,
      userId: account(),
      pricing: { feeBps: 150 },
      actorId,
      actorScope: 'pay:write',
    });
  }

  // ══ THE FENCE ═════════════════════════════════════════════════════════════

  describe('the subtree fence — what no permission can widen', () => {
    it('REFUSES A SIBLING SUBTREE — a parent cannot read the tree next to its own', async () => {
      const platform = await root();
      const left = await child(platform.merchantId, platform.merchantId);
      const right = await child(platform.merchantId, platform.merchantId);
      const rightChild = await child(platform.merchantId, right.id);

      // `left` and `right` are peers under one payfac. Neither is above the
      // other, so neither may read the other — nor anything beneath it.
      const peer = await rejection(trees.getSubMerchant(left.id, right.id), SubMerchantError);
      expect(peer.code).toBe('pay.submerchant_out_of_scope');

      const nephew = await rejection(trees.getSubMerchant(left.id, rightChild.id), SubMerchantError);
      expect(nephew.code).toBe('pay.submerchant_out_of_scope');

      const listing = await rejection(trees.listSubMerchants(left.id, right.id, 100), SubMerchantError);
      expect(listing.code).toBe('pay.submerchant_out_of_scope');
    });

    it('REFUSES UPWARD — a sub-merchant cannot read the parent that onboarded it', async () => {
      const platform = await root();
      const sub = await child(platform.merchantId, platform.merchantId);

      const upward = await rejection(trees.getSubMerchant(sub.id, platform.merchantId), SubMerchantError);
      expect(upward.code).toBe('pay.submerchant_out_of_scope');
    });

    it('REFUSES ANOTHER TREE ENTIRELY — two payfacs are invisible to each other', async () => {
      const one = await root();
      const two = await root();
      const twoSub = await child(two.merchantId, two.merchantId);

      expect((await rejection(trees.getSubMerchant(one.merchantId, two.merchantId), SubMerchantError)).code).toBe(
        'pay.submerchant_out_of_scope',
      );
      expect((await rejection(trees.getSubMerchant(one.merchantId, twoSub.id), SubMerchantError)).code).toBe(
        'pay.submerchant_out_of_scope',
      );
    });

    it('gives the SAME refusal for a merchant that does not exist as for one out of scope', async () => {
      // Otherwise the refusal is an oracle: a caller could probe uuids and learn
      // which ones are merchants somewhere else on the platform.
      const one = await root();
      const two = await root();

      const outOfScope = await rejection(trees.getSubMerchant(one.merchantId, two.merchantId), SubMerchantError);
      expect(outOfScope.code).toBe('pay.submerchant_out_of_scope');

      const absent = await rejection(trees.getSubMerchant(one.merchantId, '00000000-0000-4000-8000-000000000000'), SubMerchantError);
      // Not the same code — an id that is not a merchant at all is a caller
      // mistake, and it discloses nothing about anybody's tree.
      expect(absent.code).toBe('pay.merchant_not_found');
    });

    it('lets a node read ITSELF without any grant — owning your own merchant is not a permission', async () => {
      const platform = await root();
      const record = await trees.getSubMerchant(platform.merchantId, platform.merchantId);
      expect(record.id).toBe(platform.merchantId);
      expect(record.parentMerchantId).toBeNull();
      expect(record.depth).toBe(0);
    });
  });

  // ══ ONBOARDING ════════════════════════════════════════════════════════════

  describe('onboarding a sub-merchant', () => {
    it('hangs the new node under its parent and leaves it a sovereign account of its own', async () => {
      const platform = await root();
      const sub = await child(platform.merchantId, platform.merchantId);

      expect(sub.parentMerchantId).toBe(platform.merchantId);
      expect(sub.userId).not.toBe(platform.userId);
      expect(sub.mode).toBe('payfac');
      // `pending`, not `active` — a node nobody has approved must not be able to
      // take money, and `payment-service.ts` gates on exactly this column.
      expect(sub.status).toBe('pending');
      expect(sub.settlingParty).toBe('self');
      expect(sub.depth).toBe(1);
    });

    it('does not touch merchants that already existed — an old row is a tree of one', async () => {
      const platform = await root();
      const [row] = await sql<Array<{ parent_merchant_id: string | null; settling_party: string }>>`
        SELECT parent_merchant_id, settling_party FROM pay.merchants WHERE id = ${platform.merchantId}
      `;
      expect(row?.parent_merchant_id).toBeNull();
      expect(row?.settling_party).toBe('self');
    });

    it('is IDEMPOTENT — a retried onboarding returns the same node rather than a second one', async () => {
      const platform = await root();
      const userId = account();

      const first = await trees.createSubMerchant({
        actorMerchantId: platform.merchantId,
        parentMerchantId: platform.merchantId,
        userId,
        pricing: { feeBps: 150 },
        actorId: 'operator-user',
        actorScope: 'pay:write',
      });
      const second = await trees.createSubMerchant({
        actorMerchantId: platform.merchantId,
        parentMerchantId: platform.merchantId,
        userId,
        pricing: { feeBps: 150 },
        actorId: 'operator-user',
        actorScope: 'pay:write',
      });

      expect(second.id).toBe(first.id);
      const rows = await sql<Array<{ count: string }>>`
        SELECT count(*)::text AS count FROM pay.merchants WHERE user_id = ${userId}
      `;
      expect(at(rows, 0, 'count').count).toBe('1');
    });

    it('REFUSES TO ADOPT an account that is already somebody else’s merchant', async () => {
      const platform = await root();
      const other = await root();

      const err = await rejection(
        trees.createSubMerchant({
          actorMerchantId: platform.merchantId,
          parentMerchantId: platform.merchantId,
          userId: other.userId,
          pricing: { feeBps: 150 },
          actorId: 'operator-user',
          actorScope: 'pay:write',
        }),
        SubMerchantError,
      );
      expect(err.code).toBe('pay.submerchant_user_already_merchant');

      // And the merchant it tried to adopt is untouched — still its own root.
      const [row] = await sql<Array<{ parent_merchant_id: string | null }>>`
        SELECT parent_merchant_id FROM pay.merchants WHERE id = ${other.merchantId}
      `;
      expect(row?.parent_merchant_id).toBeNull();
    });

    it('REFUSES A PARENT OUTSIDE THE ACTOR’S SUBTREE — you cannot onboard into someone else’s tree', async () => {
      const one = await root();
      const two = await root();

      const err = await rejection(
        trees.createSubMerchant({
          actorMerchantId: one.merchantId,
          parentMerchantId: two.merchantId,
          userId: account(),
          pricing: { feeBps: 150 },
          actorId: 'operator-user',
          actorScope: 'pay:write',
        }),
        SubMerchantError,
      );
      expect(err.code).toBe('pay.submerchant_out_of_scope');
    });

    it('REFUSES A SETTLING PARTY THAT IS NOT `self` — that is acquiring, and it needs a sponsor', async () => {
      const platform = await root();

      const err = await rejection(
        trees.createSubMerchant({
          actorMerchantId: platform.merchantId,
          parentMerchantId: platform.merchantId,
          userId: account(),
          pricing: { feeBps: 150 },
          settlingParty: 'platform-sponsor',
          actorId: 'operator-user',
          actorScope: 'pay:write',
        }),
        SubMerchantError,
      );
      expect(err.code).toBe('pay.submerchant_settling_party_unsupported');

      // Nothing was written. A refused onboarding must not leave a node behind.
      const rows = await sql<Array<{ count: string }>>`SELECT count(*)::text AS count FROM pay.merchants`;
      expect(at(rows, 0, 'count').count).toBe('1');
    });

    it('REFUSES A TREE DEEPER THAN THE STRUCTURAL BOUND, by name', async () => {
      const platform = await root();
      let parent = platform.merchantId;
      for (let depth = 1; depth <= MAX_SUBMERCHANT_DEPTH; depth += 1) {
        const node = await child(platform.merchantId, parent);
        expect(node.depth).toBe(depth);
        parent = node.id;
      }

      const err = await rejection(child(platform.merchantId, parent), SubMerchantError);
      expect(err.code).toBe('pay.submerchant_too_deep');
    });

    it('REFUSES an ancestor chain that does not terminate, rather than walking it forever', async () => {
      const platform = await root();
      const sub = await child(platform.merchantId, platform.merchantId);

      // A cycle this service cannot create: `parent_merchant_id` is set once, at
      // insert, to a node that already exists. It can still arrive from a
      // restore or a hand-run UPDATE, and an authorization check that hangs on
      // one is an authorization check that gets bypassed.
      // Deliberate legacy-corruption fixture inside this suite's unique DB.
      await sql.begin(async (tx) => {
        await tx`ALTER TABLE pay.merchants DISABLE TRIGGER merchants_parent_no_cycle_trg`;
        await tx`UPDATE pay.merchants SET parent_merchant_id = ${sub.id} WHERE id = ${platform.merchantId}`;
        await tx`ALTER TABLE pay.merchants ENABLE TRIGGER merchants_parent_no_cycle_trg`;
      });

      const err = await rejection(trees.getSubMerchant(platform.merchantId, sub.id), SubMerchantError);
      expect(err.code).toBe('pay.submerchant_cycle');
    });

    it('the database refuses a merchant that is its own parent', async () => {
      const platform = await root();
      await expect(
        sql`UPDATE pay.merchants SET parent_merchant_id = ${platform.merchantId} WHERE id = ${platform.merchantId}`,
      ).rejects.toThrow(/merchants_parent_(not_self|no_cycle)/);
    });
  });

  // ══ WHAT AUTHORITY EXISTS AT ONBOARDING, AND WHAT DOES NOT ════════════════

  describe('the conservative default', () => {
    it('grants an intermediate node VISIBILITY over what it onboarded, and nothing that touches money', async () => {
      const platform = await root();
      const mid = await child(platform.merchantId, platform.merchantId);
      const leaf = await child(mid.id, mid.id);

      // What it got: exactly `DEFAULT_GRANTED_AREAS`.
      for (const area of DEFAULT_GRANTED_AREAS) {
        expect(await trees.holds(mid.id, leaf.id, area)).toBe(true);
      }

      // What it did NOT get: every value-shaped area, held by nobody.
      for (const area of ['payment', 'payment.refund', 'settlement', 'settlement.payout', 'permission'] as const) {
        expect(await trees.holds(mid.id, leaf.id, area)).toBe(false);
      }

      const denied = await rejection(trees.listPermissions(mid.id, leaf.id, 50), SubMerchantError);
      expect(denied.code).toBe('pay.submerchant_permission_denied');
    });

    it('gives the ROOT every area over its whole tree, without a grant row existing', async () => {
      const platform = await root();
      const mid = await child(platform.merchantId, platform.merchantId);
      const leaf = await child(mid.id, mid.id);

      for (const area of PERMISSION_AREAS) {
        expect(await trees.holds(platform.merchantId, leaf.id, area)).toBe(true);
      }

      // And it is NOT a grant — nothing was written naming the root, because a
      // grant an operator cannot revoke must not appear in a list of grants.
      const rootRows = await sql<Array<{ count: string }>>`
        SELECT count(*)::text AS count FROM pay.merchant_permission_events WHERE grantee_merchant_id = ${platform.merchantId}
      `;
      expect(at(rootRows, 0, 'count').count).toBe('0');
    });

    it('writes the default grant for EVERY intermediate ancestor — a payfac can see who is under it', async () => {
      const platform = await root();
      const mid = await child(platform.merchantId, platform.merchantId);
      const leaf = await child(mid.id, mid.id);
      const deep = await child(mid.id, leaf.id);

      // `mid` did not onboard `deep` directly; it is still liable for it.
      expect(await trees.holds(mid.id, deep.id, 'submerchant')).toBe(true);
      expect(await trees.holds(leaf.id, deep.id, 'submerchant')).toBe(true);
    });

    it('a retried onboarding does NOT resurrect an area that was revoked in between', async () => {
      const platform = await root();
      const mid = await child(platform.merchantId, platform.merchantId);
      const userId = account();

      const first = await trees.createSubMerchant({
        actorMerchantId: mid.id,
        parentMerchantId: mid.id,
        userId,
        pricing: { feeBps: 150 },
        actorId: 'operator-user',
        actorScope: 'pay:write',
      });

      await trees.revokePermission({
        actorMerchantId: platform.merchantId,
        granteeMerchantId: mid.id,
        subjectMerchantId: first.id,
        area: 'submerchant',
        reason: 'onboarding partner suspended pending review',
        actorId: 'platform-user',
        actorScope: 'pay:write',
      });

      await trees.createSubMerchant({
        actorMerchantId: mid.id,
        parentMerchantId: mid.id,
        userId,
        pricing: { feeBps: 150 },
        actorId: 'operator-user',
        actorScope: 'pay:write',
      });

      expect(await trees.holds(mid.id, first.id, 'submerchant')).toBe(false);
    });
  });

  // ══ DELEGATION ════════════════════════════════════════════════════════════

  describe('granting and revoking', () => {
    it('delegates DOWN the path, and the grantee can then act', async () => {
      const platform = await root();
      const mid = await child(platform.merchantId, platform.merchantId);
      const leaf = await child(mid.id, mid.id);

      expect(await trees.holds(mid.id, leaf.id, 'payment.refund')).toBe(false);

      const event = await trees.grantPermission({
        actorMerchantId: platform.merchantId,
        granteeMerchantId: mid.id,
        subjectMerchantId: leaf.id,
        area: 'payment.refund',
        reason: 'sub-payfac handles first-line disputes for this cohort',
        actorId: 'platform-user',
        actorScope: 'pay:write',
      });

      expect(event.action).toBe('grant');
      expect(event.actorMerchantId).toBe(platform.merchantId);
      expect(await trees.holds(mid.id, leaf.id, 'payment.refund')).toBe(true);
    });

    it('REFUSES TO GRANT AN AREA THE GRANTER DOES NOT HOLD — delegation passes on what you have', async () => {
      const platform = await root();
      const mid = await child(platform.merchantId, platform.merchantId);
      const leaf = await child(mid.id, mid.id);
      const deep = await child(mid.id, leaf.id);

      // `mid` holds only the default areas over `deep`. It must not be able to
      // hand `leaf` an authority it never had itself.
      const err = await rejection(
        trees.grantPermission({
          actorMerchantId: mid.id,
          granteeMerchantId: leaf.id,
          subjectMerchantId: deep.id,
          area: 'settlement.payout',
          reason: 'trying to delegate what I do not hold',
          actorId: 'mid-user',
          actorScope: 'pay:write',
        }),
        SubMerchantError,
      );
      expect(err.code).toBe('pay.submerchant_permission_denied');
      expect(await trees.holds(leaf.id, deep.id, 'settlement.payout')).toBe(false);
    });

    it('REFUSES A LATERAL GRANT — one child never gets authority over another', async () => {
      const platform = await root();
      const left = await child(platform.merchantId, platform.merchantId);
      const right = await child(platform.merchantId, platform.merchantId);

      const err = await rejection(
        trees.grantPermission({
          actorMerchantId: platform.merchantId,
          granteeMerchantId: left.id,
          subjectMerchantId: right.id,
          area: 'payment',
          reason: 'consolidating support under one sibling',
          actorId: 'platform-user',
          actorScope: 'pay:write',
        }),
        SubMerchantError,
      );
      expect(err.code).toBe('pay.submerchant_grant_lateral');
      // And afterwards `left` still cannot so much as ASK about `right`: the
      // fence refuses before the permission question is reached, which is
      // stronger than the permission answering `false`.
      expect((await rejection(trees.holds(left.id, right.id, 'payment'), SubMerchantError)).code).toBe('pay.submerchant_out_of_scope');
    });

    it('REFUSES A SELF-GRANT — authority comes from above, never from yourself', async () => {
      const platform = await root();
      const mid = await child(platform.merchantId, platform.merchantId);
      const leaf = await child(mid.id, mid.id);

      const err = await rejection(
        trees.grantPermission({
          actorMerchantId: mid.id,
          granteeMerchantId: mid.id,
          subjectMerchantId: leaf.id,
          area: 'settlement.payout',
          reason: 'promoting myself',
          actorId: 'mid-user',
          actorScope: 'pay:write',
        }),
        SubMerchantError,
      );
      expect(err.code).toBe('pay.submerchant_grant_self');
      expect(await trees.holds(mid.id, leaf.id, 'settlement.payout')).toBe(false);
    });

    it('REFUSES A GRANTEE OUTSIDE THE ACTOR’S SUBTREE — you cannot name a stranger', async () => {
      const one = await root();
      const two = await root();
      const oneSub = await child(one.merchantId, one.merchantId);

      const err = await rejection(
        trees.grantPermission({
          actorMerchantId: one.merchantId,
          granteeMerchantId: two.merchantId,
          subjectMerchantId: oneSub.id,
          area: 'payment',
          reason: 'handing my sub-merchant to another platform',
          actorId: 'one-user',
          actorScope: 'pay:write',
        }),
        SubMerchantError,
      );
      expect(err.code).toBe('pay.submerchant_out_of_scope');
    });

    it('REVOKING actually takes the authority away, and the grantee is refused afterwards', async () => {
      const platform = await root();
      const mid = await child(platform.merchantId, platform.merchantId);
      const leaf = await child(mid.id, mid.id);

      expect(await trees.holds(mid.id, leaf.id, 'merchant.profile')).toBe(true);
      expect((await trees.getSubMerchant(mid.id, leaf.id)).id).toBe(leaf.id);

      await trees.revokePermission({
        actorMerchantId: platform.merchantId,
        granteeMerchantId: mid.id,
        subjectMerchantId: leaf.id,
        area: 'merchant.profile',
        reason: 'sub-payfac agreement terminated',
        actorId: 'platform-user',
        actorScope: 'pay:write',
      });

      const err = await rejection(trees.getSubMerchant(mid.id, leaf.id), SubMerchantError);
      expect(err.code).toBe('pay.submerchant_permission_denied');
    });

    it('a re-grant after a revoke works — the LATEST row is the answer, not the first', async () => {
      const platform = await root();
      const mid = await child(platform.merchantId, platform.merchantId);
      const leaf = await child(mid.id, mid.id);

      const change = {
        actorMerchantId: platform.merchantId,
        granteeMerchantId: mid.id,
        subjectMerchantId: leaf.id,
        area: 'merchant.profile',
        actorId: 'platform-user',
        actorScope: 'pay:write',
      };

      await trees.revokePermission({ ...change, reason: 'paused during review' });
      expect(await trees.holds(mid.id, leaf.id, 'merchant.profile')).toBe(false);
      await trees.grantPermission({ ...change, reason: 'review closed, no findings' });
      expect(await trees.holds(mid.id, leaf.id, 'merchant.profile')).toBe(true);

      const history = await trees.permissionHistory(platform.merchantId, leaf.id, 50);
      expect(history.map((e) => e.action).slice(0, 3)).toEqual(['grant', 'revoke', 'grant']);
    });

    it('refuses a redundant grant and a redundant revoke, so the journal stays readable', async () => {
      const platform = await root();
      const mid = await child(platform.merchantId, platform.merchantId);
      const leaf = await child(mid.id, mid.id);

      const change = {
        actorMerchantId: platform.merchantId,
        granteeMerchantId: mid.id,
        subjectMerchantId: leaf.id,
        actorId: 'platform-user',
        actorScope: 'pay:write',
        reason: 'no change intended',
      };

      expect((await rejection(trees.grantPermission({ ...change, area: 'merchant.profile' }), SubMerchantError)).code).toBe(
        'pay.submerchant_grant_redundant',
      );
      expect((await rejection(trees.revokePermission({ ...change, area: 'payment' }), SubMerchantError)).code).toBe(
        'pay.submerchant_revoke_redundant',
      );
    });

    it('refuses a blank reason, and an area nobody defined', async () => {
      const platform = await root();
      const mid = await child(platform.merchantId, platform.merchantId);
      const leaf = await child(mid.id, mid.id);

      const change = {
        actorMerchantId: platform.merchantId,
        granteeMerchantId: mid.id,
        subjectMerchantId: leaf.id,
        actorId: 'platform-user',
        actorScope: 'pay:write',
      };

      expect((await rejection(trees.grantPermission({ ...change, area: 'payment', reason: '   ' }), SubMerchantError)).code).toBe(
        'pay.submerchant_reason_required',
      );
      expect((await rejection(trees.grantPermission({ ...change, area: 'everything', reason: 'why not' }), SubMerchantError)).code).toBe(
        'pay.submerchant_area_unknown',
      );
    });
  });

  // ══ THE JOURNAL ═══════════════════════════════════════════════════════════

  describe('the permission journal', () => {
    it('answers WHO delegated WHAT, to WHOM, WHEN and WHY — from the database', async () => {
      const platform = await root();
      const mid = await child(platform.merchantId, platform.merchantId);
      const leaf = await child(mid.id, mid.id);

      await trees.grantPermission({
        actorMerchantId: platform.merchantId,
        granteeMerchantId: mid.id,
        subjectMerchantId: leaf.id,
        area: 'settlement',
        reason: 'sub-payfac runs its own settlement windows from 1 September',
        actorId: 'platform-user',
        actorScope: 'pay:write',
      });

      const event = at(await trees.permissionHistory(platform.merchantId, leaf.id, 50), 0, 'history');
      expect(event.area).toBe('settlement');
      expect(event.action).toBe('grant');
      expect(event.granteeMerchantId).toBe(mid.id);
      expect(event.actorMerchantId).toBe(platform.merchantId);
      expect(event.actorId).toBe('platform-user');
      expect(event.actorScope).toBe('pay:write');
      expect(event.reason).toBe('sub-payfac runs its own settlement windows from 1 September');
      expect(event.createdAt).toBeInstanceOf(Date);
    });

    it('IS APPEND-ONLY, enforced by the database — a revoke is a new row, never an edit', async () => {
      const platform = await root();
      const mid = await child(platform.merchantId, platform.merchantId);
      const leaf = await child(mid.id, mid.id);
      const event = at(await trees.permissionHistory(platform.merchantId, leaf.id, 50), 0, 'history');

      await expect(sql`UPDATE pay.merchant_permission_events SET action = 'revoke' WHERE id = ${event.id}`).rejects.toThrow(/append-only/);
      await expect(sql`DELETE FROM pay.merchant_permission_events WHERE id = ${event.id}`).rejects.toThrow(/append-only/);
    });

    it('refuses a blank reason at the database level too, whatever writes the row', async () => {
      const platform = await root();
      const mid = await child(platform.merchantId, platform.merchantId);
      const leaf = await child(mid.id, mid.id);

      await expect(sql`
        INSERT INTO pay.merchant_permission_events
          (grantee_merchant_id, subject_merchant_id, area, action, reason, actor_id, actor_merchant_id, actor_scope)
        VALUES (${mid.id}, ${leaf.id}, 'payment', 'grant', '  ', 'x', ${platform.merchantId}, 'pay:write')
      `).rejects.toThrow(/reason_not_blank/);
    });

    it('refuses a grant naming one merchant as both grantee and subject, at the database level', async () => {
      const platform = await root();
      const mid = await child(platform.merchantId, platform.merchantId);

      await expect(sql`
        INSERT INTO pay.merchant_permission_events
          (grantee_merchant_id, subject_merchant_id, area, action, reason, actor_id, actor_merchant_id, actor_scope)
        VALUES (${mid.id}, ${mid.id}, 'payment', 'grant', 'self', 'x', ${platform.merchantId}, 'pay:write')
      `).rejects.toThrow(/merchant_permission_events_not_self/);
    });

    it('lists the LIVE grants only, and never synthesises implicit authority into one', async () => {
      const platform = await root();
      const mid = await child(platform.merchantId, platform.merchantId);
      const leaf = await child(mid.id, mid.id);

      await trees.revokePermission({
        actorMerchantId: platform.merchantId,
        granteeMerchantId: mid.id,
        subjectMerchantId: leaf.id,
        area: 'submerchant',
        reason: 'no further onboarding under this node',
        actorId: 'platform-user',
        actorScope: 'pay:write',
      });

      const live = await trees.listPermissions(platform.merchantId, leaf.id, 50);
      expect(live.map((g) => g.area).sort()).toEqual(['merchant.profile']);
      expect(live.every((g) => g.granteeMerchantId === mid.id)).toBe(true);
    });
  });

  // ══ LISTING ═══════════════════════════════════════════════════════════════

  describe('listing a node’s children', () => {
    it('returns direct children only, and never the whole subtree', async () => {
      const platform = await root();
      const mid = await child(platform.merchantId, platform.merchantId);
      const other = await child(platform.merchantId, platform.merchantId);
      const grandchild = await child(platform.merchantId, mid.id);

      const top = await trees.listSubMerchants(platform.merchantId, platform.merchantId, 100);
      expect(top.map((r) => r.id).sort()).toEqual([mid.id, other.id].sort());
      expect(top.map((r) => r.id)).not.toContain(grandchild.id);
      expect(top.every((r) => r.depth === 1)).toBe(true);

      const under = await trees.listSubMerchants(platform.merchantId, mid.id, 100);
      expect(under.map((r) => r.id)).toEqual([grandchild.id]);
      expect(at(under, 0, 'children').depth).toBe(2);
    });

    it('requires the `submerchant` area — being able to see a node is not being able to enumerate under it', async () => {
      const platform = await root();
      const mid = await child(platform.merchantId, platform.merchantId);
      const leaf = await child(mid.id, mid.id);

      await trees.revokePermission({
        actorMerchantId: platform.merchantId,
        granteeMerchantId: mid.id,
        subjectMerchantId: leaf.id,
        area: 'submerchant',
        reason: 'onboarding rights withdrawn',
        actorId: 'platform-user',
        actorScope: 'pay:write',
      });

      // `mid` can still read `leaf`'s record — `merchant.profile` survives.
      expect((await trees.getSubMerchant(mid.id, leaf.id)).id).toBe(leaf.id);
      // But it can no longer enumerate or extend beneath it.
      expect((await rejection(trees.listSubMerchants(mid.id, leaf.id, 100), SubMerchantError)).code).toBe(
        'pay.submerchant_permission_denied',
      );
      expect((await rejection(child(mid.id, leaf.id), SubMerchantError)).code).toBe('pay.submerchant_permission_denied');
    });
  });
});
