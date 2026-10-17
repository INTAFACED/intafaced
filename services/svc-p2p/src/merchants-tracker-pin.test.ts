/**
 * p2p.merchants Done-bar: Stage 1 membership, Stage 2 ceilings (unset = unlimited),
 * honest limit API, reputation merchant badge, no second API-key plane.
 * Ceiling magnitudes stay owner env; Stage 3 keys stay cut (identity.apikeys).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname);

function read(name: string): string {
  return readFileSync(resolve(ROOT, name), 'utf8');
}

describe('p2p.merchants product pin', () => {
  it('mounts membership + honest ceiling doors', () => {
    const router = read('router.ts');
    expect(router).toMatch(/merchants:\s*router\(/);
    expect(router).toMatch(/submitApplication:\s*merchantApiProcedure\('p2p:write'/);
    expect(router).toMatch(/offerLimits:\s*merchantApiProcedure\('p2p:read'/);
    expect(router).toMatch(/myOfferCeiling:\s*merchantApiProcedure\('p2p:read'/);
    expect(router).toMatch(/apiAccess:\s*scopedProcedure\('p2p:read'/);
    expect(router).toMatch(/merchant:\s*z\.boolean\(\)\.nullable\(\)/);
    expect(router).toMatch(/keyPlane:\s*'identity'/);
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
