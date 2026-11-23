/**
 * Unit card — consolidated trade.options policy honesty door
 * 1. Promise: default refuse, constants from options-listing, no invented assets
 * 2. Break: describeOptionsPolicy omits socket or refuse codes
 * 3. Done bar: options.policy answers describeOptionsPolicy()
 * 4. Class N
 * 5. Paths: svc-trade/src/spot/options-policy.ts, router.ts
 */

import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { TradeService } from '../controls/test-admission.js';
import { createTradeRouter } from '../router.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks } from './testing.js';
import {
  OPTIONS_FIXING_UNCONFIGURED,
  OPTIONS_SETTLEMENT_LAW_UNSET,
  OPTIONS_SETTLEMENT_RESIDUAL,
  OPTIONS_SETTLEMENT_SOCKET,
  OPTIONS_TERMS_INCOMPLETE,
  describeOptionsPolicy,
} from './options-policy.js';

describe('describeOptionsPolicy — trade.options honesty door', () => {
  it('states settlement law gate without inventing assets', () => {
    const policy = describeOptionsPolicy();
    expect(policy.socket).toBe(OPTIONS_SETTLEMENT_SOCKET);
    expect(policy.settlementLawUnsetCode).toBe(OPTIONS_SETTLEMENT_LAW_UNSET);
    expect(policy.fixingUnconfiguredCode).toBe(OPTIONS_FIXING_UNCONFIGURED);
    expect(policy.termsIncompleteCode).toBe(OPTIONS_TERMS_INCOMPLETE);
    expect(policy.settlementAssetLawStamped).toBe(false);
    expect(policy.settlementFixingConfigured).toBe(false);
    expect(policy.residual).toBe(OPTIONS_SETTLEMENT_RESIDUAL);
    expect(policy.inventsLiveSet).toBe(false);
    expect(policy.inventsSettlementAsset).toBe(false);
    expect(policy.inventsIvSurface).toBe(false);
    expect(policy.ordersStillRefuseUntilEngine).toBe(false);
    expect(policy.paperEngine).toBe(true);
    expect(policy.liveOrdersStillRefuse).toBe(true);
    expect(policy.allowed.optionsOrders).toBe(true);
    expect(policy.allowed.paperOptionsOrders).toBe(true);
    expect(policy.allowed.liveOptionsOrders).toBe(false);
    expect(policy.allowed.optionsListing).toBe(false);
    expect(policy.allowed.nonOptionsListing).toBe(true);
    expect(policy.statusLine).toContain('lawStamped=0');
    expect(JSON.stringify(policy)).not.toMatch(/USDT|USDC|BTC/);
  });

  it('reflects non-empty env stamps without parsing or echoing them', () => {
    const policy = describeOptionsPolicy({
      settlementAssetLawConfigured: 'opaque-owner-stamp',
      settlementFixingConfigured: 'opaque-d7-fixing',
    });
    expect(policy.settlementAssetLawStamped).toBe(true);
    expect(policy.settlementFixingConfigured).toBe(true);
    expect(policy.allowed.optionsListing).toBe(true);
    expect(policy.allowed.optionsOrders).toBe(true);
    expect(policy.allowed.liveOptionsOrders).toBe(false);
    expect(JSON.stringify(policy)).not.toContain('opaque-owner-stamp');
    expect(JSON.stringify(policy)).not.toContain('opaque-d7-fixing');
  });

  it('whitespace-only env counts as unset', () => {
    const policy = describeOptionsPolicy({ settlementAssetLawConfigured: '   ', settlementFixingConfigured: '\t' });
    expect(policy.settlementAssetLawStamped).toBe(false);
    expect(policy.settlementFixingConfigured).toBe(false);
    expect(policy.allowed.optionsListing).toBe(false);
  });
});

describe('options.policy route (trade.options honesty door)', () => {
  it('router mounts describeOptionsPolicy on options.policy', async () => {
    const trade = new TradeService({} as Sql, new MemoryLedger(), new StubMatching(), new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
    });
    const answer = await createTradeRouter(trade)
      .createCaller({ principal: null } as never)
      .options.policy();
    // Byte for byte: the answer is describeOptionsPolicy() itself, key order included.
    expect(JSON.stringify(answer)).toBe(JSON.stringify(describeOptionsPolicy()));
  });
});
