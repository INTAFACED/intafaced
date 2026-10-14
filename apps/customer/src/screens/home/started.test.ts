import { describe, expect, it } from 'vitest';
import type { ActivityItem } from './deps';
import { homeCopy } from './copy';
import {
  alertStatus,
  buildSteps,
  depositStatus,
  dismissKey,
  hasMoneyIn,
  hasTrade,
  progress,
  readDismissed,
  securityStatus,
  tradeStatus,
  verificationStatus,
  writeDismissed,
  type StepId,
  type StepStatus,
} from './started';

const row = (kind: ActivityItem['kind'], direction: ActivityItem['direction'] = 'in'): ActivityItem => ({
  id: `${kind}-${direction}`,
  kind,
  direction,
  asset: 'USDT',
  amount: '10',
  postedAt: '2026-10-13T11:29:44Z',
  txId: 'tx',
  counterparty: null,
  spaceName: null,
});

describe('Get started: each step reads real answers', () => {
  it('verification: a held level is done, a pending record is in review, nothing is to do', () => {
    expect(verificationStatus({ tier: 'basic', records: [] })).toBe('done');
    expect(verificationStatus({ tier: 'none', records: [{ status: 'pending' }] })).toBe('review');
    expect(verificationStatus({ tier: 'none', records: [{ status: 'rejected' }] })).toBe('todo');
    expect(verificationStatus({ tier: 'none', records: [] })).toBe('todo');
  });

  it('security: one passkey is done', () => {
    expect(securityStatus(0)).toBe('todo');
    expect(securityStatus(1)).toBe('done');
  });

  it('price alert: a waiting or fired price alert counts, a cancelled one does not', () => {
    expect(alertStatus([])).toBe('todo');
    expect(alertStatus([{ kind: 'price', status: 'cancelled' }])).toBe('todo');
    expect(alertStatus([{ kind: 'funding', status: 'active' }])).toBe('todo');
    expect(alertStatus([{ kind: 'price', status: 'active' }])).toBe('done');
    expect(alertStatus([{ kind: 'price', status: 'fired' }])).toBe('done');
  });

  it('history helpers: money in is a deposit, welcome funds or a received transfer; a trade is a trade row', () => {
    expect(hasMoneyIn([row('deposit')])).toBe(true);
    expect(hasMoneyIn([row('welcome_funds')])).toBe(true);
    expect(hasMoneyIn([row('transfer_in')])).toBe(true);
    expect(hasMoneyIn([row('transfer_out', 'out'), row('fee', 'out'), row('trade')])).toBe(false);
    expect(hasTrade([row('trade')])).toBe(true);
    expect(hasTrade([row('deposit')])).toBe(false);
  });

  it('add money: holding anything or ever receiving money is done; waiting is "checking", never "done"', () => {
    expect(depositStatus('held', 'loading')).toBe('done');
    expect(depositStatus('none', 'in')).toBe('done');
    expect(depositStatus('loading', 'none')).toBe('checking');
    expect(depositStatus('none', 'loading')).toBe('checking');
    expect(depositStatus('none', 'none')).toBe('todo');
    expect(depositStatus('failed', 'none')).toBe('unknown');
    expect(depositStatus('none', 'failed')).toBe('unknown');
  });

  it('first trade: found is done; older pages left means still looking; the end of the history means not yet', () => {
    expect(tradeStatus({ trade: true, hasMore: true, read: 50 })).toBe('done');
    expect(tradeStatus({ trade: false, hasMore: true, read: 50 })).toBe('checking');
    expect(tradeStatus({ trade: false, hasMore: true, read: 250 })).toBe('todo');
    expect(tradeStatus({ trade: false, hasMore: false, read: 7 })).toBe('todo');
    expect(tradeStatus('empty')).toBe('todo');
    expect(tradeStatus('loading')).toBe('checking');
    expect(tradeStatus('failed')).toBe('unknown');
  });
});

describe('Get started: the list', () => {
  const all = (status: StepStatus): Record<StepId, StepStatus> => ({
    verify: status,
    secure: status,
    deposit: status,
    trade: status,
    alert: status,
  });

  it('has the five steps in order, and Deposit leads to its Preview', () => {
    const steps = buildSteps(all('todo'));
    expect(steps.map((step) => step.id)).toEqual(['verify', 'secure', 'deposit', 'trade', 'alert']);
    expect(steps.find((step) => step.id === 'deposit')!.href).toMatch(/^\/preview\//);
  });

  it('counts only the steps the person can act on; the alert step has no live place yet', () => {
    const steps = buildSteps({ ...all('done'), alert: 'todo' });
    expect(steps.find((step) => step.id === 'alert')!.href).toBeNull();
    expect(progress(steps)).toEqual({ done: 4, total: 4, complete: true, settled: true });
    expect(progress(buildSteps(all('todo')))).toMatchObject({ done: 0, total: 4, complete: false });
  });

  it('is not settled while an answer is on its way, and an unreadable answer is never counted as done', () => {
    expect(progress(buildSteps({ ...all('done'), alert: 'todo', trade: 'checking' }))).toMatchObject({
      done: 3,
      settled: false,
      complete: false,
    });
    expect(progress(buildSteps({ ...all('done'), alert: 'todo', trade: 'unknown' }))).toMatchObject({
      done: 3,
      settled: true,
      complete: false,
    });
  });
});

describe('Get started: hiding the list is remembered', () => {
  const store = () => {
    const map = new Map<string, string>();
    return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) };
  };

  it('remembers per person', () => {
    const storage = store();
    expect(readDismissed('u1', storage)).toBe(false);
    writeDismissed('u1', storage);
    expect(readDismissed('u1', storage)).toBe(true);
    expect(readDismissed('u2', storage)).toBe(false);
    expect(dismissKey('u1')).not.toBe(dismissKey('u2'));
  });

  it('survives storage that throws or is missing: the list simply shows', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readDismissed('u1', broken)).toBe(false);
    expect(() => writeDismissed('u1', broken)).not.toThrow();
    expect(readDismissed('u1', null)).toBe(false);
    expect(readDismissed(null, store())).toBe(false);
  });
});

describe('Home new-user words (plain words)', () => {
  const banned = /unavailable|not connected|restricted|fixture|lifecycle/i;
  const en = homeCopy.forLocale('en');
  it('uses no banned word on the new-user copy', () => {
    for (const key of [
      'No crypto yet',
      'Add money',
      'Watchlist hint',
      'No coins yet',
      'Get started',
      'All set',
      'All set body',
      'Step verify',
      'Step verify hint',
      'Step secure',
      'Step secure hint',
      'Step deposit',
      'Step deposit hint',
      'Step trade',
      'Step trade hint',
      'Step alert',
      'Step alert hint',
      'No activity yet',
      'No activity body',
      'Learn basics body',
      'Learn safety body',
      'Learn charts body',
    ] as const)
      expect(en.t(key), key).not.toMatch(banned);
  });
  it('shows the count as plain words', () => {
    expect(en.t('Steps done', { done: 2, total: 4 })).toBe('2 of 4 done');
  });
});
