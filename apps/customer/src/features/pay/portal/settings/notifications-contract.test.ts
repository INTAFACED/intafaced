import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { notificationKinds, page, preferenceChangeSchema, preferenceSchema } from '../schemas';

/**
 * `/pay/settings/notifications` once showed "We could not check this" on a real service: svc-pay lists eleven kinds,
 * the portal only knew ten, and one unknown kind fails the whole list. This runs the service's own
 * `NotificationService.preferences` (with a stored row for two kinds) and parses what it returns with the portal's schema.
 */
const source = fileURLToPath(new URL('../../../../../../../services/svc-pay/src/merchant-ops/notifications.ts', import.meta.url));

type Service = {
  NOTIFICATION_KINDS: readonly string[];
  NotificationService: new (sql: unknown) => {
    preferences(caller: unknown): Promise<unknown>;
    preferenceHistory(caller: unknown, input: { limit: number }): Promise<unknown>;
  };
};

describe.skipIf(!existsSync(source))('notification kinds and preferences match services/svc-pay/src/merchant-ops/notifications.ts', () => {
  it('knows exactly the kinds the service lists', async () => {
    const real = (await import(/* @vite-ignore */ source)) as Service;
    expect([...notificationKinds].sort()).toEqual([...real.NOTIFICATION_KINDS].sort());
  }, 30_000);

  it('parses every row the service answers for the preferences list', async () => {
    const real = (await import(/* @vite-ignore */ source)) as Service;
    const stored = [
      { kind: 'limit_threshold', in_app: true, threshold: '5000.50', updated_by: 'u', updated_at: new Date('2026-10-17T10:00:00.000Z') },
      { kind: 'payout_destination', in_app: false, threshold: null, updated_by: 'u2', updated_at: new Date('2026-10-17T11:00:00.000Z') },
    ];
    // The service uses `sql` as a tagged template and only reads the stored rows.
    const sql = async () => stored;
    const caller = { merchantId: 'm', userId: 'u', role: 'owner', viaApiKey: false, interactive: true };
    const answer = await new real.NotificationService(sql).preferences(caller);
    const parsed = z.array(preferenceSchema).safeParse(JSON.parse(JSON.stringify(answer)));
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
    expect(parsed.success && parsed.data.map((p) => p.kind).sort()).toEqual([...real.NOTIFICATION_KINDS].sort());
    expect(parsed.success && parsed.data.find((p) => p.kind === 'payout_destination')).toMatchObject({
      inApp: false,
      threshold: null,
      updatedBy: 'u2',
    });
    expect(parsed.success && parsed.data.find((p) => p.kind === 'export_ready')).toMatchObject({
      inApp: true,
      updatedBy: null,
      updatedAt: null,
    });
  }, 30_000);

  it("parses a page of the service's preference change history", async () => {
    const real = (await import(/* @vite-ignore */ source)) as Service;
    const stored = [
      {
        seq_text: '7',
        kind: 'limit_threshold',
        in_app: true,
        threshold: '90',
        actor_id: 'u',
        created_at: new Date('2026-10-17T10:00:00.000Z'),
      },
      {
        seq_text: '6',
        kind: 'export_ready',
        in_app: false,
        threshold: null,
        actor_id: 'u2',
        created_at: new Date('2026-10-17T09:00:00.000Z'),
      },
    ];
    const sql = async () => stored;
    const caller = { merchantId: 'm', userId: 'u', role: 'viewer', viaApiKey: false, interactive: true };
    const answer = await new real.NotificationService(sql).preferenceHistory(caller, { limit: 1 });
    const parsed = page(preferenceChangeSchema).safeParse(JSON.parse(JSON.stringify(answer)));
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
    expect(parsed.success && parsed.data.items).toEqual([
      { seq: '7', kind: 'limit_threshold', inApp: true, threshold: '90', actorId: 'u', createdAt: '2026-10-17T10:00:00.000Z' },
    ]);
    expect(parsed.success && parsed.data.nextCursor).not.toBeNull();
  }, 30_000);
});
