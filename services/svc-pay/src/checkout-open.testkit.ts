import type { Sql } from 'postgres';
import { MemoryLedger } from '@intafaced/ledger-client';
import { PayService, type PayServiceOptions } from './payment-service.js';
import { MemoryChain } from './rails/chain-port.js';
import { CryptoNativeAdapter } from './rails/crypto-native.js';
import { RailRegistry } from './rails/registry.js';
import { REFERENCE_RAIL_ROUTING_PROFILES } from './routing/decide.js';
import { scriptedSql, type SqlCall } from './scripted-sql.testkit.js';

/**
 * A hosted checkout opened on a scripted database: one active TEST link of 10 USDT on one active merchant, no session
 * open on it unless `openSessions` says so; `merchant` changes the merchant row. For unit tests of what `openCheckoutSession` refuses with a setting the owner has not published, and
 * what it writes when it is published. `calls` is every query the open sent, in order.
 */
export const CHECKOUT_MERCHANT = '11111111-1111-4111-8111-111111111111';
export const CHECKOUT_LINK = '22222222-2222-4222-8222-222222222222';
export const CHECKOUT_PAYMENT = '33333333-3333-4333-8333-333333333333';

export function scriptedCheckout(
  options: PayServiceOptions,
  script: { openSessions?: number; merchant?: Record<string, unknown> } = {},
): { pay: PayService; calls: SqlCall[] } {
  const merchantRow = {
    id: CHECKOUT_MERCHANT,
    user_id: 'merchant-user',
    mode: 'gateway',
    tier: 1,
    kyb_status: 'approved',
    kyb_ref: null,
    status: 'active',
    pricing: { feeBps: 100 },
    settlement_prefs: {},
    ...script.merchant,
  };
  const linkRow = {
    id: CHECKOUT_LINK,
    merchant_id: CHECKOUT_MERCHANT,
    profile_id: null,
    label: 'TEST link',
    amount: '10',
    currency: 'USDT',
    active: true,
    expires_at: new Date(Date.now() + 24 * 3600_000),
    max_uses: null,
    uses: 0,
    checkout_config: null,
    inactive_message: null,
  };
  const paymentRow = {
    id: CHECKOUT_PAYMENT,
    merchant_id: CHECKOUT_MERCHANT,
    profile_id: null,
    amount: '10',
    currency: 'USDT',
    method: 'crypto',
    rail_adapter: 'crypto-native',
    rail_ref: null,
    status: 'created',
    created_at: new Date(),
    custody: 'platform',
  };
  const { sql, calls } = scriptedSql<Sql>((call) => {
    if (call.text.includes('FROM pay.payment_links l') && call.text.includes('l.inactive_message')) return [linkRow];
    if (call.text.includes('FROM pay.merchants')) return [merchantRow];
    if (call.text.includes('COUNT(*)::text AS n FROM pay.checkout_sessions')) return [{ n: String(script.openSessions ?? 0) }];
    if (call.text.includes('INSERT INTO pay.payments')) return [paymentRow];
    return [];
  });
  const chain = new MemoryChain();
  const rails = new RailRegistry([
    new CryptoNativeAdapter({ chain, secret: 'scripted-checkout-secret-at-least-32-chars', minConfirmations: 6, toleranceSeconds: 300 }),
  ]);
  const pay = new PayService(sql, new MemoryLedger(), rails, {
    checkoutRiskBand: 'low',
    routingProfiles: REFERENCE_RAIL_ROUTING_PROFILES.map((p) => (p.railId === 'crypto-native' ? { ...p, successRate: '0.90' } : { ...p })),
    ...options,
  });
  return { pay, calls };
}

/** Whether the open wrote a checkout session row. */
export function wroteSession(calls: readonly SqlCall[]): boolean {
  return calls.some((c) => c.text.includes('INSERT INTO pay.checkout_sessions'));
}

/** Whether the open wrote a payment row. */
export function wrotePayment(calls: readonly SqlCall[]): boolean {
  return calls.some((c) => c.text.includes('INSERT INTO pay.payments'));
}
