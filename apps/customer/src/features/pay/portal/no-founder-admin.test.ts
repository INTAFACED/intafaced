import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * G9: the merchant portal never reaches an operator procedure. `founderAdmin.*` is the founders-only namespace
 * in svc-pay; a merchant page that named it would be one typo from calling an operator door with a merchant
 * session. The name is assembled here so this file does not match itself.
 */
const banned = new RegExp(['founder', 'Admin'].join(''), 'i');
const root = fileURLToPath(new URL('../../..', import.meta.url)); // apps/customer/src

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sources(full);
    return /\.(ts|tsx|css|mjs|html)$/.test(name) && !/\.(test|pw)\.|\.fixtures\./.test(name) ? [full] : [];
  });
}

describe('no founder or operator door in the merchant portal (G9)', () => {
  it('names no founder-only procedure anywhere in the pay feature', () => {
    const offenders = sources(join(root, 'features', 'pay')).filter((file) => banned.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('calls only merchant-scoped namespaces from the portal', () => {
    // The client is the core plus one file per package (api.ts, api-core.ts, money/api.ts, payments/api.ts, settings/api.ts).
    const portal = sources(join(root, 'features', 'pay', 'portal')).filter((file) => /[\\/](api|api-core)\.ts$/.test(file));
    expect(portal.length).toBe(5);
    const text = portal.map((file) => readFileSync(file, 'utf8')).join('\n');
    const procedures = [
      ...text.matchAll(
        /'((?:(?:merchant|merchantOps|merchantMetrics|merchantControl|merchantAnalytics|submerchant|submerchantPermission|payHalts|payment|settlement|conversion)\.[A-Za-z.]+|railHealth))'/g,
      ),
    ].map((m) => m[1]!);
    expect(procedures.length).toBeGreaterThan(20);
    for (const name of procedures)
      expect(name, name).toMatch(
        new RegExp(
          [
            '^(merchantOps\\.|merchantMetrics\\.|merchantAnalytics\\.|submerchant(Permission)?\\.|merchant\\.(me|myAccess|create|submitKyb|setPayoutDestination|listLinks|payoutDestinations\\.list|statement\\.list|businessProfile\\.[A-Za-z]+|onboarding\\.progress)$|railHealth$',
            // W3b: the merchant's own reads, and the three maker-checker calls. The operator side of these namespaces is not named here.
            'payment\\.(list|get|history|refunds\\.(list|get))$',
            'settlement\\.(list|get|lines|lifecycle|payout)$',
            'payHalts\\.status$',
            // Merchant-scoped on main (svc-pay checks a `pay:*` scope, never a founder role): history, tiers, limits, payout request.
            'merchantControl\\.(get|usage|pricing\\.(preview|history)|tiers\\.list|limits\\.(open|requestIncrease|withdraw)|approvals\\.(list|request|decide|cancel))$',
            'conversion\\.(quote|execute|get|list)$)',
          ].join('|'),
        ),
      );
    expect(text).not.toMatch(/admin:|operator|killswitch/i);
  });
  it('keeps the whole customer app free of the founder namespace', () => {
    const offenders = sources(root).filter((file) => banned.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
