/**
 * BK-pots-02 (J-bank-07 #3): money that flows into a space on its own, and a statement of that one space. A card
 * round-up can target one of the person's own named spaces: the spare change moves once per capture with the own-space
 * transfer recipe, a re-drive returns the first answer, an empty account or an archived space is refused by name and
 * moves nothing. A standing order lists the space it pays into, and only when that space is the caller's own. A space
 * statement holds that space's lines and no others. Enters through the router where a customer would. Uses
 * TEST_DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  MemoryLedger,
  formatAmount,
  parseAmount,
  recipes,
  subAccountAvailable,
  userAvailable,
  type LedgerClient,
  type LedgerTx,
} from '@intafaced/ledger-client';
import type { LedgerPageEntry, LedgerPageRequest } from '../activity/activity-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'r'.repeat(32);
const ADA = '11111111-1111-4111-8111-111111111111';
const BO = '22222222-2222-4222-8222-222222222222';
const SID = '99999999-9999-4999-8999-999999999999';

/** The ledger's own lines for one owner, newest first: the account itself or one subaccount. */
function historyPages(ledger: MemoryLedger) {
  return {
    async page(req: LedgerPageRequest): Promise<{ entries: LedgerPageEntry[]; nextCursor: string | null }> {
      if (req.cursor !== undefined) return { entries: [], nextCursor: null };
      const assetId = req.assetId ?? 'USDT';
      const ref = req.ownerType === 'user' ? userAvailable(req.ownerId, assetId) : subAccountAvailable(req.ownerId, assetId);
      const { accountId } = await ledger.balance(ref);
      const entries: LedgerPageEntry[] = [];
      // The feed orders lines by the ledger's own entry sequence, a number; the journal's position stands in for it.
      let sequence = 0;
      for (const tx of ledger.journal() as LedgerTx[]) {
        for (const entry of tx.entries) {
          sequence += 1;
          if (entry.accountId !== accountId || entry.assetId !== assetId) continue;
          entries.push({
            txId: tx.id,
            module: tx.module,
            reason: tx.reason,
            direction: entry.direction,
            amount: formatAmount(entry.amount),
            postedAt: tx.postedAt,
            assetId: entry.assetId,
            entryId: String(sequence),
          });
        }
      }
      entries.reverse();
      return { entries: entries.slice(0, req.limit), nextCursor: null };
    },
  };
}

describe('money into a space, and its statement (BK-pots-02)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let bank: BankServices;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('TEST_DATABASE_URL is unset');
    db = await createTestDatabase({ service: 'bank', url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`TRUNCATE bank.auto_invest_runs, bank.auto_invest_rules, bank.scheduled_transfers, bank.spaces RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      spaceLimit: '5',
      activity: { cursorSecret: SECRET, pages: historyPages(ledger) },
    });
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  function caller(userId: string) {
    const principal = {
      sub: userId,
      userId,
      sid: SID,
      scopes: ['bank:read', 'bank:write'],
      tier: 'full',
      mfa: true,
    } as unknown as Principal;
    const raw = encodePrincipal({ ...principal, expiresAt: new Date(Date.now() + 60_000) } as Principal);
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
    return createBankRouter(bank).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
    );
  }

  const fund = (userId: string, amount: string) =>
    ledger.post(recipes.deposit({ userId, assetId: 'USDT', amount: parseAmount(amount), rail: 'test', railRef: randomUUID() }));
  const pot = (userId = ADA, name = 'TEST holiday', assetId = 'USDT') => bank.spaces.create({ userId, assetId, name, lockedUntil: null });
  const balanceOf = async (spaceId: string) => formatAmount((await ledger.balance(subAccountAvailable(spaceId, 'USDT'))).amount);
  const mainOf = async (userId = ADA) => formatAmount((await ledger.balance(userAvailable(userId, 'USDT'))).amount);
  const roundUpInto = (spaceId: string, granularity = '1') =>
    caller(ADA).autoInvest.createRoundUp({ assetId: 'USDT', granularity, targetSpaceId: spaceId });
  const capture = (authorizationId: string, captured: string) =>
    bank.autoInvest.applyRoundUp({ userId: ADA, assetId: 'USDT', authorizationId, captured: parseAmount(captured) });

  it('makes a round-up into the person’s own space and refuses every other target by name', async () => {
    const holiday = await pot();
    const main = await bank.spaces.ensurePrimary(ADA, 'USDT');
    const bos = await pot(BO, 'TEST other');
    const euro = await pot(ADA, 'TEST euro', 'EURC');
    const ada = caller(ADA);
    const invalid = { cause: { code: 'bank.auto_invest_target_invalid' } };

    await expect(ada.autoInvest.createRoundUp({ assetId: 'USDT', granularity: '1' })).rejects.toMatchObject(invalid);
    await expect(
      ada.autoInvest.createRoundUp({ assetId: 'USDT', granularity: '1', targetSpaceId: holiday.id, targetPoolId: randomUUID() }),
    ).rejects.toMatchObject(invalid);
    await expect(roundUpInto(main.id)).rejects.toMatchObject(invalid);
    await expect(roundUpInto(bos.id)).rejects.toMatchObject({ cause: { code: 'bank.space_not_found' } });
    await expect(roundUpInto(euro.id)).rejects.toMatchObject({ cause: { code: 'bank.asset_mismatch' } });
    await bank.spaces.archive(holiday.id);
    await expect(roundUpInto(holiday.id)).rejects.toMatchObject({ cause: { code: 'bank.space_archived' } });
    expect(await sql`SELECT 1 FROM bank.auto_invest_rules`).toHaveLength(0);

    await bank.spaces.unarchive(holiday.id);
    const rule = await roundUpInto(holiday.id);
    expect(rule).toMatchObject({ kind: 'card_roundup', targetSpaceId: holiday.id, targetPoolId: null, amount: '1', status: 'active' });
    await expect((await ada.autoInvest.list({ limit: 50 })).find((row) => row.id === rule.id)).toMatchObject({ targetSpaceId: holiday.id });
    // One live round-up per asset, whichever its target.
    const other = await pot(ADA, 'TEST bills');
    await expect(roundUpInto(other.id)).rejects.toMatchObject({ cause: { code: 'bank.auto_invest_roundup_exists' } });
    // Read for one space: only the round-ups into it.
    expect((await ada.autoInvest.list({ limit: 50, targetSpaceId: holiday.id })).map((row) => row.id)).toEqual([rule.id]);
    expect(await ada.autoInvest.list({ limit: 50, targetSpaceId: other.id })).toEqual([]);
  });

  it('moves the spare change of a capture into the space once, and a re-drive returns the first answer', async () => {
    await fund(ADA, '10');
    const holiday = await pot();
    const rule = await roundUpInto(holiday.id);
    const auth = randomUUID();

    const first = await capture(auth, '4.30');
    expect(first).toMatchObject({ status: 'settled', amount: parseAmount('0.7'), spaceId: holiday.id });
    expect(await balanceOf(holiday.id)).toBe('0.7');
    expect(await mainOf()).toBe('9.3');

    const again = await capture(auth, '4.30');
    expect(again).toEqual(first);
    expect(await balanceOf(holiday.id)).toBe('0.7');
    const runs = await sql<{ status: string; amount: string; ledger_tx_id: string; client_run_id: string }[]>`
      SELECT status, amount::text, ledger_tx_id, client_run_id FROM bank.auto_invest_runs WHERE rule_id = ${rule.id}
    `;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'settled', client_run_id: `roundup:${rule.id}:${auth}` });
    expect(runs[0]!.ledger_tx_id).toBe((first as { ledgerTxId: string }).ledgerTxId);

    // An exact multiple has nothing to move.
    await expect(capture(randomUUID(), '5')).resolves.toMatchObject({ status: 'skipped', reason: 'bank.auto_invest_no_spare' });
    expect(await balanceOf(holiday.id)).toBe('0.7');
  });

  it('refuses by name and moves nothing when the account is empty or the space is archived, then settles on a retry', async () => {
    const holiday = await pot();
    const rule = await roundUpInto(holiday.id);
    const auth = randomUUID();

    const empty = await capture(auth, '2.25');
    expect(empty).toMatchObject({ status: 'refused', reason: 'ledger.insufficient_funds' });
    expect(await balanceOf(holiday.id)).toBe('0');
    const [rejected] = await sql<{ status: string; rejection_code: string }[]>`
      SELECT status, rejection_code FROM bank.auto_invest_runs WHERE rule_id = ${rule.id}
    `;
    expect(rejected).toMatchObject({ status: 'rejected', rejection_code: 'ledger.insufficient_funds' });

    await fund(ADA, '5');
    await expect(capture(auth, '2.25')).resolves.toMatchObject({ status: 'settled', amount: parseAmount('0.75') });
    expect(await balanceOf(holiday.id)).toBe('0.75');

    await bank.spaces.archive(holiday.id);
    await expect(capture(randomUUID(), '1.5')).resolves.toMatchObject({ status: 'refused', reason: 'bank.space_archived' });
    expect(await balanceOf(holiday.id)).toBe('0.75');
    expect(await mainOf()).toBe('4.25');
  });

  it('keeps the run pending when the ledger’s answer is lost or names another movement, and a re-drive moves it once', async () => {
    await fund(ADA, '10');
    const holiday = await pot();
    const rule = await roundUpInto(holiday.id);
    const auth = randomUUID();
    const deposit = ledger.journal()[0] as LedgerTx;
    // The same book, with a ledger whose post fails in the two ways that prove nothing about what was booked.
    const through = (post: LedgerClient['post']) =>
      createBankServices(
        sql,
        new Proxy(ledger, {
          get: (target, key) => {
            if (key === 'post') return post;
            const value = Reflect.get(target, key, target) as unknown;
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          },
        }),
        memoryLedgerHistory(ledger),
        { nativeAssetId: 'IFC', recipients: memoryRecipientState(), spaceLimit: '5' },
      );
    const run = async () =>
      (await sql<{ status: string }[]>`SELECT status FROM bank.auto_invest_runs WHERE rule_id = ${rule.id}`).map((r) => r.status);
    const input = { userId: ADA, assetId: 'USDT', authorizationId: auth, captured: parseAmount('4.30') };

    const lost = await through(async () => {
      throw new Error('socket hang up');
    }).autoInvest.applyRoundUp(input);
    expect(lost).toMatchObject({ status: 'refused', reason: 'bank.ledger_outcome_unknown' });
    expect(await run()).toEqual(['pending']);

    // Detect mode answers a reused key with the original transaction: here, one that is not this movement.
    const other = await through(async () => deposit).autoInvest.applyRoundUp(input);
    expect(other).toMatchObject({ status: 'refused', reason: 'bank.ledger_outcome_unknown' });
    expect(await run()).toEqual(['pending']);
    expect(await balanceOf(holiday.id)).toBe('0');

    await expect(capture(auth, '4.30')).resolves.toMatchObject({ status: 'settled', amount: parseAmount('0.7') });
    await expect(capture(auth, '4.30')).resolves.toMatchObject({ status: 'settled', amount: parseAmount('0.7') });
    expect(await run()).toEqual(['settled']);
    expect(await balanceOf(holiday.id)).toBe('0.7');
    expect(await mainOf()).toBe('9.3');
  });

  it('lists the space a standing order pays into only when that space is the caller’s own', async () => {
    await fund(ADA, '10');
    const main = await bank.spaces.ensurePrimary(ADA, 'USDT');
    const bosMain = await bank.spaces.ensurePrimary(BO, 'USDT');
    const holiday = await pot();
    const startsAt = new Date(Date.now() + 86_400_000);
    const own = await bank.transfers.schedule({
      userId: ADA,
      fromSpaceId: main.id,
      toSpaceId: holiday.id,
      amount: parseAmount('2'),
      cadence: 'weekly',
      startsAt,
      endsAt: null,
      scheduleId: randomUUID(),
    });
    const toBo = await bank.transfers.schedule({
      userId: ADA,
      fromSpaceId: main.id,
      toSpaceId: bosMain.id,
      amount: parseAmount('1'),
      cadence: 'weekly',
      startsAt,
      endsAt: null,
      scheduleId: randomUUID(),
    });
    const rows = await caller(ADA).transfers.listSchedules({ limit: 50 });
    expect(rows.find((row) => row.id === own.id)).toMatchObject({ fromSpaceId: main.id, toSpaceId: holiday.id });
    expect(rows.find((row) => row.id === toBo.id)).toMatchObject({ fromSpaceId: main.id, toSpaceId: null });
    // Read for one space: only the orders into it, and another person's space names none.
    expect((await caller(ADA).transfers.listSchedules({ limit: 50, toSpaceId: holiday.id })).map((row) => row.id)).toEqual([own.id]);
    expect(await caller(ADA).transfers.listSchedules({ limit: 50, toSpaceId: bosMain.id })).toEqual([]);
  });

  it('builds a statement of one space’s lines only, and another person’s space reads as not found', async () => {
    await fund(ADA, '20');
    const main = await bank.spaces.ensurePrimary(ADA, 'USDT');
    const holiday = await pot();
    const bills = await pot(ADA, 'TEST bills');
    const ada = caller(ADA);
    await ada.transfers.create({ transferId: `own-${randomUUID()}`, fromSpaceId: main.id, toSpaceId: holiday.id, amount: '3' });
    await ada.transfers.create({ transferId: `own-${randomUUID()}`, fromSpaceId: main.id, toSpaceId: bills.id, amount: '4' });
    await roundUpInto(holiday.id);
    await capture(randomUUID(), '1.4');
    expect(await balanceOf(holiday.id)).toBe('3.6');

    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const file = await ada.statements.export({ from, to, spaceId: holiday.id, format: 'csv' });
    expect(file).toMatchObject({ rowCount: 2, proof: { spaceId: holiday.id, assetId: 'USDT', rowCount: 2 } });
    expect(file.filename).toMatch(/^intafaced-space-/);
    const csv = Buffer.from(file.bodyBase64, 'base64').toString('utf8');
    const lines = csv.trim().split('\r\n').slice(1);
    expect(lines.map((line) => line.split(',')[4]).sort()).toEqual(['0.6', '3']);
    expect(lines.every((line) => line.includes('TEST holiday'))).toBe(true);

    const whole = await ada.statements.export({ from, to, format: 'csv' });
    expect(whole.proof.spaceId).toBeNull();
    expect(whole.rowCount).toBeGreaterThan(file.rowCount);

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1);
    const pdf = await ada.statements.export({
      from: monthStart.toISOString(),
      to: monthEnd.toISOString(),
      spaceId: holiday.id,
      format: 'pdf',
    });
    // PDF text escapes the brackets around the id.
    expect(Buffer.from(pdf.bodyBase64, 'base64').toString('latin1')).toContain(`Space: TEST holiday \\(${holiday.id}\\)`);

    await expect(caller(BO).statements.export({ from, to, spaceId: holiday.id, format: 'csv' })).rejects.toMatchObject({
      cause: { code: 'bank.space_not_found' },
    });
    await expect(ada.statements.export({ from, to, spaceId: holiday.id, assetId: 'EURC', format: 'csv' })).rejects.toMatchObject({
      cause: { code: 'bank.asset_mismatch' },
    });
  });
});
