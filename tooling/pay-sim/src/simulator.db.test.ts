import { expect, it } from 'vitest';
import { parseOptions } from './safety.js';
import { runSimulation } from './simulator.js';

/** PG-hard: missing PostgreSQL fails this package test; no Docker startup or skip. */
it('drives actual sandbox money paths, recovers faults once, and verifies both books', async () => {
  const result = await runSimulation(parseOptions(['--iterations', '2'], process.env));
  expect(result.label).toBe('TEST DATA — no real money');
  expect(result.iterationsCompleted).toBe(2);
  expect(result.merchants.map((m) => m.archetype)).toEqual(['PSP', 'broker', 'gaming']);
  expect(result.merchants.every((m) => m.label.includes('TEST DATA'))).toBe(true);
  expect(result.payments).toBe(6);
  expect(result.outboundTransfers).toBe(12);
  expect(result.faults).toEqual({ railDown: 18, duplicateEvents: 12, duplicateRefunds: 6, duplicatePayouts: 6, databaseAfterSend: 6 });
  expect(result.checks).toEqual({
    ledgerPerAsset: 'verified',
    ledgerChain: 'verified',
    metricsIndependent: 'verified',
    metricsRebuild: 'verified',
    outboundExactlyOnce: 'verified',
  });
  expect(result.notBuilt.map((f) => f.id)).toEqual(['W1', 'W5', 'W6', 'W9']);
}, 120_000);

it('a deadline failure stops without reporting a successful simulation', async () => {
  await expect(runSimulation(parseOptions(['--timeout-ms', '1'], process.env))).rejects.toThrow(/deadline/);
});
