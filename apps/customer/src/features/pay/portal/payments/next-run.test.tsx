import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { NextRun } from './Subscriptions';
import { feeStory, percentOfBps, starterFeeStory } from '../ui/fee-story';

// TEST data only.
describe('the next run of a subscription', () => {
  it('names a time that is still to come', () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const out = renderToString(<NextRun status="active" nextRunAt={future} />);
    expect(out).toContain('<time');
    expect(out).not.toContain('Overdue');
  });
  it('says the run has not been recorded when the date has passed, and never calls it "next"', () => {
    const out = renderToString(<NextRun status="active" nextRunAt="2026-10-17T00:00:00.000Z" />);
    expect(out).toContain('Overdue: the scheduled run at ');
    expect(out).toContain('has not been recorded');
    expect(out).not.toContain('<time');
  });
  it('says nothing is due while the schedule is paused', () => {
    expect(renderToString(<NextRun status="paused" nextRunAt="2026-10-17T00:00:00.000Z" />)).toContain('No further run');
  });
});

describe('the one fee statement', () => {
  it('uses percent, marks a TEST value only when the server does, and never says basis points', () => {
    expect(percentOfBps(250)).toBe('2.50%');
    expect(percentOfBps(5)).toBe('0.05%');
    const starter = { bps: 250, source: 'local_test' as const };
    expect(feeStory({ feeBps: 250, starterFee: starter })).toBe('Starter fee 2.50% (TEST value) — taken when a payment settles');
    expect(feeStory({ feeBps: 250 })).toBe('Fee 2.50% — taken when a payment settles');
    // A rate that is not the server's marked starter value is not labelled TEST.
    expect(feeStory({ feeBps: 100, starterFee: starter })).toBe('Fee 1.00% — taken when a payment settles');
    // No rate is a plain present-tense fact. It says nothing about a default: the portal cannot know whether one is published.
    expect(feeStory({ feeBps: null })).toBe('No rate is set on your account.');
    expect(feeStory(null)).toBe('No rate is set on your account.');
    // A new account's starting fee is stated from what the service published, with the service's own TEST mark.
    expect(starterFeeStory(starter)).toBe('Starter fee 2.50% (TEST value) — taken when a payment settles');
    expect(starterFeeStory(null)).toBeNull();
  });
});
