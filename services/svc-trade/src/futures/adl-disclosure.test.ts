/**
 * D26-P1-T1g — ADL disclosure + last-resort refuse-silent unit proofs.
 */
import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { ADL_DISCLOSURE_COPY, ADL_DISCLOSURE_VERSION, memoryAdlDisclosureStore, presentAdlDisclosureWire } from './adl-disclosure.js';
import {
  ADL_DISCLOSURE_BEFORE_ACTION,
  ADL_NO_ELIGIBLE_CANDIDATE,
  ADL_UNCONFIGURED,
  memoryAdlDisclosureEventStore,
  runAdlLastResort,
  sizeUnderAdlCap,
  type AdlCandidate,
  type AdlOwnerPolicy,
} from './adl-last-resort.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const BANKRUPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CANDIDATE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = new Date('2026-08-12T14:00:00.000Z');

function candidate(overrides: Partial<AdlCandidate> = {}): AdlCandidate {
  return {
    positionId: CANDIDATE_ID,
    userId: USER_B,
    marketId: 'm1',
    side: 'short',
    size: parseAmount('10'),
    ...overrides,
  };
}

describe('adl-disclosure', () => {
  it('exports stable version + non-empty copy without inventing thresholds', () => {
    expect(ADL_DISCLOSURE_VERSION).toBe('DIRECTION-2026-07-31:34');
    expect(ADL_DISCLOSURE_COPY.length).toBeGreaterThan(40);
    expect(ADL_DISCLOSURE_COPY.toLowerCase()).toContain('last-resort');
    expect(ADL_DISCLOSURE_COPY).not.toMatch(/\d+\s*%/);
  });

  it('presents the ack state for the current version only; a stale version reads unacknowledged', async () => {
    const store = memoryAdlDisclosureStore();
    expect(presentAdlDisclosureWire(await store.getAck(USER_A)).acknowledged).toBe(false);
    await store.recordAck(USER_A, 'stale-v0', AT);
    expect(presentAdlDisclosureWire(await store.getAck(USER_A)).acknowledged).toBe(false);
    const ack = await store.recordAck(USER_A, ADL_DISCLOSURE_VERSION, AT);
    expect(presentAdlDisclosureWire(ack)).toMatchObject({ acknowledged: true, acknowledgedAt: AT.toISOString() });
  });
});

describe('adl-last-resort', () => {
  it('sizeUnderAdlCap uses integer bps — no float', () => {
    expect(sizeUnderAdlCap(parseAmount('100'), 2_500)).toBe(parseAmount('25'));
    expect(sizeUnderAdlCap(parseAmount('10'), 0)).toBe(0n);
  });

  it('refuses when owner policy is null — no silent ADL', async () => {
    const events = memoryAdlDisclosureEventStore();
    const reduces: string[] = [];
    const outcome = await runAdlLastResort({
      policy: null,
      bankrupt: {
        positionId: BANKRUPT_ID,
        userId: USER_A,
        marketId: 'm1',
        side: 'long',
        uncoveredShortfall: parseAmount('50'),
      },
      candidates: [candidate()],
      disclosureAcks: memoryAdlDisclosureStore(),
      events,
      reducer: {
        async reduce(input) {
          reduces.push(input.positionId);
        },
      },
      at: AT,
      newEventId: () => 'evt-1',
    });
    expect(outcome).toMatchObject({ action: 'refused', code: ADL_UNCONFIGURED });
    expect(reduces).toEqual([]);
    expect(await events.listForBankrupt(BANKRUPT_ID)).toEqual([]);
  });

  it('refuses invalid maxReduceBps (zero / non-integer) — no invent', async () => {
    for (const policy of [{ maxReduceBps: 0 }, { maxReduceBps: 1.5 }, { maxReduceBps: -1 }] as unknown as AdlOwnerPolicy[]) {
      const outcome = await runAdlLastResort({
        policy,
        bankrupt: {
          positionId: BANKRUPT_ID,
          userId: USER_A,
          marketId: 'm1',
          side: 'long',
          uncoveredShortfall: parseAmount('1'),
        },
        candidates: [candidate()],
        disclosureAcks: memoryAdlDisclosureStore(),
        events: memoryAdlDisclosureEventStore(),
        reducer: { async reduce() {} },
        at: AT,
        newEventId: () => 'evt-x',
      });
      expect(outcome.action).toBe('refused');
      if (outcome.action === 'refused') expect(outcome.code).toBe(ADL_UNCONFIGURED);
    }
  });

  it('emits disclosure event BEFORE reducer — order is the safety property', async () => {
    const acks = memoryAdlDisclosureStore();
    await acks.recordAck(USER_B, ADL_DISCLOSURE_VERSION, AT);
    const events = memoryAdlDisclosureEventStore();
    const order: string[] = [];
    const outcome = await runAdlLastResort({
      policy: { maxReduceBps: 2_500 },
      bankrupt: {
        positionId: BANKRUPT_ID,
        userId: USER_A,
        marketId: 'm1',
        side: 'long',
        uncoveredShortfall: parseAmount('50'),
      },
      candidates: [candidate()],
      disclosureAcks: acks,
      events,
      reducer: {
        async reduce(input) {
          order.push(`reduce:${input.disclosureEventId}`);
          expect(input.reason).toBe(ADL_DISCLOSURE_BEFORE_ACTION);
        },
      },
      at: AT,
      newEventId: () => 'evt-before',
    });

    const logged = await events.listForBankrupt(BANKRUPT_ID);
    expect(logged).toHaveLength(1);
    expect(logged[0]!.beforeAction).toBe(true);
    expect(logged[0]!.eventId).toBe('evt-before');
    // Event was recorded before reduce (reducer saw the id that was already logged).
    expect(order).toEqual(['reduce:evt-before']);
    expect(outcome).toMatchObject({
      action: 'reduced',
      code: ADL_DISCLOSURE_BEFORE_ACTION,
      candidatePositionId: CANDIDATE_ID,
    });
    if (outcome.action === 'reduced') {
      expect(outcome.sizeReduced).toBe(parseAmount('2.5'));
    }
  });

  it('never reduces a candidate without prior disclosure ack', async () => {
    const events = memoryAdlDisclosureEventStore();
    const reduces: string[] = [];
    const outcome = await runAdlLastResort({
      policy: { maxReduceBps: 5_000 },
      bankrupt: {
        positionId: BANKRUPT_ID,
        userId: USER_A,
        marketId: 'm1',
        side: 'long',
        uncoveredShortfall: parseAmount('10'),
      },
      candidates: [candidate()],
      disclosureAcks: memoryAdlDisclosureStore(),
      events,
      reducer: {
        async reduce(input) {
          reduces.push(input.positionId);
        },
      },
      at: AT,
      newEventId: () => 'evt-skip',
    });
    expect(outcome).toMatchObject({ action: 'refused', code: ADL_NO_ELIGIBLE_CANDIDATE });
    expect(reduces).toEqual([]);
    expect(await events.listForBankrupt(BANKRUPT_ID)).toEqual([]);
  });
});
