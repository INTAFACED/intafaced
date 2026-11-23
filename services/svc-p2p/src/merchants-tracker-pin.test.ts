/**
 * p2p.merchants Done-bar: Stage 1 membership, Stage 2 ceilings (unset = unlimited),
 * honest limit API, reputation merchant badge, no second API-key plane.
 * Ceiling magnitudes stay owner env; Stage 3 keys stay cut (identity.apikeys).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  P2P_MERCHANTS_API_ACCESS,
  P2P_MERCHANTS_MY_OFFER_CEILING,
  P2P_MERCHANTS_OFFER_LIMITS,
  P2P_MERCHANTS_SUBMIT_APPLICATION,
  P2P_PROCEDURES,
  P2P_REPUTATION_GET,
} from '@intafaced/contracts/p2p-procedures';

const ROOT = resolve(import.meta.dirname);

function read(name: string): string {
  return readFileSync(resolve(ROOT, name), 'utf8');
}

describe('p2p.merchants product pin', () => {
  it('mounts membership + honest ceiling doors', () => {
    // The doors are records now: their guard and reply are the record's, mounted by `mountRecords`.
    expect(P2P_MERCHANTS_SUBMIT_APPLICATION.access).toMatchObject({ caller: 'scope', scope: 'p2p:write' });
    expect(P2P_MERCHANTS_OFFER_LIMITS.access).toMatchObject({ caller: 'scope', scope: 'p2p:read' });
    expect(P2P_MERCHANTS_MY_OFFER_CEILING.access).toMatchObject({ caller: 'scope', scope: 'p2p:read' });
    expect(P2P_MERCHANTS_API_ACCESS.access).toMatchObject({ caller: 'scope', scope: 'p2p:read' });
    expect(P2P_MERCHANTS_API_ACCESS.output.shape.keyPlane.safeParse('identity').success).toBe(true);
    expect(P2P_MERCHANTS_API_ACCESS.output.shape.keyPlane.safeParse('svc-p2p').success).toBe(false);
    for (const record of [
      P2P_MERCHANTS_SUBMIT_APPLICATION,
      P2P_MERCHANTS_OFFER_LIMITS,
      P2P_MERCHANTS_MY_OFFER_CEILING,
      P2P_MERCHANTS_API_ACCESS,
    ])
      expect(P2P_PROCEDURES).toContain(record);
  });

  it('the reputation card carries the merchant badge as approved, not, or programme off', () => {
    const merchant = P2P_REPUTATION_GET.output.shape.merchant;
    for (const value of [true, false, null]) expect(merchant.safeParse(value).success).toBe(true);
    expect(merchant.safeParse(undefined).success).toBe(false);
    expect(merchant.safeParse('approved').success).toBe(false);
  });

  it('wires the programme into the live router (not a stub)', () => {
    const boot = read('index.ts');
    expect(boot).toMatch(/new MerchantService\(/);
    expect(boot).toMatch(/approvals:\s*actionApprovals/);
    expect(boot).toMatch(/createP2pRouter\(/);
    expect(boot).toMatch(/moderatorUserIds,\s*offerLimits,\s*blockRfq,\s*approvals:\s*actionApprovals/);
    expect(boot).toMatch(/offerLimitsConfigured:\s*limitsConfigured\(offerLimits\)/);
    expect(boot).toMatch(/offerLimitsFromEnv\(env\)/);
  });

  it('treats unset P2P_OFFER_MAX_* as unlimited, never a baked magnitude', () => {
    const limits = read('merchant-limits.ts');
    expect(limits).toMatch(/offerLimitsFromEnv/);
    expect(limits).toMatch(/P2P_OFFER_MAX_STANDARD/);
    expect(limits).toMatch(/P2P_OFFER_MAX_MERCHANT/);
    expect(limits).not.toMatch(/parseAmount\('\d+'/);
    expect(read('env.ts')).not.toMatch(/P2P_OFFER_MAX_(?:STANDARD|MERCHANT).*(?:\?\?|\.default\()/);
  });

  it('names identity.apikeys as the only key plane', () => {
    const programme = read('merchant-programme.ts');
    expect(programme).toMatch(/MERCHANT_API_KEY_PLANE = 'identity\.apikeys'/);
    expect(programme).not.toMatch(/p2p_merchant_api_keys/i);
    expect(programme).not.toMatch(/function mintMerchantApiKey/);
  });
});
