import { describe, expect, it } from 'vitest';
import { QUANT_STUDIO_GET } from '@intafaced/contracts/quant-studio-procedures';
import { StrategySourceUnavailable, createQuantStrategySource } from './ports.js';

const version = (n: number, modules: unknown = null) => ({
  version: n,
  createdAt: '2026-11-01T00:00:00.000Z',
  name: `TEST v${n}`,
  language: 'javascript',
  source: 'oms.buy("BTC-USD", "1")',
  cash: '1000',
  blocks: [{ side: 'buy', symbol: 'BTC/USDT', qty: '1' }],
  modules,
  risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
  releaseNote: '',
  environment: 'paper',
  kind: 'paper',
  claimLabel: 'Paper — not live performance',
  live: false,
  simulated: true,
});
const strategy = (approval: { required: boolean; approvedVersions: number[] }) => ({
  ...version(2),
  id: 's-1',
  accountId: '11111111-1111-4111-8111-111111111111',
  clientStrategyId: 'client-1',
  deletedAt: null,
  folder: '',
  description: '',
  organised: 0,
  restores: 0,
  versions: [version(1), version(2)],
  liveApproval: approval,
});

function source(status: number, body: unknown, seen: string[] = []) {
  const fetchFn: typeof globalThis.fetch = async (input) => {
    seen.push(String(input));
    return new Response(JSON.stringify(body), { status });
  };
  return createQuantStrategySource('http://quant.test/', fetchFn);
}

describe("the live runner's read of a strategy version from svc-quant", () => {
  it('asks studio.get by its record, as the person, and reads the version and its approval', async () => {
    const seen: string[] = [];
    const read = await source(200, { result: { data: strategy({ required: true, approvedVersions: [1] }) } }, seen).version(
      { authorization: 'x' },
      's-1',
      2,
    );
    expect(seen).toEqual([`http://quant.test/trpc/${QUANT_STUDIO_GET.path}?input=${encodeURIComponent(JSON.stringify({ id: 's-1' }))}`]);
    expect(read).toEqual({
      name: 'TEST v2',
      version: 2,
      blocks: [{ side: 'buy', symbol: 'BTC/USDT', qty: '1' }],
      signalRules: false,
      approvalRequired: true,
    });
    const approved = await source(200, { result: { data: strategy({ required: true, approvedVersions: [1] }) } }).version({}, 's-1', 1);
    expect(approved?.approvalRequired).toBe(false);
  });

  it('reads no such strategy or version as none, and anything else as unavailable', async () => {
    expect(await source(404, { error: {} }).version({}, 's-1', 1)).toBeNull();
    expect(await source(200, { result: { data: strategy({ required: false, approvedVersions: [] }) } }).version({}, 's-1', 9)).toBeNull();
    await expect(source(412, { error: {} }).version({}, 's-1', 1)).rejects.toBeInstanceOf(StrategySourceUnavailable);
    // A reply outside studio.get's published shape is never read as a strategy.
    await expect(source(200, { result: { data: { versions: [version(1)] } } }).version({}, 's-1', 1)).rejects.toThrow(
      'svc-quant answered outside its contract',
    );
    // An id the record refuses is never sent.
    const seen: string[] = [];
    await expect(source(200, {}, seen).version({}, '', 1)).rejects.toBeInstanceOf(StrategySourceUnavailable);
    expect(seen).toEqual([]);
  });
});
