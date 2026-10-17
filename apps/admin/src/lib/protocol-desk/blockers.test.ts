import { describe, expect, it } from 'vitest';
import { DESKS, allReads } from '@/lib/ops-desk/catalog';
import { readData } from '@/lib/ops-desk/model';
import type { DeskView, ReadOutcome } from '@/lib/ops-desk/types';
import { ACTION_LABELS, PROTOCOL_ACTIONS, blockersFor, factsFrom, networkLabel } from './blockers';

const AT = '2026-10-17T03:00:00.000Z';
const ok = (id: string, raw: unknown): ReadOutcome => {
  const spec = allReads(DESKS.protocol).find((r) => r.id === id)!;
  const data = readData(spec, raw);
  if (!data) throw new Error(`fixture for ${id} does not read`);
  return { id, asOf: AT, part: { kind: 'ok', data } };
};
const down = (id: string, message = 'svc did not answer.'): ReadOutcome => ({
  id,
  asOf: AT,
  part: { kind: 'failed', message, code: null, notBuilt: false, forbidden: false },
});
const view = (...outcomes: ReadOutcome[]): DeskView => ({
  deskId: 'protocol',
  asOf: AT,
  reads: Object.fromEntries(outcomes.map((o) => [o.id, o])),
});

const CHAIN = {
  reachable: true,
  configuredChainId: 84532,
  observedChainId: 84532,
  blockNumber: '10',
  suiteConfigured: true,
  suiteDeployed: true,
  tokenFactoryConfigured: true,
  tokenFactoryDeployed: true,
  refusalCode: null,
  reason: null,
  usable: true,
  launchUsable: true,
};
const INDEXER = {
  chainId: 84532,
  chainSource: 'evm',
  indexedHeight: 100,
  finalityDepth: 12,
  finalizedHeight: 88,
  ingestEnabled: true,
  halted: null,
  chain: null,
  behindBy: 3,
  lastError: null,
  clob: { live: true, kind: 'sovereign-venue', reserves: false },
};
const DEX = { ammVenueWired: true, externalVenueWired: false, internalBook: { enabled: false } };
const HEALTH = { relayEnabled: true, factoryConfigured: true };
const allUp = () =>
  view(ok('protocol.chain', CHAIN), ok('protocol.indexer', INDEXER), ok('protocol.dex', DEX), ok('protocol.health', HEALTH));
const codes = (action: (typeof PROTOCOL_ACTIONS)[number], v: DeskView | null) => blockersFor(action, factsFrom(v)).map((b) => b.code);

describe('blockers for every Protocol action', () => {
  it('every action has at least one blocker even when every service is up: nothing is audited and no execution path is wired', () => {
    for (const action of PROTOCOL_ACTIONS) {
      const found = codes(action, allUp());
      expect(found.length, action).toBeGreaterThan(0);
      expect(found, action).toContain('not_audited');
      expect(found.at(-1), action).toBe('network_label');
    }
    expect(codes('swap', allUp())).toEqual(['no_execution_path', 'not_audited', 'network_label']);
  });
  it('with nothing read, every source is "could not load" and each one blocks, never clears', () => {
    const facts = factsFrom(null);
    for (const key of ['chain', 'indexer', 'dex', 'health'] as const) expect(facts[key].status).toBe('down');
    expect(codes('swap', null)).toEqual(['source_down', 'source_down', 'source_down', 'no_execution_path', 'not_audited', 'network_label']);
    for (const action of PROTOCOL_ACTIONS) expect(codes(action, null), action).toContain('not_audited');
  });
  it('names the source that could not be loaded, with its reason and the time it was tried', () => {
    const text = blockersFor(
      'smartAccount',
      factsFrom(view(down('protocol.chain', 'svc-protocol did not answer.'), ok('protocol.health', HEALTH))),
    )[0]!.text;
    expect(text).toContain('could not load chain status');
    expect(text).toContain('svc-protocol did not answer.');
    expect(text).toContain(`as of ${AT}`);
  });
  it('an unreachable chain, a wrong chain, missing contracts and an unwired AMM are each named', () => {
    const unreachable = view(
      ok('protocol.chain', { ...CHAIN, reachable: false, reason: 'rpc timeout' }),
      ok('protocol.indexer', INDEXER),
      ok('protocol.dex', DEX),
      ok('protocol.health', HEALTH),
    );
    expect(blockersFor('swap', factsFrom(unreachable))[0]!.text).toBe('The chain is unreachable: rpc timeout.');
    const wrong = view(
      ok('protocol.chain', { ...CHAIN, observedChainId: 1 }),
      ok('protocol.indexer', INDEXER),
      ok('protocol.dex', DEX),
      ok('protocol.health', HEALTH),
    );
    expect(blockersFor('swap', factsFrom(wrong))[0]!.text).toBe('Wrong chain: configured as 84532 but the node reports 1.');
    const noContracts = view(
      ok('protocol.chain', { ...CHAIN, suiteDeployed: false, tokenFactoryDeployed: false }),
      ok('protocol.indexer', INDEXER),
      ok('protocol.dex', { ...DEX, ammVenueWired: false }),
      ok('protocol.health', HEALTH),
    );
    expect(codes('smartAccount', noContracts)).toContain('suite_missing');
    expect(codes('launchToken', noContracts)).toContain('token_factory_missing');
    expect(codes('createPool', noContracts)).toContain('amm_unwired');
  });
  it('finality: a halted indexer, no finalized height and an unknown lag are told apart', () => {
    const withIndexer = (over: Record<string, unknown>) =>
      view(
        ok('protocol.chain', CHAIN),
        ok('protocol.indexer', { ...INDEXER, ...over }),
        ok('protocol.dex', DEX),
        ok('protocol.health', HEALTH),
      );
    expect(codes('swap', withIndexer({ halted: { reason: 'reorg', at: AT } }))[0]).toBe('indexer_halted');
    expect(blockersFor('swap', factsFrom(withIndexer({ halted: { reason: 'reorg', at: AT } })))[0]!.text).toBe(
      'The indexer is halted: reorg.',
    );
    expect(codes('swap', withIndexer({ finalizedHeight: null }))[0]).toBe('finality_unset');
    expect(codes('swap', withIndexer({ behindBy: null }))[0]).toBe('behind_unknown');
    expect(codes('swap', withIndexer({ clob: { live: false, kind: 'unset', reserves: false } }))[0]).toBe('venue_not_live');
  });
  it('relay off blocks smart accounts and session keys', () => {
    const v = view(
      ok('protocol.chain', CHAIN),
      ok('protocol.indexer', INDEXER),
      ok('protocol.dex', DEX),
      ok('protocol.health', { ...HEALTH, relayEnabled: false }),
    );
    expect(codes('smartAccount', v)).toContain('relay_disabled');
    expect(codes('sessionKey', v)).toContain('relay_disabled');
  });
  it('bridge, stake and unstake stop at the missing services whatever the chain says, and the P1 GO clears only its own blocker', () => {
    expect(codes('bridge', allUp())).toEqual(['no_bridge_service', 'not_audited', 'network_label']);
    expect(codes('stake', allUp())).toEqual(['no_chain_service', 'not_audited', 'network_label']);
    expect(codes('unstake', allUp())).toEqual(['no_chain_service', 'not_audited', 'network_label']);
    expect(blockersFor('stake', factsFrom(allUp()), false).map((b) => b.code)[0]).toBe('p1_go');
  });
  it('every action has a plain label', () => {
    for (const action of PROTOCOL_ACTIONS) expect(ACTION_LABELS[action].length).toBeGreaterThan(3);
  });
});

describe('network label', () => {
  it('names the test networks as test networks and never as INTACHAIN or mainnet', () => {
    expect(networkLabel(84532)).toMatchObject({ name: 'Base Sepolia test network', note: 'Testnet only.', known: true });
    expect(networkLabel(31337).name).toBe('Local test chain');
    for (const id of [null, undefined, 1, 8453, 1337, 999999]) {
      const label = networkLabel(id);
      expect(label.known).toBe(false);
      expect(`${label.name} ${label.note}`.toLowerCase()).not.toMatch(/mainnet|audited\b(?!.*not)/);
      expect(label.note).toBe('Not confirmed as INTACHAIN.');
    }
  });
  it('is taken from the chain id the chain service reported', () => {
    const v = view(ok('protocol.chain', { ...CHAIN, configuredChainId: 31337, observedChainId: 31337 }));
    expect(blockersFor('smartAccount', factsFrom(v)).at(-1)!.text).toBe('Local test chain. Used for automated checks only.');
  });
});
