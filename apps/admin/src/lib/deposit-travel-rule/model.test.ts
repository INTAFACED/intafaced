import { describe, expect, it } from 'vitest';
import { readReleaseAnswer, readTravelRuleRequest, readWaitAnswer, travelRuleDetail, travelRuleSteps } from './model';

const DEPOSIT = '7d8c9b0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a';
const held = (over: Record<string, unknown> = {}) => ({
  depositId: DEPOSIT,
  state: 'counterparty_pending',
  waitDeadline: '2026-10-25T10:00:00.000Z',
  ...over,
});

describe('travel-rule review requests', () => {
  it('reads exactly the step shape, trims the reason, and refuses anything else', () => {
    const body = { action: 'release', depositId: DEPOSIT, reason: '  counterparty matched the declaration  ' };
    expect(readTravelRuleRequest(body)).toEqual({ ...body, reason: 'counterparty matched the declaration' });
    expect(readTravelRuleRequest({ ...body, action: 'wait' })).toMatchObject({ action: 'wait' });
    expect(readTravelRuleRequest({ ...body, action: 'reject' })).toBeNull();
    expect(readTravelRuleRequest({ ...body, reason: 'short' })).toBeNull();
    expect(readTravelRuleRequest({ ...body, depositId: 'not-a-uuid' })).toBeNull();
    expect(readTravelRuleRequest({ ...body, amount: '1' })).toBeNull();
  });

  it('offers release only for a declared deposit compliance is reviewing, and never for a released one', () => {
    expect(travelRuleSteps('awaiting_declaration', false)).toEqual({ wait: true, release: false });
    expect(travelRuleSteps('under_review', true)).toEqual({ wait: true, release: true });
    expect(travelRuleSteps('counterparty_pending', true)).toEqual({ wait: false, release: true });
    expect(travelRuleSteps('counterparty_pending', false)).toEqual({ wait: false, release: false });
    expect(travelRuleSteps('blocking_time_expired', true)).toEqual({ wait: true, release: true });
    expect(travelRuleSteps('released', true)).toEqual({ wait: false, release: false });
    expect(travelRuleSteps(null, true)).toEqual({ wait: false, release: false });
  });

  it('reads svc-pay answers strictly', () => {
    expect(readWaitAnswer(held())).toEqual(held());
    expect(readWaitAnswer(held({ waitDeadline: null }))).toBeNull();
    expect(readWaitAnswer(held({ state: 'released' }))).toBeNull();
    expect(readReleaseAnswer({ deposit: held({ state: 'released', waitDeadline: null }), credited: true })).toMatchObject({
      credited: true,
    });
    expect(readReleaseAnswer({ deposit: held({ state: 'under_review' }), credited: true })).toBeNull();
    expect(readReleaseAnswer({ deposit: held({ state: 'released' }) })).toBeNull();
  });

  it('says what happened, and that a wait running out releases nothing', () => {
    expect(travelRuleDetail('wait', held())).toContain('still held');
    expect(travelRuleDetail('release', { ...held({ state: 'released' }), credited: true })).toContain('credited it once');
    expect(travelRuleDetail('release', { ...held({ state: 'released' }), credited: false })).toContain('next pass credits it once');
  });
});
