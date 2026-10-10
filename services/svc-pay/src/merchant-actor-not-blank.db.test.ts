import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * merchant_kyb_events and merchant_pricing_events store actor_id and
 * actor_scope as text NOT NULL. 0013 already refuses a blank reason on both
 * tables. NOT NULL still admits '' and a string of spaces on the actor
 * columns. A KYB transition or a fee-bps change can be appended with an empty
 * actor, and the append-only triggers then forbid correcting that row in
 * place. 0035 adds CHECK (length(btrim(column)) > 0) on each actor column.
 *
 * A stored blank fails ADD CONSTRAINT and stays. This file clears a fixture
 * with TRUNCATE, which the migration does not do. The migration does not
 * UPDATE stored rows, does not invent an actor, a KYB vendor, or a fee, and
 * does not change the fee range, the reason checks, or the append-only
 * triggers. The down file drops only the four new constraints.
 *
 * Prior forward files are applied first, including 0013. Pay SQL is
 * schema-qualified and rewritten onto a schema in the database
 * TEST_DATABASE_URL names. This file does not start Postgres and does not
 * create a database.
 *
 * actor_id 'op-1' and actor_scope 'pay.psp' are fixtures in this test only.
 * from_fee_bps 0 and to_fee_bps 0 are already inside the existing range.
 * kyb_status values are read from the type. kyb_ref stays null.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const CLOSING = '0035_pay_merchant_kyb_pricing_actor_not_blank.sql';
const CLOSING_DOWN = '0035_pay_merchant_kyb_pricing_actor_not_blank.down.sql';

const KYB_ACTOR_ID_CK = 'merchant_kyb_events_actor_id_not_blank';
const KYB_ACTOR_SCOPE_CK = 'merchant_kyb_events_actor_scope_not_blank';
const PRICING_ACTOR_ID_CK = 'merchant_pricing_events_actor_id_not_blank';
const PRICING_ACTOR_SCOPE_CK = 'merchant_pricing_events_actor_scope_not_blank';
const KYB_REASON_CK = 'merchant_kyb_events_reason_not_blank';
const PRICING_REASON_CK = 'merchant_pricing_events_reason_not_blank';
const FEE_RANGE_CK = 'merchant_pricing_events_fee_bps_range';
const KYB_TRIGGER = 'merchant_kyb_events_append_only_trg';
const PRICING_TRIGGER = 'merchant_pricing_events_append_only_trg';
const KYB_FUNCTION = 'merchant_kyb_events_append_only';
const PRICING_FUNCTION = 'merchant_pricing_events_append_only';

/** Space-only. btrim removes spaces, so this is blank for the check. */
const SPACES = '   ';

/** Fixtures. The migration does not invent an actor. */
const FIXTURE_ACTOR_ID = 'op-1';
const FIXTURE_ACTOR_SCOPE = 'pay.psp';
const FIXTURE_REASON = 'l880 fixture reason';

const NEW_CHECKS = [KYB_ACTOR_ID_CK, KYB_ACTOR_SCOPE_CK, PRICING_ACTOR_ID_CK, PRICING_ACTOR_SCOPE_CK];

const priorMigrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql') && f !== CLOSING)
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is unset; refusing to guess a database for a KYB or pricing actor');
  }
  return url;
}

function rewritePaySchema(sql: string, schema: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(schema)) {
    throw new Error(`refusing to rewrite pay SQL onto ${schema}`);
  }
  return sql.replaceAll('"pay"', `"${schema}"`).replace(/\bpay\./g, `${schema}.`);
}

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function one<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected ${what}`);
  return row;
}

interface StoredKyb {
  id: string;
  from_status: string;
  to_status: string;
  kyb_ref: string | null;
  reason: string;
  actor_id: string;
  actor_scope: string;
}

interface StoredPricing {
  id: string;
  from_fee_bps: string;
  to_fee_bps: string;
  reason: string;
  actor_id: string;
  actor_scope: string;
}

interface ConstraintFact {
  conname: string;
  def: string;
}

interface TriggerFact {
  oid: string;
  tgname: string;
  def: string;
}

interface FunctionFact {
  oid: string;
  def: string;
}

interface Refused {
  code?: string;
  message?: string;
  constraint_name?: string;
}

describe('a KYB or pricing actor cannot be blank', () => {
  let sql: postgres.Sql | undefined;
  let admin: postgres.Sql | undefined;
  let schema = '';

  beforeAll(async () => {
    const url = testDatabaseUrl();
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    const current = one(await admin<Array<{ db: string }>>`SELECT current_database() AS db`, 'current database');
    if (current.db === 'postgres') {
      throw new Error('refusing to migrate a KYB or pricing actor on database postgres');
    }
    if (!current.db.endsWith('_test')) {
      throw new Error(`refusing to migrate a KYB or pricing actor on database ${current.db}`);
    }

    schema = `test_pay_l880_${process.pid}`;
    if (schema === 'pay') {
      throw new Error('refusing to write the pay schema');
    }
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);

    sql = postgres(url, {
      max: 1,
      connection: { search_path: `${schema},public` },
      onnotice: () => undefined,
    });
    for (const migration of priorMigrations) {
      await sql.unsafe(rewritePaySchema(migration, schema));
    }
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 }).catch(() => undefined);
    if (admin && schema) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    }
    await admin?.end({ timeout: 5 }).catch(() => undefined);
  }, 30_000);

  it('refuses a blank or space-only actor on either table, stores a non-blank actor, and leaves an already-blank row when the check cannot be added', async () => {
    const db = sql;
    if (!db || !schema) throw new Error('test database was not opened');
    expect(schema).toMatch(/^test_pay_l880_\d+$/);
    expect(schema).not.toBe('pay');

    const raw = readFileSync(join(drizzleDir, CLOSING), 'utf8');
    const rawDown = readFileSync(join(drizzleDir, CLOSING_DOWN), 'utf8');
    const closing = rewritePaySchema(raw, schema);
    const closingDown = rewritePaySchema(rawDown, schema);
    const statements = stripSqlComments(raw);
    const downStatements = stripSqlComments(rawDown);

    const kybIdAt = statements.indexOf(`"${KYB_ACTOR_ID_CK}"`);
    const kybScopeAt = statements.indexOf(`"${KYB_ACTOR_SCOPE_CK}"`);
    const pricingIdAt = statements.indexOf(`"${PRICING_ACTOR_ID_CK}"`);
    const pricingScopeAt = statements.indexOf(`"${PRICING_ACTOR_SCOPE_CK}"`);
    expect(kybIdAt).toBeGreaterThanOrEqual(0);
    expect(kybScopeAt).toBeGreaterThan(kybIdAt);
    expect(pricingIdAt).toBeGreaterThan(kybScopeAt);
    expect(pricingScopeAt).toBeGreaterThan(pricingIdAt);
    expect(statements).toMatch(
      new RegExp(`ADD CONSTRAINT "${KYB_ACTOR_ID_CK}"\\s+CHECK \\(length\\(btrim\\("actor_id"\\)\\) > 0\\)`),
    );
    expect(statements).toMatch(
      new RegExp(`ADD CONSTRAINT "${KYB_ACTOR_SCOPE_CK}"\\s+CHECK \\(length\\(btrim\\("actor_scope"\\)\\) > 0\\)`),
    );
    expect(statements).toMatch(
      new RegExp(`ADD CONSTRAINT "${PRICING_ACTOR_ID_CK}"\\s+CHECK \\(length\\(btrim\\("actor_id"\\)\\) > 0\\)`),
    );
    expect(statements).toMatch(
      new RegExp(
        `ADD CONSTRAINT "${PRICING_ACTOR_SCOPE_CK}"\\s+CHECK \\(length\\(btrim\\("actor_scope"\\)\\) > 0\\)`,
      ),
    );
    expect(statements.match(/ALTER TABLE/g)).toHaveLength(4);
    expect(statements.match(/ADD CONSTRAINT/g)).toHaveLength(4);
    expect(statements).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b|\bDROP\b|\bCREATE\b/i);
    expect(statements).not.toMatch(/\bfee_bps\b|\breason_not_blank\b|\bTRIGGER\b|\bFUNCTION\b/i);
    expect(statements).not.toContain(FIXTURE_ACTOR_ID);
    expect(statements).not.toContain(FIXTURE_ACTOR_SCOPE);
    expect(statements).toContain('"pay"."merchant_kyb_events"');
    expect(statements).toContain('"pay"."merchant_pricing_events"');
    expect(closing).not.toContain('"pay"');
    expect(closing).toContain(`"${schema}"`);
    expect(closingDown).not.toContain('"pay"');
    expect(closingDown).toContain(`"${schema}"`);

    expect(rawDown).toMatch(/intafaced:destructive/);
    const dropKybId = downStatements.indexOf(`DROP CONSTRAINT IF EXISTS "${KYB_ACTOR_ID_CK}"`);
    const dropKybScope = downStatements.indexOf(`DROP CONSTRAINT IF EXISTS "${KYB_ACTOR_SCOPE_CK}"`);
    const dropPricingId = downStatements.indexOf(`DROP CONSTRAINT IF EXISTS "${PRICING_ACTOR_ID_CK}"`);
    const dropPricingScope = downStatements.indexOf(`DROP CONSTRAINT IF EXISTS "${PRICING_ACTOR_SCOPE_CK}"`);
    expect(dropKybId).toBeGreaterThanOrEqual(0);
    expect(dropKybScope).toBeGreaterThan(dropKybId);
    expect(dropPricingId).toBeGreaterThan(dropKybScope);
    expect(dropPricingScope).toBeGreaterThan(dropPricingId);
    expect(downStatements.match(/ALTER TABLE/g)).toHaveLength(4);
    expect(downStatements.match(/DROP CONSTRAINT IF EXISTS/g)).toHaveLength(4);
    expect(downStatements).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b|\bDROP\s+COLUMN\b|\bDROP\s+TRIGGER\b|\bDROP\s+TABLE\b|\bDROP\s+FUNCTION\b/i);
    expect(downStatements).not.toContain(KYB_REASON_CK);
    expect(downStatements).not.toContain(PRICING_REASON_CK);
    expect(downStatements).not.toContain(FEE_RANGE_CK);
    expect(downStatements).not.toContain(KYB_TRIGGER);
    expect(downStatements).not.toContain(PRICING_TRIGGER);
    expect(downStatements).not.toContain(KYB_FUNCTION);
    expect(downStatements).not.toContain(PRICING_FUNCTION);
    expect(downStatements).not.toContain(FIXTURE_ACTOR_ID);
    expect(downStatements).not.toContain(FIXTURE_ACTOR_SCOPE);

    async function checks(table: string): Promise<ConstraintFact[]> {
      return db<ConstraintFact[]>`
        SELECT con.conname, pg_get_constraintdef(con.oid) AS def
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ${schema}
           AND c.relname = ${table}
           AND con.contype = 'c'
         ORDER BY con.conname
      `;
    }

    async function triggerFact(table: string, name: string): Promise<TriggerFact> {
      return one(
        await db<TriggerFact[]>`
          SELECT t.oid::text AS oid, t.tgname, pg_get_triggerdef(t.oid) AS def
            FROM pg_trigger t
            JOIN pg_class c ON c.oid = t.tgrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = ${schema}
             AND c.relname = ${table}
             AND t.tgname = ${name}
             AND NOT t.tgisinternal
        `,
        `${table}.${name}`,
      );
    }

    async function functionFact(name: string): Promise<FunctionFact> {
      return one(
        await db<FunctionFact[]>`
          SELECT p.oid::text AS oid, pg_get_functiondef(p.oid) AS def
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = ${schema}
             AND p.proname = ${name}
        `,
        name,
      );
    }

    async function kybLabels(): Promise<string[]> {
      const rows = await db<Array<{ label: string }>>`
        SELECT e.enumlabel AS label
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = ${schema}
           AND t.typname = 'kyb_status'
         ORDER BY e.enumsortorder
      `;
      return rows.map((row) => row.label);
    }

    async function refused(run: () => Promise<unknown>): Promise<Refused> {
      const error = await run().then(
        () => null,
        (err: unknown) => err,
      );
      return (error ?? {}) as Refused;
    }

    async function countText(table: string): Promise<string> {
      const rows = await db.unsafe<{ n: string }[]>(
        `SELECT count(*)::text AS n FROM "${schema}"."${table}"`,
      );
      return one(rows, `${table} count`).n;
    }

    const labels = await kybLabels();
    const fromStatus = labels[0];
    const toStatus = labels[1] ?? labels[0];
    if (!fromStatus || !toStatus) throw new Error('kyb_status has no labels');
    expect(labels).toContain(fromStatus);
    expect(labels).toContain(toStatus);

    const merchant = one(
      await db<Array<{ id: string }>>`
        INSERT INTO merchants (user_id)
        VALUES ('l880-merchant')
        RETURNING id
      `,
      'merchant',
    );

    async function insertKyb(actorId: string, actorScope: string, reason = FIXTURE_REASON): Promise<StoredKyb> {
      return one(
        await db<StoredKyb[]>`
          INSERT INTO merchant_kyb_events (
            merchant_id, from_status, to_status, reason, actor_id, actor_scope
          ) VALUES (
            ${merchant.id},
            ${fromStatus}::kyb_status,
            ${toStatus}::kyb_status,
            ${reason},
            ${actorId},
            ${actorScope}
          )
          RETURNING
            id,
            from_status::text AS from_status,
            to_status::text AS to_status,
            kyb_ref,
            reason,
            actor_id,
            actor_scope
        `,
        'kyb event',
      );
    }

    async function insertPricing(actorId: string, actorScope: string, reason = FIXTURE_REASON): Promise<StoredPricing> {
      return one(
        await db<StoredPricing[]>`
          INSERT INTO merchant_pricing_events (
            merchant_id, from_fee_bps, to_fee_bps, reason, actor_id, actor_scope
          ) VALUES (
            ${merchant.id},
            0,
            0,
            ${reason},
            ${actorId},
            ${actorScope}
          )
          RETURNING
            id,
            from_fee_bps::text AS from_fee_bps,
            to_fee_bps::text AS to_fee_bps,
            reason,
            actor_id,
            actor_scope
        `,
        'pricing event',
      );
    }

    async function storedKyb(id: string): Promise<StoredKyb> {
      return one(
        await db<StoredKyb[]>`
          SELECT
            id,
            from_status::text AS from_status,
            to_status::text AS to_status,
            kyb_ref,
            reason,
            actor_id,
            actor_scope
            FROM merchant_kyb_events
           WHERE id = ${id}
        `,
        'stored kyb event',
      );
    }

    async function storedPricing(id: string): Promise<StoredPricing> {
      return one(
        await db<StoredPricing[]>`
          SELECT
            id,
            from_fee_bps::text AS from_fee_bps,
            to_fee_bps::text AS to_fee_bps,
            reason,
            actor_id,
            actor_scope
            FROM merchant_pricing_events
           WHERE id = ${id}
        `,
        'stored pricing event',
      );
    }

    const kybChecksBefore = await checks('merchant_kyb_events');
    const pricingChecksBefore = await checks('merchant_pricing_events');
    const kybTriggerBefore = await triggerFact('merchant_kyb_events', KYB_TRIGGER);
    const pricingTriggerBefore = await triggerFact('merchant_pricing_events', PRICING_TRIGGER);
    const kybFunctionBefore = await functionFact(KYB_FUNCTION);
    const pricingFunctionBefore = await functionFact(PRICING_FUNCTION);
    expect(kybChecksBefore.map((row) => row.conname)).toEqual([KYB_REASON_CK]);
    expect(pricingChecksBefore.map((row) => row.conname)).toEqual([FEE_RANGE_CK, PRICING_REASON_CK]);
    expect(kybTriggerBefore.def).toMatch(/BEFORE DELETE OR UPDATE/);
    expect(pricingTriggerBefore.def).toMatch(/BEFORE DELETE OR UPDATE/);
    expect(kybTriggerBefore.def).toContain(KYB_FUNCTION);
    expect(pricingTriggerBefore.def).toContain(PRICING_FUNCTION);
    expect(kybFunctionBefore.def).toMatch(/append-only/);
    expect(pricingFunctionBefore.def).toMatch(/append-only/);

    async function expectAddRefused(constraint: string): Promise<void> {
      const attempt = await refused(() => db.unsafe(closing));
      expect(attempt.code).toBe('23514');
      expect(attempt.message ?? '').toContain(constraint);
      expect(await checks('merchant_kyb_events')).toEqual(kybChecksBefore);
      expect(await checks('merchant_pricing_events')).toEqual(pricingChecksBefore);
      expect(await triggerFact('merchant_kyb_events', KYB_TRIGGER)).toEqual(kybTriggerBefore);
      expect(await triggerFact('merchant_pricing_events', PRICING_TRIGGER)).toEqual(pricingTriggerBefore);
      expect(await functionFact(KYB_FUNCTION)).toEqual(kybFunctionBefore);
      expect(await functionFact(PRICING_FUNCTION)).toEqual(pricingFunctionBefore);
    }

    const blankKybActor = await insertKyb('', FIXTURE_ACTOR_SCOPE);
    expect(blankKybActor.actor_id).toBe('');
    expect(blankKybActor.kyb_ref).toBeNull();
    await expectAddRefused(KYB_ACTOR_ID_CK);
    expect(await storedKyb(blankKybActor.id)).toEqual(blankKybActor);
    await db`TRUNCATE merchant_kyb_events`;

    const spaceKybScope = await insertKyb(FIXTURE_ACTOR_ID, SPACES);
    expect(spaceKybScope.actor_scope).toBe(SPACES);
    await expectAddRefused(KYB_ACTOR_SCOPE_CK);
    expect(await storedKyb(spaceKybScope.id)).toEqual(spaceKybScope);
    await db`TRUNCATE merchant_kyb_events`;

    const blankPricingActor = await insertPricing('', FIXTURE_ACTOR_SCOPE);
    expect(blankPricingActor.actor_id).toBe('');
    expect(blankPricingActor.from_fee_bps).toBe('0');
    expect(blankPricingActor.to_fee_bps).toBe('0');
    await expectAddRefused(PRICING_ACTOR_ID_CK);
    expect(await storedPricing(blankPricingActor.id)).toEqual(blankPricingActor);
    await db`TRUNCATE merchant_pricing_events`;

    const spacePricingScope = await insertPricing(FIXTURE_ACTOR_ID, SPACES);
    expect(spacePricingScope.actor_scope).toBe(SPACES);
    await expectAddRefused(PRICING_ACTOR_SCOPE_CK);
    expect(await storedPricing(spacePricingScope.id)).toEqual(spacePricingScope);
    await db`TRUNCATE merchant_pricing_events`;

    expect(await countText('merchant_kyb_events')).toBe('0');
    expect(await countText('merchant_pricing_events')).toBe('0');

    const keptKyb = await insertKyb(FIXTURE_ACTOR_ID, FIXTURE_ACTOR_SCOPE);
    const keptPricing = await insertPricing(FIXTURE_ACTOR_ID, FIXTURE_ACTOR_SCOPE);
    expect(keptKyb).toMatchObject({
      from_status: fromStatus,
      to_status: toStatus,
      kyb_ref: null,
      reason: FIXTURE_REASON,
      actor_id: FIXTURE_ACTOR_ID,
      actor_scope: FIXTURE_ACTOR_SCOPE,
    });
    expect(keptPricing).toMatchObject({
      from_fee_bps: '0',
      to_fee_bps: '0',
      reason: FIXTURE_REASON,
      actor_id: FIXTURE_ACTOR_ID,
      actor_scope: FIXTURE_ACTOR_SCOPE,
    });

    await db.unsafe(closing);

    expect(await storedKyb(keptKyb.id)).toEqual(keptKyb);
    expect(await storedPricing(keptPricing.id)).toEqual(keptPricing);
    expect(await triggerFact('merchant_kyb_events', KYB_TRIGGER)).toEqual(kybTriggerBefore);
    expect(await triggerFact('merchant_pricing_events', PRICING_TRIGGER)).toEqual(pricingTriggerBefore);
    expect(await functionFact(KYB_FUNCTION)).toEqual(kybFunctionBefore);
    expect(await functionFact(PRICING_FUNCTION)).toEqual(pricingFunctionBefore);

    const kybChecks = await checks('merchant_kyb_events');
    const pricingChecks = await checks('merchant_pricing_events');
    expect(kybChecks.map((row) => row.conname)).toEqual([KYB_ACTOR_ID_CK, KYB_ACTOR_SCOPE_CK, KYB_REASON_CK]);
    expect(pricingChecks.map((row) => row.conname)).toEqual([
      PRICING_ACTOR_ID_CK,
      PRICING_ACTOR_SCOPE_CK,
      FEE_RANGE_CK,
      PRICING_REASON_CK,
    ]);
    expect(kybChecks.filter((row) => !NEW_CHECKS.includes(row.conname))).toEqual(kybChecksBefore);
    expect(pricingChecks.filter((row) => !NEW_CHECKS.includes(row.conname))).toEqual(pricingChecksBefore);
    expect(kybChecks.find((row) => row.conname === KYB_ACTOR_ID_CK)?.def).toBe('CHECK ((length(btrim(actor_id)) > 0))');
    expect(kybChecks.find((row) => row.conname === KYB_ACTOR_SCOPE_CK)?.def).toBe(
      'CHECK ((length(btrim(actor_scope)) > 0))',
    );
    expect(pricingChecks.find((row) => row.conname === PRICING_ACTOR_ID_CK)?.def).toBe(
      'CHECK ((length(btrim(actor_id)) > 0))',
    );
    expect(pricingChecks.find((row) => row.conname === PRICING_ACTOR_SCOPE_CK)?.def).toBe(
      'CHECK ((length(btrim(actor_scope)) > 0))',
    );

    async function expectActorRefused(
      table: 'kyb' | 'pricing',
      actorId: string,
      actorScope: string,
      constraint: string,
    ): Promise<void> {
      const error = await refused(() => (table === 'kyb' ? insertKyb(actorId, actorScope) : insertPricing(actorId, actorScope)));
      expect(error).toMatchObject({ code: '23514', constraint_name: constraint });
    }

    await expectActorRefused('kyb', '', FIXTURE_ACTOR_SCOPE, KYB_ACTOR_ID_CK);
    await expectActorRefused('kyb', SPACES, FIXTURE_ACTOR_SCOPE, KYB_ACTOR_ID_CK);
    await expectActorRefused('kyb', FIXTURE_ACTOR_ID, '', KYB_ACTOR_SCOPE_CK);
    await expectActorRefused('kyb', FIXTURE_ACTOR_ID, SPACES, KYB_ACTOR_SCOPE_CK);
    await expectActorRefused('pricing', '', FIXTURE_ACTOR_SCOPE, PRICING_ACTOR_ID_CK);
    await expectActorRefused('pricing', SPACES, FIXTURE_ACTOR_SCOPE, PRICING_ACTOR_ID_CK);
    await expectActorRefused('pricing', FIXTURE_ACTOR_ID, '', PRICING_ACTOR_SCOPE_CK);
    await expectActorRefused('pricing', FIXTURE_ACTOR_ID, SPACES, PRICING_ACTOR_SCOPE_CK);

    const blankKybReason = await refused(() => insertKyb(FIXTURE_ACTOR_ID, FIXTURE_ACTOR_SCOPE, '   '));
    expect(blankKybReason).toMatchObject({ code: '23514', constraint_name: KYB_REASON_CK });
    const blankPricingReason = await refused(() => insertPricing(FIXTURE_ACTOR_ID, FIXTURE_ACTOR_SCOPE, ''));
    expect(blankPricingReason).toMatchObject({ code: '23514', constraint_name: PRICING_REASON_CK });

    const insertedKyb = await insertKyb(FIXTURE_ACTOR_ID, FIXTURE_ACTOR_SCOPE);
    const insertedPricing = await insertPricing(FIXTURE_ACTOR_ID, FIXTURE_ACTOR_SCOPE);
    expect(insertedKyb.id).not.toBe(keptKyb.id);
    expect(insertedPricing.id).not.toBe(keptPricing.id);
    expect(insertedKyb.actor_id).toBe(FIXTURE_ACTOR_ID);
    expect(insertedKyb.actor_scope).toBe(FIXTURE_ACTOR_SCOPE);
    expect(insertedKyb.kyb_ref).toBeNull();
    expect(insertedPricing.actor_id).toBe(FIXTURE_ACTOR_ID);
    expect(insertedPricing.actor_scope).toBe(FIXTURE_ACTOR_SCOPE);
    expect(insertedPricing.from_fee_bps).toBe('0');
    expect(insertedPricing.to_fee_bps).toBe('0');

    const rewriteKyb = await refused(() => db`
      UPDATE merchant_kyb_events
         SET reason = 'rewritten'
       WHERE id = ${keptKyb.id}
    `);
    expect(rewriteKyb.code).toBe('23001');
    expect(rewriteKyb.message ?? '').toMatch(/append-only/);
    expect(await storedKyb(keptKyb.id)).toEqual(keptKyb);

    const rewritePricing = await refused(() => db`
      UPDATE merchant_pricing_events
         SET reason = 'rewritten'
       WHERE id = ${keptPricing.id}
    `);
    expect(rewritePricing.code).toBe('23001');
    expect(rewritePricing.message ?? '').toMatch(/append-only/);
    expect(await storedPricing(keptPricing.id)).toEqual(keptPricing);

    await db.unsafe(closingDown);

    expect(await storedKyb(keptKyb.id)).toEqual(keptKyb);
    expect(await storedPricing(keptPricing.id)).toEqual(keptPricing);
    expect(await storedKyb(insertedKyb.id)).toEqual(insertedKyb);
    expect(await storedPricing(insertedPricing.id)).toEqual(insertedPricing);
    expect(await checks('merchant_kyb_events')).toEqual(kybChecksBefore);
    expect(await checks('merchant_pricing_events')).toEqual(pricingChecksBefore);
    expect(await triggerFact('merchant_kyb_events', KYB_TRIGGER)).toEqual(kybTriggerBefore);
    expect(await triggerFact('merchant_pricing_events', PRICING_TRIGGER)).toEqual(pricingTriggerBefore);
    expect(await functionFact(KYB_FUNCTION)).toEqual(kybFunctionBefore);
    expect(await functionFact(PRICING_FUNCTION)).toEqual(pricingFunctionBefore);

    const rewriteAfterDown = await refused(() => db`
      UPDATE merchant_kyb_events
         SET actor_id = 'rewritten'
       WHERE id = ${keptKyb.id}
    `);
    expect(rewriteAfterDown.code).toBe('23001');
    expect(rewriteAfterDown.message ?? '').toMatch(/append-only/);
    expect(await storedKyb(keptKyb.id)).toEqual(keptKyb);

    const blankAfterDown = await insertKyb('', FIXTURE_ACTOR_SCOPE);
    const spaceAfterDown = await insertPricing(FIXTURE_ACTOR_ID, SPACES);
    expect(blankAfterDown.actor_id).toBe('');
    expect(blankAfterDown.actor_scope).toBe(FIXTURE_ACTOR_SCOPE);
    expect(spaceAfterDown.actor_id).toBe(FIXTURE_ACTOR_ID);
    expect(spaceAfterDown.actor_scope).toBe(SPACES);
    expect(spaceAfterDown.from_fee_bps).toBe('0');
    expect(spaceAfterDown.to_fee_bps).toBe('0');
  });
});
