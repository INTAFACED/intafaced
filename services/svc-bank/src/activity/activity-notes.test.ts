import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import { statementCsv, STATEMENT_CSV_HEADER } from '../statements/statement-file.js';
import { ActivityService, type LedgerHistoryPages, type LedgerPageEntry } from './activity-service.js';
import type { ActivityAnnotation } from './activity-records.js';

/** PF-activity-03: a report description on a line, the has-note filter and the tax-effect refusal. */

const SECRET = 'a-bank-activity-notes-test-secret-long-enough';
const ALICE = '11111111-1111-4111-8111-111111111111';

function entry(txId: string, seq: number): LedgerPageEntry {
  return {
    txId,
    module: 'bank',
    reason: 'bank.transfer.manual',
    direction: 'debit',
    amount: '1',
    assetId: 'USDT',
    postedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)),
    entryId: String(seq),
  };
}

const pages: LedgerHistoryPages = {
  async page(req) {
    if (req.cursor !== undefined || req.ownerType !== 'user') return { entries: [], nextCursor: null };
    return { entries: [entry('tx-3', 3), entry('tx-2', 2), entry('tx-1', 1)], nextCursor: null };
  },
};

type Records = NonNullable<ConstructorParameters<typeof ActivityService>[1]>['records'];
const noted = (id: string, extra: Partial<ActivityAnnotation>): ActivityAnnotation => ({ id, ...extra }) as ActivityAnnotation;

function service(records?: Records) {
  return new ActivityService({ allNamedSpaces: async () => [] }, { pages, cursorSecret: SECRET, ...(records ? { records } : {}) });
}

const forItems =
  (marks: Record<string, Partial<ActivityAnnotation>>): NonNullable<Records>['forItems'] =>
  async (_user, items) =>
    new Map(items.filter((i) => marks[i.txId]).map((i) => [i.id, noted(i.id, marks[i.txId]!)]));

describe('report description and the has-note filter', () => {
  const records = (): Records =>
    ({
      forItems: forItems({
        'tx-1': { privateNote: 'rent' },
        'tx-2': { reportDescription: 'Office rent, October' },
      }),
    }) as Records;

  it('shows the description on its line only', async () => {
    const all = await service(records()).list(ALICE, {});
    expect(all.items.find((i) => i.txId === 'tx-2')?.reportDescription).toBe('Office rent, October');
    expect(all.items.find((i) => i.txId === 'tx-1')?.reportDescription).toBeUndefined();
    expect(all.items.find((i) => i.txId === 'tx-3')?.reportDescription).toBeUndefined();
  });

  it('keeps only lines with a note or a description', async () => {
    const out = await service(records()).list(ALICE, { hasNote: true });
    expect(out.items.map((i) => i.txId).sort()).toEqual(['tx-1', 'tx-2']);
  });

  it('fails the read, not shows an empty list, when notes cannot be read during the filter', async () => {
    const broken = {
      forItems: async () => {
        throw new Error('db down');
      },
    } as unknown as Records;
    await expect(service(broken).list(ALICE, { hasNote: true })).rejects.toMatchObject({ name: 'ActivityUnavailableError' });
    expect((await service(broken).list(ALICE, {})).items).toHaveLength(3);
    await expect(service().list(ALICE, { hasNote: true })).rejects.toMatchObject({ name: 'ActivityUnavailableError' });
  });

  it('puts the description in its own CSV column, after the payment reference', async () => {
    const out = await service(records()).list(ALICE, {});
    const csv = statementCsv(out.items);
    const rows = csv.replace('﻿', '').split('\r\n');
    expect(STATEMENT_CSV_HEADER.at(-1)).toBe('Report description');
    expect(rows[0]?.endsWith(',Payment reference,Report description')).toBe(true);
    expect(rows.find((r) => r.includes('tx-2'))?.endsWith(',"Office rent, October"')).toBe(true);
    expect(rows.find((r) => r.includes('tx-3'))?.endsWith(',,')).toBe(true);
  });

  it('does not run a formula typed into a description', () => {
    const csv = statementCsv([
      {
        id: 'x',
        kind: 'other',
        direction: 'out',
        asset: 'USDT',
        amount: '1',
        postedAt: '2026-10-01T00:00:00.000Z',
        txId: 'tx',
        counterparty: null,
        spaceName: null,
        reportDescription: '=1+1',
      } as never,
    ]);
    expect(csv).toContain(",'=1+1");
  });
});

describe('over the router', () => {
  const EDGE = 'a-bank-activity-notes-edge-secret-long-enough';
  const edge = createEdgeContext({ secret: EDGE, serviceName: 'svc-bank' });
  function caller(bank: Record<string, unknown>) {
    const principal = {
      sub: ALICE,
      userId: ALICE,
      sid: '22222222-2222-4222-8222-222222222222',
      scopes: ['bank:read', 'bank:write'],
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(principal);
    return createBankRouter(bank as unknown as BankServices).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: 'req',
      }),
    );
  }

  it('serves the tax-effect map instead of refusing (RC-portfolio-02)', async () => {
    const out = await caller({ activity: service() }).activity.taxEffects({});
    expect(out.unmappedCode).toBe('portfolio.tax_effect_unmapped');
    expect(out.rows).toHaveLength(5);
  });

  it('takes a description alone, and refuses a write with neither a note nor a description', async () => {
    const written: unknown[] = [];
    const activityRecords = {
      setNote: async (_user: string, input: unknown) => {
        written.push(input);
        return { activityId: 'a', text: null, reportDescription: 'Office rent', updatedAt: '2026-10-20T00:00:00.000Z' };
      },
    };
    const activity = { get: async () => ({ item: {}, lines: [], complete: true }) };
    const api = caller({ activity, activityRecords });
    const out = await api.activity.note.set({ id: 'tx-1:u:USDT:out', reportDescription: 'Office rent', commandId: 'cmd-00000001' });
    expect(out.text).toBeNull();
    expect(out.reportDescription).toBe('Office rent');
    expect(written).toHaveLength(1);
    await expect(api.activity.note.set({ id: 'tx-1:u:USDT:out', commandId: 'cmd-00000002' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(written).toHaveLength(1);
  });
});
