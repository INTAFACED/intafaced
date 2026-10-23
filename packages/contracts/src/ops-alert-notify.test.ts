import { describe, expect, it } from 'vitest';
import { opsAlertContactSaveSchema, opsAlertRouteSaveSchema, opsAlertRouteTreeSchema } from './ops-alert-notify.js';

describe('ops alert notify shapes', () => {
  it('leaves the default contact and the group wait optional', () => {
    expect(opsAlertRouteSaveSchema.safeParse({ idempotencyKey: 'route-key-01', reason: 'set the tree' }).success).toBe(true);
    expect(opsAlertRouteSaveSchema.safeParse({ idempotencyKey: 'route-key-01', reason: 'zero', groupWaitSeconds: 0 }).success).toBe(true);
  });

  it('does not accept a route tree with no default contact', () => {
    expect(
      opsAlertRouteTreeSchema.safeParse({
        version: 1,
        defaultContactId: '',
        timing: { groupBy: null, groupWaitSeconds: null, groupIntervalSeconds: null, repeatSeconds: null },
        policies: [],
        actor: 'op',
        reason: 'saved',
        updatedAt: '2026-10-23T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('keeps a secret field optional on the way in', () => {
    expect(
      opsAlertContactSaveSchema.safeParse({
        idempotencyKey: 'contact-key-1',
        reason: 'add',
        integrations: [{ kind: 'email', address: 'ops@example.com' }],
      }).success,
    ).toBe(true);
  });
});
