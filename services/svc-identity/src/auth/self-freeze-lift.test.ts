import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { SelfFreezeLift, SelfFreezeLiftError, parseSelfFreezeLiftWait } from './self-freeze-lift.js';

describe('self-freeze lift owner wait', () => {
  it('reads blank as unset, never a default, and zero as a published no-wait', () => {
    expect(parseSelfFreezeLiftWait(undefined)).toBeUndefined();
    expect(parseSelfFreezeLiftWait('  ')).toBeUndefined();
    expect(parseSelfFreezeLiftWait('0')).toBe(0);
    expect(parseSelfFreezeLiftWait('86400')).toBe(86400);
  });

  it('refuses a malformed or oversized wait at boot', () => {
    expect(() => parseSelfFreezeLiftWait('1.5')).toThrow('whole seconds');
    expect(() => parseSelfFreezeLiftWait('-1')).toThrow('whole seconds');
    expect(() => parseSelfFreezeLiftWait(String(31 * 24 * 3600))).toThrow('30 days');
  });

  it('refuses before touching the database while the wait is unset', async () => {
    const sql = vi.fn() as unknown as Sql;
    const lift = new SelfFreezeLift(sql, undefined);
    expect(() => lift.assertConfigured()).toThrow(SelfFreezeLiftError);
    await expect(lift.lift('00000000-0000-4000-8000-000000000001')).rejects.toMatchObject({ code: 'identity.self_freeze_lift_wait_unset' });
    expect(sql).not.toHaveBeenCalled();
  });
});
