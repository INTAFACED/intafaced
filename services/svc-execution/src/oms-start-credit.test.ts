import { describe, expect, it } from 'vitest';
import { InMemoryApprovedAlgoParentStore, type ApprovedAlgoParent, type RetainedAlgoSchedule } from './oms-start.js';
import { startApprovedAlgoParentWithPreTradeCredit } from './oms-start-credit.js';

const MATCHING_OPEN = { venueHalted: false } as const;
const OP = '33333333-3333-4333-8333-333333333333';

function retainedTwap(): RetainedAlgoSchedule {
  return { durationMs: 60_000, sliceIntervalMs: 10_000, slicesPlanned: 6, participationBps: null };
}

function approved(
  over: Partial<ApprovedAlgoParent> &
    Pick<ApprovedAlgoParent, 'parentClientOrderId' | 'kind'> & {
      schedule?: RetainedAlgoSchedule;
    },
): ApprovedAlgoParent {
  const schedule = over.schedule ?? retainedTwap();
  return {
    status: 'approved',
    startedAt: null,
    ...over,
    schedule,
  };
}

describe('startApprovedAlgoParentWithPreTradeCredit', () => {
  it('refuses null credit with reason credit_blank; parent stays approved', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(approved({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const result = startApprovedAlgoParentWithPreTradeCredit({
      parentClientOrderId: 'parent-twap',
      operatorId: OP,
      parentStore,
      jobs: { enabled: true },
      matchingVenueHalt: MATCHING_OPEN,
      credit: null,
    });
    expect(result).toMatchObject({ ok: false, reason: 'credit_blank' });
    expect(parentStore.get('parent-twap')?.status).toBe('approved');
  });

  it('refuses undefined credit with reason credit_blank; parent stays approved', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(approved({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const result = startApprovedAlgoParentWithPreTradeCredit({
      parentClientOrderId: 'parent-twap',
      operatorId: OP,
      parentStore,
      jobs: { enabled: true },
      matchingVenueHalt: MATCHING_OPEN,
      credit: undefined,
    });
    expect(result).toMatchObject({ ok: false, reason: 'credit_blank' });
    expect(parentStore.get('parent-twap')?.status).toBe('approved');
  });

  it('refuses whitespace credit with reason credit_blank; parent stays approved', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(approved({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const result = startApprovedAlgoParentWithPreTradeCredit({
      parentClientOrderId: 'parent-twap',
      operatorId: OP,
      parentStore,
      jobs: { enabled: true },
      matchingVenueHalt: MATCHING_OPEN,
      credit: '   ',
    });
    expect(result).toMatchObject({ ok: false, reason: 'credit_blank' });
    expect(parentStore.get('parent-twap')?.status).toBe('approved');
  });

  it("refuses invalid credit ('nope') with reason credit_invalid; parent stays approved", () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(approved({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const result = startApprovedAlgoParentWithPreTradeCredit({
      parentClientOrderId: 'parent-twap',
      operatorId: OP,
      parentStore,
      jobs: { enabled: true },
      matchingVenueHalt: MATCHING_OPEN,
      credit: 'nope',
    });
    expect(result).toMatchObject({ ok: false, reason: 'credit_invalid' });
    expect(parentStore.get('parent-twap')?.status).toBe('approved');
  });

  it('refuses negative-looking credit as credit_invalid; parent stays approved', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(approved({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const result = startApprovedAlgoParentWithPreTradeCredit({
      parentClientOrderId: 'parent-twap',
      operatorId: OP,
      parentStore,
      jobs: { enabled: true },
      matchingVenueHalt: MATCHING_OPEN,
      credit: '-1',
    });
    expect(result).toMatchObject({ ok: false, reason: 'credit_invalid' });
    expect(parentStore.get('parent-twap')?.status).toBe('approved');
  });

  it("with credit '100' and jobs on + approved + operator + matching open: start succeeds", () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(approved({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const result = startApprovedAlgoParentWithPreTradeCredit({
      parentClientOrderId: 'parent-twap',
      operatorId: OP,
      parentStore,
      jobs: { enabled: true },
      matchingVenueHalt: MATCHING_OPEN,
      credit: '100',
      now: new Date('2026-08-25T12:00:00.000Z'),
    });
    expect(result).toEqual({
      ok: true,
      started: true,
      parentClientOrderId: 'parent-twap',
      kind: 'twap',
      status: 'running',
      schedule: retainedTwap(),
      startedAt: '2026-08-25T12:00:00.000Z',
    });
    expect(parentStore.get('parent-twap')?.status).toBe('running');
  });

  it("with credit '0' (not blank): start proceeds — zero is an owner limit, not invented", () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(approved({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const result = startApprovedAlgoParentWithPreTradeCredit({
      parentClientOrderId: 'parent-twap',
      operatorId: OP,
      parentStore,
      jobs: { enabled: true },
      matchingVenueHalt: MATCHING_OPEN,
      credit: '0',
      now: new Date('2026-08-25T12:00:00.000Z'),
    });
    expect(result).toMatchObject({ ok: true, started: true, status: 'running' });
    expect(parentStore.get('parent-twap')?.status).toBe('running');
  });

  it('jobs_off still refuses after a present credit — parent stays approved', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(approved({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const result = startApprovedAlgoParentWithPreTradeCredit({
      parentClientOrderId: 'parent-twap',
      operatorId: OP,
      parentStore,
      jobs: { enabled: false },
      matchingVenueHalt: MATCHING_OPEN,
      credit: '100',
    });
    expect(result).toMatchObject({ ok: false, reason: 'jobs_off' });
    expect(parentStore.get('parent-twap')?.status).toBe('approved');
  });

  it('does not invent a limit: never returns ok true when credit is blank', () => {
    const blanks: Array<string | null | undefined> = [null, undefined, '', '   ', '\t', '\n'];
    for (const credit of blanks) {
      const parentStore = new InMemoryApprovedAlgoParentStore();
      parentStore.seed(approved({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
      const result = startApprovedAlgoParentWithPreTradeCredit({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        parentStore,
        jobs: { enabled: true },
        matchingVenueHalt: MATCHING_OPEN,
        credit,
      });
      expect(result.ok, `blank credit ${JSON.stringify(credit)} must not start`).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('credit_blank');
      }
      expect(parentStore.get('parent-twap')?.status).toBe('approved');
    }
  });
});
