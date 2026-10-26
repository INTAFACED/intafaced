import { describe, expect, it } from 'vitest';
import { homeCopy } from './copy';
import {
  alertStatus,
  buildSteps,
  depositStatus,
  dismissKey,
  lastOpenKey,
  progress,
  readDismissed,
  readLastOpen,
  securityStatus,
  tradeStatus,
  verificationStatus,
  writeDismissed,
  writeLastOpen,
  type StepId,
  type StepStatus,
} from './started';

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

  it('add money: holding anything or ever receiving money is done; waiting is "checking", never "done"', () => {
    expect(depositStatus('held', 'loading')).toBe('done');
    expect(depositStatus('none', 'found')).toBe('done');
    expect(depositStatus('loading', 'none')).toBe('checking');
    expect(depositStatus('none', 'loading')).toBe('checking');
    expect(depositStatus('none', 'none')).toBe('todo');
    expect(depositStatus('failed', 'none')).toBe('unknown');
    expect(depositStatus('none', 'failed')).toBe('unknown');
  });

  it('first trade: one trade line anywhere in the history is done; none is not yet; unread is never done', () => {
    expect(tradeStatus('found')).toBe('done');
    expect(tradeStatus('none')).toBe('todo');
    expect(tradeStatus('loading')).toBe('checking');
    expect(tradeStatus('failed')).toBe('unknown');
  });
});

describe('Get started: the list', () => {
  const all = (status: StepStatus): Record<StepId, StepStatus> => ({
    register: status,
    verify: status,
    secure: status,
    deposit: status,
    trade: status,
    alert: status,
  });

  it('has the six steps in order, each leading to a live screen', () => {
    const steps = buildSteps(all('todo'));
    expect(steps.map((step) => step.id)).toEqual(['register', 'verify', 'secure', 'deposit', 'trade', 'alert']);
    expect(steps.map((step) => step.href)).toEqual([
      '/uc/account',
      '/verification',
      '/uc/safe',
      '/uc/recharge',
      '/trade/buy',
      '/notifications?view=alerts',
    ]);
    expect(steps.some((step) => step.href.startsWith('/preview'))).toBe(false);
  });

  it('counts all six steps, and is complete only when every one is done', () => {
    expect(progress(buildSteps(all('done')))).toEqual({ done: 6, total: 6, complete: true, settled: true });
    expect(progress(buildSteps({ ...all('done'), alert: 'todo' }))).toMatchObject({ done: 5, total: 6, complete: false });
    expect(progress(buildSteps(all('todo')))).toMatchObject({ done: 0, total: 6, complete: false });
  });

  it('is not settled while an answer is on its way, and an unreadable answer is never counted as done', () => {
    expect(progress(buildSteps({ ...all('done'), trade: 'checking' }))).toMatchObject({
      done: 5,
      settled: false,
      complete: false,
    });
    expect(progress(buildSteps({ ...all('done'), trade: 'unknown' }))).toMatchObject({
      done: 5,
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

describe('Get started: whether the list was open last time (a first-paint hint)', () => {
  const store = () => {
    const map = new Map<string, string>();
    return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) };
  };

  it('is open until a visit has read every step, then follows that visit, per person', () => {
    const storage = store();
    expect(readLastOpen('u1', storage)).toBe(true);
    writeLastOpen('u1', false, storage);
    expect(readLastOpen('u1', storage)).toBe(false);
    expect(readLastOpen('u2', storage)).toBe(true);
    writeLastOpen('u1', true, storage);
    expect(readLastOpen('u1', storage)).toBe(true);
    expect(lastOpenKey('u1')).not.toBe(dismissKey('u1'));
  });

  it('survives storage that throws or is missing: the list is drawn while checking', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readLastOpen('u1', broken)).toBe(true);
    expect(() => writeLastOpen('u1', true, broken)).not.toThrow();
    expect(readLastOpen('u1', null)).toBe(true);
    expect(readLastOpen(null, store())).toBe(true);
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
      'Step register',
      'Step register hint',
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

describe('Home copy in Spanish and French', () => {
  it('covers every new-account line and keeps the count placeholders', () => {
    const newKeys = [
      'Add money',
      'Get started',
      'Steps done',
      'Recent activity',
      'No activity body',
      'Learn',
      'Step deposit hint',
    ] as const;
    for (const locale of ['es', 'fr'] as const) {
      const copy = homeCopy.forLocale(locale);
      for (const key of newKeys) expect(copy.languageFor(key), `${locale} ${key}`).toBe(locale);
      expect(copy.t('Steps done', { done: 2, total: 5 })).toMatch(/2.*5/);
      expect(homeCopy.coverage(locale).missing, locale).toEqual([]);
    }
  });
});
