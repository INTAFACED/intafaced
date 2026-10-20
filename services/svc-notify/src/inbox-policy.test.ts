/**
 * Unit card — notify.inboxPolicy reports owner values and never invents one
 *
 * 1. Promise: blank page size / unread cap report null with their typed code;
 *    blank retention keeps every row; set values come back as set.
 * 2. Break: `cap ?? 99` shows a "99+" bell nobody chose.
 * 3. Done bar: unset -> null + code; assertNotifyUnreadCap refuses blank / 0 / NaN.
 * 4. Class N
 * 5. Paths: services/svc-notify/src/inbox-policy.ts, router.ts
 */
import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { createNotifyRouter } from './router.js';
import {
  BLANK_INBOX_SETTINGS,
  NOTIFY_UNREAD_CAP_UNSET,
  NotifyUnreadCapUnsetError,
  assertNotifyUnreadCap,
  describeInboxPolicy,
} from './inbox-policy.js';
import type { NotifyService } from './notify-service.js';

describe('describeInboxPolicy', () => {
  it('reports every blank value as unset and invents none', () => {
    expect(describeInboxPolicy(BLANK_INBOX_SETTINGS)).toEqual({
      pageSize: null,
      pageSizeUnsetCode: 'notify.list_limit_unset',
      unreadCap: null,
      unreadCapUnsetCode: NOTIFY_UNREAD_CAP_UNSET,
      retentionDays: null,
      retention: 'keeps_every_row',
      inventsLimits: false,
    });
  });

  it('serves owner-set values as set', () => {
    expect(describeInboxPolicy({ pageSize: 25, unreadCap: 50, retentionDays: 90 })).toMatchObject({
      pageSize: 25,
      pageSizeUnsetCode: null,
      unreadCap: 50,
      unreadCapUnsetCode: null,
      retentionDays: 90,
      retention: 'days',
    });
  });

  it('treats 0, negatives and NaN as unset', () => {
    expect(describeInboxPolicy({ pageSize: 0, unreadCap: -1, retentionDays: Number.NaN })).toMatchObject({
      pageSize: null,
      unreadCap: null,
      retentionDays: null,
    });
  });
});

describe('assertNotifyUnreadCap', () => {
  it.each([null, undefined, 0, -3, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s with notify.unread_cap_unset', (blank) => {
    expect(() => assertNotifyUnreadCap(blank)).toThrow(NotifyUnreadCapUnsetError);
  });

  it('returns an owner-set cap', () => {
    expect(assertNotifyUnreadCap(99)).toBe(99);
  });
});

describe('notify.inboxPolicy door', () => {
  const edgeContext = createEdgeContext({ secret: 'a-notify-policy-test-edge-secret-long', serviceName: 'svc-notify' });
  const anonymous = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

  it('is public and reflects the settings the router was built with', async () => {
    const blank = await createNotifyRouter({ fanoutEnabled: true } as NotifyService)
      .createCaller(anonymous)
      .notify.inboxPolicy();
    expect(blank.unreadCapUnsetCode).toBe('notify.unread_cap_unset');
    const set = await createNotifyRouter({ fanoutEnabled: true } as NotifyService, undefined, undefined, undefined, {
      pageSize: 30,
      unreadCap: 99,
      retentionDays: null,
    })
      .createCaller(anonymous)
      .notify.inboxPolicy();
    expect(set).toMatchObject({ pageSize: 30, unreadCap: 99, retention: 'keeps_every_row' });
  });
});
