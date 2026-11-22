// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

/** The bank as the page sees it: every read answers from `world`, and the runs read can be held back. */
const world = vi.hoisted(() => ({
  runs: [] as unknown[],
  holdRuns: null as Promise<void> | null,
  mutations: [] as { procedure: string; body: unknown }[],
  answer: (_procedure: string, _body: unknown): unknown => null,
}));
vi.mock('../../session', async (original) => {
  const real = await original<typeof import('../../session')>();
  const api = {
    canWrite: () => true,
    query: async (_service: string, procedure: string) => {
      if (procedure === 'businessTeam.overview')
        return {
          ok: true,
          data: {
            account: { id: ACCOUNT, name: 'TEST Payroll', assetId: 'USDT', status: 'active' },
            owner: true,
            me: { userId: 'owner', handle: 'owner', role: 'admin' },
            inviteMinutes: null,
            partner: { label: 'TEST partner bank', amount: '700', asOf: null },
          },
        };
      if (procedure === 'businessPayouts.runs') {
        const hold = world.holdRuns;
        if (hold) await hold;
        return { ok: true, data: world.runs };
      }
      if (procedure === 'businessPayouts.wallet') return { ok: true, data: null };
      return { ok: true, data: [] };
    },
    mutate: async (_service: string, procedure: string, body: unknown) => {
      world.mutations.push({ procedure, body });
      return { ok: true, data: world.answer(procedure, body) };
    },
    call(
      this: { query: (...args: never[]) => unknown; mutate: (...args: never[]) => unknown },
      record: { kind: string; module: string; path: string; output: unknown },
      input?: unknown,
      opts?: unknown,
    ) {
      // tooling/codemod/call-records: a call by its record reaches this double's own query or mutate, as the client sends it.
      return Reflect.apply(record.kind === 'query' ? this.query : this.mutate, this, [
        record.module,
        record.path,
        input,
        record.output,
        opts,
      ]);
    },
  };
  const session = { api, userId: 'owner', profiles: { business: { accountId: ACCOUNT, name: 'TEST Payroll' } } };
  return { ...real, useSession: () => session as never };
});

const ACCOUNT = vi.hoisted(() => '44444444-4444-4444-8444-444444444444');

import { BusinessPayoutsRoom } from './BusinessPayoutsRoom';

const run = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  accountId: ACCOUNT,
  assetId: 'USDT',
  fileSha256: 'TEST',
  status: 'draft',
  total: '0',
  lines: [],
  issues: [],
  threshold: null,
  approvalsNeeded: 0,
  confirmedBy: null,
  approvals: [],
  partnerKey: `bank.business.bulk-pay:${id}`,
  partnerMoveId: null,
  partnerPayees: null,
  partnerReason: null,
  partnerReasonText: null,
  createdAt: '2026-11-22T00:00:00.000Z',
  sentAt: null,
  ...over,
});
const EMPTY = '11111111-1111-4111-8111-111111111111';
const fresh = run('22222222-2222-4222-8222-222222222222', {
  total: '500',
  lines: [
    { line: 1, name: 'TEST Ana', iban: 'DE89370400440532013000', amount: '300', reference: 'Dec' },
    { line: 2, name: 'TEST Ben', iban: 'GB82WEST12345698765432', amount: '200', reference: 'Dec' },
  ],
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  world.mutations = [];
  world.holdRuns = null;
  // The newest run on the list is a draft whose only line was refused: it has a Confirm of its own.
  world.runs = [run(EMPTY, { issues: [{ line: 1, code: 'asset_mismatch', detail: 'EUR', raw: 'TEST Cy' }] })];
  world.answer = (procedure, body) =>
    procedure === 'businessPayouts.importRun' ? { ...fresh, id: (body as { runId: string }).runId } : null;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});
/** Lets every answered read and change reach the page: the fake bank answers at once, so a few microtask turns suffice. */
const settle = () =>
  act(async () => {
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  });
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text));

describe('bulk payments: the run just imported', () => {
  it('is the one shown and confirmed while the list of runs is still reloading', async () => {
    root = createRoot(host);
    const mounted = root;
    await act(async () => mounted.render(<BusinessPayoutsRoom />));
    await settle();
    expect(host.querySelector('[data-testid="bulk-run"]')?.getAttribute('data-id')).toBe(EMPTY);

    // The list's reload after the import is slow: it has not answered when the person presses Confirm.
    let release = () => undefined as void;
    world.holdRuns = new Promise<void>((resolve) => (release = resolve));
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    const csv = new File(['name,iban,amount,currency,reference\nTEST Ana,DE89370400440532013000,300,USDT,Dec'], 'payroll.csv', {
      type: 'text/csv',
    });
    Object.defineProperty(input, 'files', { value: [csv] });
    await act(async () => void input.dispatchEvent(new Event('change', { bubbles: true })));
    await act(async () => void host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await settle();
    expect(host.textContent).toContain('File imported');
    const imported = world.mutations.find((m) => m.procedure === 'businessPayouts.importRun')!.body as { runId: string };

    const shown = host.querySelector('[data-testid="bulk-run"]');
    expect(shown?.getAttribute('data-id')).toBe(imported.runId);
    expect(host.querySelector('[data-testid="bulk-total"]')?.getAttribute('data-amount')).toBe('500');
    await act(async () => void button('Confirm and send')!.click());
    expect(world.mutations.filter((m) => m.procedure === 'businessPayouts.confirmRun').map((m) => m.body)).toEqual([
      { runId: imported.runId },
    ]);
    release();
    await settle();
  });
});
