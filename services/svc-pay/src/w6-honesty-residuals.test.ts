import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { payServiceSource } from './payment-service/source.testkit.js';

/**
 * Wave 6 honesty pins — promises that are true-as-gap, not true-as-product.
 * Each test fails when someone "quietly" wires or invents the missing half.
 */

const here = dirname(fileURLToPath(import.meta.url));
const paymentServiceClass = readFileSync(join(here, 'payment-service.ts'), 'utf8');
const webhooks = readFileSync(join(here, 'payment-service', 'webhooks.ts'), 'utf8');
const paymentService = payServiceSource();
const railAdapter = readFileSync(join(here, 'rails/rail-adapter.ts'), 'utf8');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('W6 honesty residuals', () => {
  it('assertMerchantActive wires Layer B KYB money gate (D26-P1-P10) without inventing grants', () => {
    // Live acquiring must require approved KYB via merchantKybMoneyGateRefusal.
    // Pin the call so a silent remove is deliberate — Layer A grant issuance
    // stays refuse-closed in @intafaced/auth (never auto-grant here).
    const m = paymentServiceClass.match(/private assertMerchantActive\([^)]*\)[^{]*\{([\s\S]*?)\n  \}/);
    expect(m, 'assertMerchantActive missing').toBeTruthy();
    const captured = m?.[1];
    expect(captured, 'assertMerchantActive body missing').toEqual(expect.any(String));
    const body = stripComments(captured as string);
    expect(body).toMatch(/merchant\.status/);
    expect(body).toMatch(/merchantKybMoneyGateRefusal/);
    expect(body).toMatch(/kybStatus/);
    expect(paymentService).not.toMatch(/issueMerchantPayScopes|assertMerchantPayScopeGrantAllowed/);
  });

  it('applyWebhook dispute.opened posts via openChargeback or named refuse; voided still absent', () => {
    expect(railAdapter).toMatch(/dispute\.|'voided'|\"voided\"/);
    const apply = webhooks.match(/export async function applyWebhook\([\s\S]*?\n\}/);
    expect(apply, 'applyWebhook missing').toBeTruthy();
    const applySrc = apply?.[0];
    expect(applySrc, 'applyWebhook source missing').toEqual(expect.any(String));
    const body = stripComments(applySrc as string);
    expect(body).toMatch(/case\s+['\"]dispute\.opened['\"]/);
    expect(body).toMatch(/postChargebackOpenOrRefuse/);
    expect(body).toMatch(/bookDisputeResolution/);
    expect(body).not.toMatch(/case\s+['\"]voided['\"]/);
    expect(body).toMatch(/case\s+['\"]refunded['\"]/);
  });

  it('payment-service posts won and shortfall through chargeback-ledger, not inline recipes', () => {
    const body = stripComments(paymentService);
    expect(body).not.toMatch(/recipes\.chargeback/);
    expect(body).toMatch(/postDisputeOpening/);
    expect(body).toMatch(/postDisputeWon/);
    expect(body).toMatch(/postDisputeShortfall/);
    expect(body).toMatch(/postDisputeShortfallRecovered/);
  });
});
