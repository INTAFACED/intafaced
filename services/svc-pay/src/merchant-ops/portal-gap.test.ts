import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { ActivityFeed, projectActivityDetail } from './activity.js';
import { scriptedSql } from '../scripted-sql.testkit.js';
import { resolveExportColumns } from './exports.js';
import { payoutReference } from './payouts.js';
import { loadWebhookRetryLimit } from './webhooks.js';

const ADDRESS = '0x000000000000000000000000000000000000dEaD';

describe('merchant portal redaction', () => {
  it('masks a payout destination and drops free text', () => {
    const detail = projectActivityDetail(
      { amount: '10.5', asset: 'USDT', note: 'INTERNAL: keep this', rule_id: 'rule-1' },
      { kind: 'crypto', ref: ADDRESS },
    );
    expect(detail.amount).toBe('10.5');
    expect(detail.asset).toBe('USDT');
    expect(detail.destinationMasked).not.toBe(ADDRESS);
    expect(detail.destinationMasked!.length).toBeLessThanOrEqual(16);
    expect(JSON.stringify(detail)).not.toContain(ADDRESS);
    expect(detail).not.toHaveProperty('note');
    expect(detail).not.toHaveProperty('rule_id');
  });

  it('masks a 20-byte account reference and leaves a longer rail reference', () => {
    expect(payoutReference(ADDRESS)).not.toBe(ADDRESS);
    expect(payoutReference('0x' + 'ab'.repeat(32))).toBe('0x' + 'ab'.repeat(32));
    expect(payoutReference(null)).toBeNull();
  });

  it('refuses a fee column a viewer or developer must not see, and keeps the booked fee', () => {
    expect(resolveExportColumns('fees', 'developer', undefined)).toEqual(['subject_kind', 'subject_id', 'asset', 'fee', 'recorded_at']);
    expect(resolveExportColumns('fees', 'owner', undefined)).toContain('fee_bps');
    expect(() => resolveExportColumns('fees', 'developer', ['fee', 'fee_bps'])).toThrow(/pay\.export_columns_forbidden/);
    expect(() => resolveExportColumns('fees', 'owner', ['rule_id'])).toThrow(/pay\.export_columns_forbidden/);
    expect(() => resolveExportColumns('payments', 'owner', ['risk_score'])).toThrow(/pay\.export_columns_forbidden/);
  });

  it('bounds every activity source and hides an operator id behind the pay scope', async () => {
    // What the feed asks the database: each of its ten sources stops at one page (limit + 1), and so does the merge.
    // Which rows that returns, and that an operator's KYB decision shows as 'intafaced', is portal-gap.db.test.ts
    // ("activity is merchant-scoped, paged, and hides founder text and full destinations").
    const caller = { merchantId: 'm-1', userId: 'u-1', role: 'owner', viaApiKey: false, interactive: true } as const;
    const { sql, calls } = scriptedSql<Sql>();
    await new ActivityFeed(sql).list(caller, { limit: 7 });
    const paged = calls.filter((c) => /LIMIT \$\?\s*$/.test(c.text));
    expect(paged).toHaveLength(11);
    for (const call of paged) expect(call.values.at(-1)).toBe(8);
    expect(calls.map((c) => c.text)).toContain(`CASE WHEN k.actor_scope LIKE 'pay:%' THEN k.actor_id ELSE 'intafaced' END`);
    // A narrow page shuts every other source inside its own branch.
    const narrow = scriptedSql<Sql>();
    await new ActivityFeed(narrow.sql).list(caller, { limit: 1, objectType: 'kyb' });
    expect(narrow.calls.filter((c) => c.text === 'AND false')).toHaveLength(9);
    // Without a page size it asks nothing.
    const unpaged = scriptedSql<Sql>();
    await expect(new ActivityFeed(unpaged.sql).list(caller, {})).rejects.toBeInstanceOf(Error);
    expect(unpaged.calls).toEqual([]);
  });

  it('leaves webhook retry unconfigured unless both limits are positive integers', () => {
    expect(loadWebhookRetryLimit({})).toBeUndefined();
    expect(loadWebhookRetryLimit({ PAY_WEBHOOK_RETRY_MAX: '3' })).toBeUndefined();
    expect(loadWebhookRetryLimit({ PAY_WEBHOOK_RETRY_WINDOW_MS: '1000' })).toBeUndefined();
    expect(loadWebhookRetryLimit({ PAY_WEBHOOK_RETRY_MAX: '0', PAY_WEBHOOK_RETRY_WINDOW_MS: '1000' })).toBeUndefined();
    expect(loadWebhookRetryLimit({ PAY_WEBHOOK_RETRY_MAX: '2', PAY_WEBHOOK_RETRY_WINDOW_MS: '-1' })).toBeUndefined();
    expect(loadWebhookRetryLimit({ PAY_WEBHOOK_RETRY_MAX: '2', PAY_WEBHOOK_RETRY_WINDOW_MS: '60000' })).toEqual({
      maxPerWindow: 2,
      windowMs: 60_000,
    });
  });
});
