/**
 * Unit card — consolidated trade.algo policy honesty door
 * 1. Promise: TWAP product path, jobs default OFF, cancel_incomplete park, VWAP/POV immature refuse
 * 2. Break: describeAlgoPolicy omits capability or cancel / volume immature law
 * 3. Done bar: router mounts algo.policy → trade.algoPolicy(), with the service's own flags
 * 4. Class N
 * 5. Paths: svc-trade/src/algo/algo-policy.ts, router.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { TradeService } from '../controls/test-admission.js';
import { createTradeRouter } from '../router.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks } from '../spot/testing.js';
import { presentAlgoCapabilityNote } from './algo-capability.js';
import {
  ALGO_CANCEL_INCOMPLETE_CODE,
  ALGO_CANCEL_INCOMPLETE_HALT,
  ALGO_IMMATURE_KINDS,
  ALGO_PRODUCT_KIND,
  ALGO_VOLUME_IMMATURE_CODE,
  describeAlgoPolicy,
} from './algo-policy.js';

const here = dirname(fileURLToPath(import.meta.url));
const routerSource = readFileSync(join(here, '..', 'router.ts'), 'utf8');

describe('describeAlgoPolicy — trade.algo honesty door', () => {
  it('states TWAP schedule law with jobs default OFF and cancel_incomplete park', () => {
    const policy = describeAlgoPolicy();
    expect(policy.productKind).toBe(ALGO_PRODUCT_KIND);
    expect(policy.capability).toEqual(presentAlgoCapabilityNote({}));
    expect(policy.capability.jobsDefault).toBe(false);
    expect(policy.capability.jobsEnabled).toBe(false);
    expect(policy.capability.createEnabled).toBe(true);
    expect(policy.capability.icebergs).toBe('out');
    expect(policy.parentHoldsNoBalance).toBe(true);
    expect(policy.progressFromChildFillsOnly).toBe(true);
    expect(policy.cancelIncompleteHalt).toBe(ALGO_CANCEL_INCOMPLETE_HALT);
    expect(policy.cancelIncompleteCode).toBe(ALGO_CANCEL_INCOMPLETE_CODE);
    expect(policy.resumeRefusedOnCancelIncomplete).toBe(true);
    expect(policy.vwapPovImmatureRefused).toBe(true);
    expect(policy.volumeImmatureCode).toBe(ALGO_VOLUME_IMMATURE_CODE);
    expect(policy.immatureKinds).toEqual(ALGO_IMMATURE_KINDS);
    expect(policy.inventsParentFill).toBe(false);
    expect(policy.inventsVwapCurve).toBe(false);
    expect(policy.inventsPovVolume).toBe(false);
    expect(policy.moneyViaLedgerClientOnly).toBe(true);
    expect(JSON.stringify(policy)).not.toMatch(/filledQty|avgPrice|holdAmount|pnl/);
  });

  it('reflects explicit capability flags when provided', () => {
    const policy = describeAlgoPolicy({ createEnabled: false, jobsEnabled: true });
    expect(policy.capability.createEnabled).toBe(false);
    expect(policy.capability.jobsEnabled).toBe(true);
    expect(policy.capability.jobsDefault).toBe(false);
  });
});

describe('algo.policy route (trade.algo honesty door)', () => {
  const sql = {} as Sql;
  const service = (options: { algoEnabled?: boolean; algoJobsEnabled?: boolean }) =>
    new TradeService(sql, new MemoryLedger(), new StubMatching(), new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      ...options,
    });
  const policyOf = (trade: TradeService) =>
    createTradeRouter(trade)
      .createCaller({ principal: null } as never)
      .algo.policy();

  it('router mounts the service policy on algo.policy', () => {
    expect(routerSource).toMatch(/policy:\s*publicProcedure\.query\(\(\)\s*=>\s*trade\.algoPolicy\(\)\)/);
  });

  it('reports the scheduler the service was started with, not the shipped default', async () => {
    const on = await policyOf(service({ algoJobsEnabled: true }));
    expect(on.capability.jobsEnabled).toBe(true);
    expect(on.capability.jobsDefault).toBe(false);
    const off = await policyOf(service({}));
    expect(off.capability.jobsEnabled).toBe(false);
    expect(off.capability.createEnabled).toBe(true);
    const killed = await policyOf(service({ algoEnabled: false, algoJobsEnabled: true }));
    expect(killed.capability.createEnabled).toBe(false);
    expect(killed.capability.jobsEnabled).toBe(true);
  });
});
