import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase } from '@intafaced/db';
import {
  OPS_CAPITAL_THRESHOLD_ACTION,
  opsCapitalThresholdFields,
  createEdgeContext,
  encodePrincipal,
  signPrincipalHeader,
  type ActionApproval,
  type ActionApprovalConsumeInput,
} from '@intafaced/contracts';
import { migrateOutreach } from '../db/migrate.js';
import { approvalPayloadHash } from '../operator-desks.js';
import { OpsService } from '../ops-service.js';
import { createOpsRouter } from '../router.js';
import { createCapitalSources, type CapitalSources, type SourceRead } from './sources.js';
import { MemoryCapitalStore, SqlCapitalStore, type CapitalStore } from './store.js';
import type { BankPartnerReserves, LedgerOwnFunds } from '@intafaced/contracts';

const SECRET = 'a-ops-mount-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-10-24T08:00:00.000Z';
const REASON = 'TEST buffer policy for the capital monitor';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-ops' });

async function signed(scopes: string[]) {
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

/** A stand-in for identity: an approval names one action, target and payload, is approved by a second founder, and is spent once. */
function identity() {
  const rows = new Map<string, { approval: ActionApproval; approved: boolean; spent: boolean }>();
  let n = 0;
  const reject = (code: string): never => {
    throw new Error(code);
  };
  return {
    spent: () => [...rows.values()].filter((r) => r.spent).length,
    propose(actionType: string, fields: Record<string, string>, approved = true) {
      n += 1;
      const approval: ActionApproval = {
        approvalId: `ap_${n}`,
        operationId: `op_${n}`,
        payloadHash: approvalPayloadHash(actionType, fields),
        targetService: 'svc-ops',
        targetId: fields.targetId ?? '',
        expectedVersion: '1',
        actionType,
        requesterId: USER,
        approverId: APPROVER,
        approverIsFounder: true,
        requesterIsFounder: true,
        policyVersion: 'p1',
        createdAt: NOW,
        expiresAt: '2026-10-24T08:10:00.000Z',
        status: 'CONSUMED',
      };
      rows.set(approval.approvalId, { approval, approved, spent: false });
      return { approvalId: approval.approvalId, operationId: approval.operationId };
    },
    async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
      const row = rows.get(input.approvalId) ?? reject('action_approval.not_found');
      // Only a second founder's approval makes it spendable: the asker alone cannot.
      if (!row!.approved) reject('action_approval.not_approved');
      if (row!.spent) reject('action_approval.consumed');
      if (input.payloadHash !== row!.approval.payloadHash) reject('action_approval.payload_mismatch');
      if (input.targetId !== row!.approval.targetId || input.operationId !== row!.approval.operationId)
        reject('action_approval.target_mismatch');
      row!.spent = true;
      return row!.approval;
    },
  };
}

const LEDGER_AT = '2026-11-09T05:59:00.000Z';
const OWN: LedgerOwnFunds = {
  asOf: LEDGER_AT,
  accounts: [
    { ownerType: 'house', ownerId: 'market-maker', assetId: 'USDT', kind: 'available', purpose: '', balance: '100' },
    { ownerType: 'house', ownerId: 'fees:trade', assetId: 'USDT', kind: 'available', purpose: '', balance: '0.5' },
    { ownerType: 'house', ownerId: 'market-maker', assetId: 'BTC', kind: 'available', purpose: '', balance: '2' },
  ],
};
const RESERVES: BankPartnerReserves = {
  asOf: LEDGER_AT,
  partners: [
    { partner: 'bank', label: 'TEST partner bank', test: true, reserve: { status: 'not_known' } },
    { partner: 'card', label: 'TEST partner card', test: true, reserve: { status: 'not_known' } },
  ],
};

function sources(state: { ledger: boolean; bank: boolean; own?: LedgerOwnFunds }): CapitalSources {
  const down = <T>(name: string): SourceRead<T> => ({
    ok: false,
    code: 'ops.capital.source_unavailable',
    message: `${name}: did not answer.`,
  });
  return {
    ownFunds: async () => (state.ledger ? { ok: true, value: state.own ?? OWN } : down('svc-ledger')),
    partnerReserves: async () => (state.bank ? { ok: true, value: RESERVES } : down('svc-bank')),
  };
}

function build(
  store: CapitalStore | null = new MemoryCapitalStore(),
  state = { ledger: true, bank: true } as { ledger: boolean; bank: boolean; own?: LedgerOwnFunds },
) {
  const ids = identity();
  let clock = NOW;
  const router = createOpsRouter(new OpsService(), undefined, {
    approvals: ids,
    now: () => clock,
    ...(store ? { capital: store } : {}),
    capitalSources: sources(state),
  });
  return {
    ids,
    state,
    setClock: (at: string) => {
      clock = at;
    },
    caller: (scopes = ['admin:read', 'admin:write']) => signed(scopes).then((ctx) => router.createCaller(ctx)),
  };
}

const threshold = (ids: ReturnType<typeof identity>, assetId: string, minimum: string, contact: string, key: string, approved = true) => ({
  assetId,
  minimum,
  contact,
  reason: REASON,
  idempotencyKey: key,
  ...ids.propose(OPS_CAPITAL_THRESHOLD_ACTION, opsCapitalThresholdFields(assetId, minimum, contact, REASON), approved),
});

describe('capital monitor (J-ops-console-24 #1)', () => {
  it('shows own funds per asset from the ledger with their accounts, the partners’ reserves as not known, and no venue', async () => {
    const snap = await (await (await build()).caller()).capital.snapshot();
    expect(snap.ownFunds).toEqual({
      status: 'read',
      asOf: LEDGER_AT,
      assets: [
        { assetId: 'BTC', amount: '2', accounts: 1 },
        { assetId: 'USDT', amount: '100.5', accounts: 2 },
      ],
      accounts: OWN.accounts,
    });
    expect(snap.reserves).toEqual({ status: 'read', asOf: LEDGER_AT, partners: RESERVES.partners });
    expect(snap.venues).toMatchObject({ status: 'not_connected', code: 'ops.capital.venue_not_connected' });
    expect(snap.period).toBe('2026-10-24');
  });

  it('a blank threshold is ops.capital.threshold_unset and not monitored, never ok, and opens no alert', async () => {
    const snap = await (await (await build()).caller()).capital.snapshot();
    expect(snap.buffers).toEqual([
      { assetId: 'BTC', buffer: '2', threshold: { status: 'unset', code: 'ops.capital.threshold_unset' }, state: 'not_monitored' },
      { assetId: 'USDT', buffer: '100.5', threshold: { status: 'unset', code: 'ops.capital.threshold_unset' }, state: 'not_monitored' },
    ]);
    expect(snap.alerts).toEqual([]);
  });

  it('a buffer below a set minimum opens one alert per asset and day, escalated to the named contact', async () => {
    const b = build();
    const c = await b.caller();
    const set = await c.capital.setThreshold(threshold(b.ids, 'USDT', '150', 'TEST treasury on-call', 'capital-threshold-test-1'));
    expect(set).toEqual({ assetId: 'USDT', minimum: '150', contact: 'TEST treasury on-call', version: 1, outcome: 'set' });
    await c.capital.setThreshold(threshold(b.ids, 'BTC', '1', 'TEST treasury on-call', 'capital-threshold-test-2'));
    const first = await c.capital.snapshot();
    expect(first.buffers.find((x) => x.assetId === 'USDT')).toMatchObject({ state: 'below_minimum', buffer: '100.5' });
    expect(first.buffers.find((x) => x.assetId === 'BTC')).toMatchObject({ state: 'ok' });
    expect(first.alerts).toEqual([
      {
        key: 'capital-breach:USDT:2026-10-24',
        assetId: 'USDT',
        period: '2026-10-24',
        buffer: '100.5',
        minimum: '150',
        escalatedTo: 'TEST treasury on-call',
        openedAt: NOW,
      },
    ]);
    // The same day evaluated again: still one alert.
    expect((await c.capital.snapshot()).alerts).toHaveLength(1);
    // The next day: a second alert, its own key.
    b.setClock('2026-10-25T08:00:00.000Z');
    expect((await c.capital.snapshot()).alerts.map((a) => a.key)).toEqual([
      'capital-breach:USDT:2026-10-25',
      'capital-breach:USDT:2026-10-24',
    ]);
  });

  it('with the ledger unread, own funds and every set threshold read unknown, no alert opens and no scenario runs', async () => {
    const b = build(new MemoryCapitalStore(), { ledger: true, bank: true });
    const c = await b.caller();
    await c.capital.setThreshold(threshold(b.ids, 'USDT', '150', 'TEST treasury on-call', 'capital-threshold-test-3'));
    b.state.ledger = false;
    const snap = await c.capital.snapshot();
    expect(snap.ownFunds).toEqual({ status: 'unknown', code: 'ops.capital.source_unavailable', message: 'svc-ledger: did not answer.' });
    expect(snap.buffers).toEqual([expect.objectContaining({ assetId: 'USDT', buffer: null, state: 'unknown' })]);
    expect(snap.alerts).toEqual([]);
    await expect(
      c.capital.scenario({ kind: 'counterparty_default', counterparty: 'TEST venue', assetId: 'USDT', exposure: '40', lossShare: '0.5' }),
    ).rejects.toThrow(/ops\.capital\.source_unavailable/);
  });

  it('with svc-bank unread, the reserves part is unknown, never zero or none', async () => {
    const snap = await (await build(new MemoryCapitalStore(), { ledger: true, bank: false }).caller()).capital.snapshot();
    expect(snap.reserves).toEqual({ status: 'unknown', code: 'ops.capital.source_unavailable', message: 'svc-bank: did not answer.' });
  });

  it('a counterparty default loses exposure times the loss share, set against fresh own funds', async () => {
    const c = await build().caller();
    const s = await c.capital.scenario({
      kind: 'counterparty_default',
      counterparty: 'TEST venue',
      assetId: 'USDT',
      exposure: '40',
      lossShare: '0.25',
    });
    expect(s).toMatchObject({ loss: '10', ownFundsBefore: '100.5', ownFundsAfter: '90.5', stateAfter: 'not_monitored' });
    await expect(c.capital.scenario({ kind: 'counterparty_default', assetId: 'USDT', exposure: '40' })).rejects.toThrow(
      /ops\.capital\.scenario_input_missing — No scenario was run: enter the counterparty, loss share \(0 to 1\)/,
    );
  });

  it('clearing a threshold puts the asset back to not monitored; a retry spends nothing; a bad minimum spends nothing', async () => {
    const b = build();
    const c = await b.caller();
    await c.capital.setThreshold(threshold(b.ids, 'USDT', '150', 'TEST treasury on-call', 'capital-threshold-test-4'));
    const clear = threshold(b.ids, 'USDT', '', '', 'capital-threshold-test-5');
    expect(await c.capital.setThreshold(clear)).toMatchObject({ outcome: 'cleared', version: 2, minimum: '' });
    expect(await c.capital.setThreshold(clear)).toMatchObject({ outcome: 'replayed', version: 2 });
    expect(b.ids.spent()).toBe(2);
    expect((await c.capital.snapshot()).buffers.find((x) => x.assetId === 'USDT')).toMatchObject({ state: 'not_monitored' });
    await expect(c.capital.setThreshold(threshold(b.ids, 'USDT', '007', 'x', 'capital-threshold-test-6'))).rejects.toThrow(
      /ops\.capital\.threshold_invalid/,
    );
    await expect(c.capital.setThreshold(threshold(b.ids, 'USDT', '5', '', 'capital-threshold-test-7'))).rejects.toThrow(/contact/);
    expect(b.ids.spent()).toBe(2);
  });

  it('one founder alone cannot set a threshold, and read scope alone cannot write', async () => {
    const b = build();
    await expect(
      (await b.caller()).capital.setThreshold(threshold(b.ids, 'USDT', '1', 'x', 'capital-threshold-test-8', false)),
    ).rejects.toThrow();
    await expect(
      (await b.caller(['admin:read'])).capital.setThreshold(threshold(b.ids, 'USDT', '1', 'x', 'capital-threshold-test-9')),
    ).rejects.toThrow();
    expect((await (await b.caller()).capital.snapshot()).buffers.every((x) => x.state === 'not_monitored')).toBe(true);
  });

  it('without storage every call refuses ops.capital.storage_unconfigured', async () => {
    await expect((await build(null).caller()).capital.snapshot()).rejects.toThrow(/ops\.capital\.storage_unconfigured/);
  });
});

describe('capital sources', () => {
  it('reads unwired sources as unavailable, naming each', async () => {
    const s = createCapitalSources({});
    expect(await s.ownFunds()).toMatchObject({ ok: false, code: 'ops.capital.source_unavailable', message: /^svc-ledger: not wired/ });
    expect(await s.partnerReserves()).toMatchObject({ ok: false, message: /^svc-bank: not wired/ });
  });

  it('posts to each door and refuses an answer in another shape or a refusal', async () => {
    const asked: string[] = [];
    const answer = new Map<string, unknown>([
      ['http://ledger:1/trpc/ownFunds', OWN],
      ['http://bank:2/internal/capital/partner-reserves', { asOf: LEDGER_AT, partners: [{ partner: 'bank', reserve: 0 }] }],
    ]);
    const s = createCapitalSources({
      ledgerUrl: 'http://ledger:1',
      bankUrl: 'http://bank:2',
      secret: 'x'.repeat(40),
      fetcher: (async (url: URL | string) => {
        asked.push(String(url));
        return new Response(JSON.stringify(answer.get(String(url))), { status: 200 });
      }) as typeof fetch,
    });
    expect(await s.ownFunds()).toEqual({ ok: true, value: OWN });
    expect(await s.partnerReserves()).toMatchObject({ ok: false, message: 'svc-bank: answered in a shape this service does not read.' });
    expect(asked).toEqual(['http://ledger:1/trpc/ownFunds', 'http://bank:2/internal/capital/partner-reserves']);
    const refused = createCapitalSources({
      ledgerUrl: 'http://ledger:1',
      secret: 'x'.repeat(40),
      fetcher: (async () => new Response('{}', { status: 403 })) as typeof fetch,
    });
    expect(await refused.ownFunds()).toMatchObject({ ok: false, message: 'svc-ledger: refused the read (403).' });
  });
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('capital monitor on real PostgreSQL', () => {
  it('stores versions append-only, one breach per key, and survives a new store', async () => {
    const database = await createTestDatabase({ service: 'ops' });
    const sql = postgres(database.url, { max: 4, onnotice: () => undefined });
    try {
      await migrateOutreach(sql);
      const b = build(new SqlCapitalStore(sql));
      const c = await b.caller();
      const input = threshold(b.ids, 'USDT', '150.25', 'TEST treasury on-call', 'capital-threshold-pg-1');
      expect(await c.capital.setThreshold(input)).toMatchObject({ outcome: 'set', version: 1, minimum: '150.25' });
      expect(await c.capital.setThreshold(input)).toMatchObject({ outcome: 'replayed', version: 1 });
      await c.capital.snapshot();
      await c.capital.snapshot();
      const fresh = await new SqlCapitalStore(sql).alerts(10);
      expect(fresh).toEqual([expect.objectContaining({ key: 'capital-breach:USDT:2026-10-24', buffer: '100.5', minimum: '150.25' })]);
      expect((await new SqlCapitalStore(sql).thresholds()).get('USDT')).toMatchObject({ minimum: '150.25', approvedBy: APPROVER });
      await c.capital.setThreshold(threshold(b.ids, 'USDT', '', '', 'capital-threshold-pg-2'));
      expect((await new SqlCapitalStore(sql).thresholds()).get('USDT')).toMatchObject({ version: 2, minimum: null });
      await expect(sql`DELETE FROM ops.capital_breach_alerts`).rejects.toThrow(/ops.capital_record_immutable/);
      await expect(sql`UPDATE ops.capital_thresholds SET contact = 'x'`).rejects.toThrow(/ops.capital_record_immutable/);
      await migrateOutreach(sql, 'down');
    } finally {
      await sql.end();
      await database.drop();
    }
  });
});
