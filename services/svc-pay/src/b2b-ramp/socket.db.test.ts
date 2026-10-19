import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFounderAuthority } from '../founder-authority.js';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { BankStatementReconciliation, type BankStatementLine } from './socket.js';
import { createB2bRampRouter } from './router.js';
import { B2bRampError } from './errors.js';

/**
 * Real Postgres. The admin URL is TEST_DATABASE_URL, not TEST_DATABASE_URL_PAY:
 * creating a database needs CREATEDB, which the per-service role lacks. The pay
 * URL is used when the admin URL is unset, so either variable being set skips
 * the throwaway server. With neither set, a Homebrew postgresql@16 listens on
 * the assigned port. The client's claim never becomes a credit; a bank line
 * does, and only once, and never as a ledger post.
 */

const PORT = 54951;
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzle, name), 'utf8'));

const onEnv = { PAY_B2B_RAMP: 'on', APP_ENV: 'test' };
const offEnv = { PAY_B2B_RAMP: 'off', APP_ENV: 'prod' };
const POSTED = '2026-10-15T12:00:00.000Z';

function pgBin(): string {
  for (const dir of ['/opt/homebrew/opt/postgresql@16/bin', '/usr/local/opt/postgresql@16/bin']) {
    if (existsSync(join(dir, 'initdb'))) return dir;
  }
  throw new Error('Homebrew postgresql@16 is not installed');
}

function startThrowawayPostgres(): { url: string; stop: () => void } {
  const bin = pgBin();
  const data = mkdtempSync(join(tmpdir(), 'pay-b2b-ramp-'));
  let started = false;
  const run = (cmd: string, args: string[]) => {
    const result = spawnSync(join(bin, cmd), args, { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${cmd} exited ${result.status}: ${result.stderr}\n${result.stdout}`);
  };
  try {
    run('initdb', ['-D', data, '--username=intafaced', '--auth=trust', '--no-instructions']);
    run('pg_ctl', [
      '-D',
      data,
      '-l',
      join(data, 'server.log'),
      '-w',
      'start',
      '-o',
      `-c unix_socket_directories='' -c listen_addresses=127.0.0.1 -p ${PORT}`,
    ]);
    started = true;
    run('createdb', ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'intafaced', 'intafaced_b2b_ramp_test']);
  } catch (error) {
    if (started) spawnSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
    rmSync(data, { recursive: true, force: true });
    throw error;
  }
  return {
    url: `postgres://intafaced@127.0.0.1:${PORT}/intafaced_b2b_ramp_test`,
    stop() {
      spawnSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { encoding: 'utf8' });
      rmSync(data, { recursive: true, force: true });
    },
  };
}

const principal = (user: string, scopes: string[] = ['pay:read', 'pay:write']): Principal => ({
  userId: user,
  sub: user,
  sid: randomUUID(),
  scopes,
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 60_000),
});

const ctxOf = (p: Principal): Context => ({ principal: p, service: null, region: 'DE', requestId: randomUUID() });

function postgresForTests(): { url: string; stop: () => void } {
  const envUrl = (process.env.TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL_PAY)?.trim();
  if (envUrl) return { url: envUrl, stop: () => undefined };
  return startThrowawayPostgres();
}

describe('W10 bank-statement reconciliation (Postgres)', () => {
  let db: TestDatabase;
  let stopPg: () => void = () => undefined;

  beforeAll(async () => {
    const started = postgresForTests();
    stopPg = started.stop;
    db = await createTestDatabase({ service: 'pay', url: started.url, migrations });
  }, 120_000);

  beforeEach(async () => {
    const tables = await db.sql<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = ${db.schema}
    `;
    if (tables.length === 0) return;
    const list = tables.map((t) => `"${db.schema}"."${t.tablename}"`).join(', ');
    await truncatePayForTest(db.sql, db.schema, `TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await db?.drop();
    stopPg();
  }, 30_000);

  const socket = () => new BankStatementReconciliation(db.sql, onEnv);
  const authority = createFounderAuthority({
    identityUrl: 'https://identity.invalid',
    serviceSecret: 's'.repeat(32),
    fetcher: async () => new Response('{}', { status: 403 }),
  });
  const routerFor = (env: Record<string, string>) => createB2bRampRouter({ founderAuthority: authority, sql: db.sql, env });

  async function merchant(user: string): Promise<string> {
    const rows = await db.sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${user}) RETURNING id`;
    return rows[0]!.id;
  }

  async function member(merchantId: string, user: string, role: 'admin' | 'finance' | 'developer' | 'viewer', invitedBy: string) {
    await db.sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES (${merchantId}, ${user}, ${role}, 'active', ${invitedBy}, now())
    `;
  }

  function line(merchantId: string, over: Partial<BankStatementLine> = {}): BankStatementLine {
    return {
      lineId: `line-${randomUUID()}`,
      merchantId,
      amount: '10.10',
      asset: 'USD',
      reference: 'stmt-100',
      postedAt: POSTED,
      source: 'bank_statement',
      ...over,
    };
  }

  async function creditCount(): Promise<number> {
    const rows = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pay.b2b_ramp_credits`;
    return rows[0]!.n;
  }

  it('credits only a matching bank line, once, and does not post the ledger', async () => {
    const owner = randomUUID();
    const merchantId = await merchant(owner);
    const statement = line(merchantId);
    await socket().recordBankLine(statement);

    const [first, second] = await Promise.all([
      socket().credit({ merchantId, bankLineId: statement.lineId, amount: '10.100', asset: 'USD' }),
      socket().credit({ merchantId, bankLineId: statement.lineId, amount: '10.10', asset: 'USD' }),
    ]);
    expect(first.ledgerPosted).toBe(false);
    expect(second.creditId).toBe(first.creditId);
    expect(parseAmount(first.amount)).toBe(parseAmount('10.10'));
    expect(await creditCount()).toBe(1);

    const again = await socket().credit({ merchantId, bankLineId: statement.lineId, amount: '10.1', asset: 'USD' });
    expect(again.creditId).toBe(first.creditId);
    expect(await creditCount()).toBe(1);
  });

  it('refuses a credit that has only the client claim, or an amount the bank line does not match', async () => {
    const owner = randomUUID();
    const merchantId = await merchant(owner);
    const statement = line(merchantId, { amount: '10.10' });
    await socket().recordBankLine(statement);

    await expect(
      socket().credit({ merchantId, bankLineId: `missing-${randomUUID()}`, amount: '10.10', asset: 'USD' }),
    ).rejects.toMatchObject({
      code: 'pay.b2b_ramp_unreconciled',
    });
    await expect(socket().credit({ merchantId, bankLineId: statement.lineId, amount: '999999.00', asset: 'USD' })).rejects.toMatchObject({
      code: 'pay.b2b_ramp_unreconciled',
    });
    await expect(socket().credit({ merchantId, bankLineId: statement.lineId, amount: '10.10', asset: 'USDT' })).rejects.toMatchObject({
      code: 'pay.b2b_ramp_unreconciled',
    });
    expect(await creditCount()).toBe(0);

    const caller = routerFor(onEnv).createCaller(ctxOf(principal(owner)));
    await expect(
      caller.b2bRamp.credit({
        merchantId,
        bankLineId: statement.lineId,
        amount: '999999.00',
        asset: 'USD',
        clientSettledAmount: '999999.00',
      }),
    ).rejects.toMatchObject({ message: 'pay.b2b_ramp_unreconciled' });
    const admitted = await caller.b2bRamp.credit({
      merchantId,
      bankLineId: statement.lineId,
      amount: '10.10',
      asset: 'USD',
      clientSettledAmount: '999999.00',
    });
    expect(parseAmount(admitted.amount)).toBe(parseAmount('10.10'));
    expect(admitted.ledgerPosted).toBe(false);
    expect(await creditCount()).toBe(1);
  });

  it('refuses credit while the flag is off, including a direct socket call, and leaves the line uncredited', async () => {
    const owner = randomUUID();
    const merchantId = await merchant(owner);
    const statement = line(merchantId);
    await socket().recordBankLine(statement);

    await expect(
      new BankStatementReconciliation(db.sql, offEnv).credit({ merchantId, bankLineId: statement.lineId, amount: '10.10', asset: 'USD' }),
    ).rejects.toBeInstanceOf(B2bRampError);
    const caller = routerFor(offEnv).createCaller(ctxOf(principal(owner)));
    await expect(
      caller.b2bRamp.credit({ merchantId, bankLineId: statement.lineId, amount: '10.10', asset: 'USD', clientSettledAmount: '10.10' }),
    ).rejects.toMatchObject({ message: 'pay.b2b_ramp_off' });
    await expect(caller.b2bRamp.status({ merchantId })).rejects.toMatchObject({ message: 'pay.b2b_ramp_off' });
    expect(await creditCount()).toBe(0);
  });

  it('scopes reads and credits to the owner and the team, and treats a stranger like a missing id', async () => {
    const owner = randomUUID();
    const finance = randomUUID();
    const viewer = randomUUID();
    const stranger = randomUUID();
    const otherOwner = randomUUID();
    const merchantId = await merchant(owner);
    const otherId = await merchant(otherOwner);
    await member(merchantId, finance, 'finance', owner);
    await member(merchantId, viewer, 'viewer', owner);
    const statement = line(merchantId);
    await socket().recordBankLine(statement);

    const as = (user: string) => routerFor(onEnv).createCaller(ctxOf(principal(user)));
    await expect(
      as(viewer).b2bRamp.credit({ merchantId, bankLineId: statement.lineId, amount: '10.10', asset: 'USD' }),
    ).rejects.toMatchObject({
      message: 'pay.team_role_forbidden',
    });
    expect(await creditCount()).toBe(0);

    const admitted = await as(finance).b2bRamp.credit({ merchantId, bankLineId: statement.lineId, amount: '10.10', asset: 'USD' });
    const seen = await as(viewer).b2bRamp.get({ creditId: admitted.creditId });
    expect(seen.creditId).toBe(admitted.creditId);
    const ownerStatus = await as(owner).b2bRamp.status({ merchantId });
    expect(ownerStatus.merchantId).toBe(merchantId);

    await expect(as(stranger).b2bRamp.status({ merchantId })).rejects.toMatchObject({ message: 'pay.merchant_not_found' });
    await expect(as(stranger).b2bRamp.status({ merchantId: randomUUID() })).rejects.toMatchObject({ message: 'pay.merchant_not_found' });

    await expect(as(stranger).b2bRamp.get({ creditId: admitted.creditId })).rejects.toMatchObject({ message: 'pay.b2b_ramp_not_found' });
    await expect(as(stranger).b2bRamp.get({ creditId: randomUUID() })).rejects.toMatchObject({ message: 'pay.b2b_ramp_not_found' });

    await expect(
      as(otherOwner).b2bRamp.credit({ merchantId: otherId, bankLineId: statement.lineId, amount: '10.10', asset: 'USD' }),
    ).rejects.toMatchObject({ message: 'pay.b2b_ramp_unreconciled' });
    expect(await creditCount()).toBe(1);
  });

  it('keeps the first bank line, rejects a client source, and refuses to rewrite or mark a ledger post', async () => {
    const owner = randomUUID();
    const merchantId = await merchant(owner);
    const statement = line(merchantId, { amount: '10.10' });
    await socket().recordBankLine(statement);
    await socket().recordBankLine(statement);
    await expect(socket().recordBankLine({ ...statement, amount: '1.00' })).rejects.toMatchObject({ code: 'pay.b2b_ramp_line_rejected' });
    await expect(socket().recordBankLine({ ...statement, source: 'client' as 'bank_statement' })).rejects.toMatchObject({
      code: 'pay.b2b_ramp_line_rejected',
    });
    await expect(socket().recordBankLine(line(randomUUID()))).rejects.toMatchObject({ code: 'pay.b2b_ramp_line_rejected' });

    const stored = await db.sql<Array<{ amount: string }>>`
      SELECT amount::text AS amount FROM pay.b2b_ramp_bank_lines WHERE line_id = ${statement.lineId}
    `;
    expect(parseAmount(stored[0]!.amount)).toBe(parseAmount('10.10'));
    expect(await creditCount()).toBe(0);

    await expect(db.sql`UPDATE pay.b2b_ramp_bank_lines SET amount = 1 WHERE line_id = ${statement.lineId}`).rejects.toThrow(/append-only/);
    const unmarked = line(merchantId);
    await socket().recordBankLine(unmarked);
    await expect(db.sql`
      INSERT INTO pay.b2b_ramp_credits (bank_line_pk, merchant_id, amount, asset, ledger_posted)
      SELECT id, merchant_id, amount, asset, true FROM pay.b2b_ramp_bank_lines WHERE line_id = ${unmarked.lineId}
    `).rejects.toThrow(/check/i);
    const admitted = await socket().credit({ merchantId, bankLineId: statement.lineId, amount: '10.10', asset: 'USD' });
    await expect(db.sql`UPDATE pay.b2b_ramp_credits SET amount = 1 WHERE id = ${admitted.creditId}`).rejects.toThrow(/append-only/);
    await expect(db.sql`DELETE FROM pay.b2b_ramp_credits WHERE id = ${admitted.creditId}`).rejects.toThrow(/append-only/);

    const columns = await db.sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'pay' AND table_name IN ('b2b_ramp_bank_lines', 'b2b_ramp_credits')
    `;
    const names = columns.map((row) => row.column_name);
    expect(names.some((name) => /balance|client|claim|fee/.test(name))).toBe(false);
    expect(names).toContain('ledger_posted');
  });

  it('refuses an amount with more than 20 integer digits as a bad request', async () => {
    const owner = randomUUID();
    const merchantId = await merchant(owner);
    const amount = `${'9'.repeat(21)}.01`;
    await expect(socket().recordBankLine(line(merchantId, { amount }))).rejects.toMatchObject({ kind: 'bad_request' });
    await expect(socket().credit({ merchantId, bankLineId: `line-${randomUUID()}`, amount, asset: 'USD' })).rejects.toMatchObject({
      kind: 'bad_request',
    });
    const rows = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pay.b2b_ramp_bank_lines`;
    expect(rows[0]!.n).toBe(0);
    expect(await creditCount()).toBe(0);
  });

  it('treats a numeric overflow from Postgres (SQLSTATE 22003) as a bad request', async () => {
    await db.sql`ALTER TABLE pay.b2b_ramp_bank_lines ALTER COLUMN amount TYPE numeric(4, 2)`;
    try {
      const owner = randomUUID();
      const merchantId = await merchant(owner);
      await expect(socket().recordBankLine(line(merchantId, { amount: '1000.00' }))).rejects.toMatchObject({
        code: 'pay.b2b_ramp_line_rejected',
        kind: 'bad_request',
      });
      const rows = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pay.b2b_ramp_bank_lines`;
      expect(rows[0]!.n).toBe(0);
    } finally {
      await db.sql`ALTER TABLE pay.b2b_ramp_bank_lines ALTER COLUMN amount TYPE numeric(38, 18)`;
    }
  });

  it('refuses the downgrade when a bank line exists and when a credit exists', async () => {
    const down = readFileSync(join(drizzle, '0078_pay_b2b_ramp.down.sql'), 'utf8');
    const owner = randomUUID();
    const merchantId = await merchant(owner);
    const statement = line(merchantId);
    await socket().recordBankLine(statement);
    await expect(
      db.sql.begin(async (tx) => {
        await tx.unsafe(down);
      }),
    ).rejects.toThrow('pay.b2b_ramp_bank_lines prevents downgrade');

    await socket().credit({ merchantId, bankLineId: statement.lineId, amount: '10.10', asset: 'USD' });
    await expect(
      db.sql.begin(async (tx) => {
        await tx.unsafe(down);
      }),
    ).rejects.toThrow('pay.b2b_ramp_credits prevents downgrade');
    expect(await creditCount()).toBe(1);
  });
});
