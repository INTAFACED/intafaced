import { describe, expect, it } from 'vitest';
import { bootNotify } from '../testing/boot.js';
import type { NotifyService } from '../notify-service.js';
import { createNotifyRouter } from '../router.js';

/**
 * Topic choices, quiet hours, and summaries are product procedures.
 * Critical still ignores mute, topic choice, and quiet hours.
 *
 * What the gate decides for each choice (a muted topic, a quiet hour, a critical
 * notice) is proven in notify-prefs.acceptance.test.ts and gate tests; here the
 * router mounts the procedures and the booted entrypoint hands the dispatcher the
 * gate over its own Postgres stores.
 */

type Plan = (input: {
  userId: string;
  kind: string;
  notificationId: string;
  channel: 'email';
  severity: 'critical' | 'info';
}) => Promise<string>;

describe('topic and digest preferences are wired', () => {
  it('router exposes the preference, delivery-list, and notice procedures', () => {
    const procedures = Object.keys(createNotifyRouter({ fanoutEnabled: true } as NotifyService)._def.procedures);
    for (const name of [
      'topicPrefs',
      'setTopicPref',
      'digestPrefs',
      'setDigest',
      'recentDeliveries',
      'notices',
      'notice',
      'noticeStatus',
      'draftNotice',
      'publishNotice',
    ]) {
      expect(
        procedures.some((key) => key.split('.').at(-1) === name),
        name,
      ).toBe(true);
    }
  });

  it('dispatch asks the preference gate and skips it for critical', async () => {
    const booted = await bootNotify();
    try {
      const plan = booted.dispatcherOptions.planOutOfApp as Plan;
      expect(typeof plan).toBe('function');
      const base = { userId: 'user-1', kind: 'price_alert', notificationId: 'n-1', channel: 'email' as const };

      // Critical is sent without asking any store: no hold, topic or quiet-hour lookup.
      const before = booted.queries.length;
      expect(await plan({ ...base, severity: 'critical' })).toBe('send');
      expect(booted.queries.length).toBe(before);

      // Anything else asks the gate, which reads the digest holds first.
      await plan({ ...base, severity: 'info' });
      expect(booted.queries.slice(before).some((q) => q.includes('notify.digest_holds'))).toBe(true);
    } finally {
      await booted.close();
    }
  });

  it('index constructs the preference stores and the notice board', async () => {
    const booted = await bootNotify();
    try {
      // Imported after the boot, so the classes are the ones the booted module used.
      const { PostgresHoldStore } = await import('./account.pg.js');
      const { AccountPrefs } = await import('./account.js');
      const { NoticeBoard } = await import('../notices/board.js');
      expect(booted.notifyDeps.holds).toBeInstanceOf(PostgresHoldStore);
      expect(booted.notifyDeps.notices).toBeInstanceOf(NoticeBoard);
      const account = booted.notifyDeps.account;
      expect(account).toBeInstanceOf(AccountPrefs);

      // The account's topic choices come from the Postgres topic store.
      const before = booted.queries.length;
      await (account as InstanceType<typeof AccountPrefs>).topicPrefs('user-1');
      expect(booted.queries.slice(before).some((q) => q.includes('notify.topic_prefs'))).toBe(true);
    } finally {
      await booted.close();
    }
  });
});
