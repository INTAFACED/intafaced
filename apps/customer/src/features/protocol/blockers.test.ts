import { describe, expect, it } from 'vitest';
import {
  blockersFor,
  networkLabel,
  PROTOCOL_ACTIONS,
  protocolSubnav,
  tabFromSubPath,
  INTACHAIN_P1_GO,
  type ProtocolSnapshot,
} from './blockers';
import { protocolCopy } from './copy';
import type { ChainStatus, IndexerStatus } from './api';

const chain: ChainStatus = {
  reachable: true,
  configuredChainId: 84532,
  observedChainId: 84532,
  blockNumber: '100',
  suiteConfigured: true,
  suiteDeployed: true,
  tokenFactoryConfigured: true,
  tokenFactoryDeployed: true,
  refusalCode: null,
  reason: null,
  usable: true,
  launchUsable: true,
};
const indexer: IndexerStatus = {
  chainId: 84532,
  chainSource: 'evm',
  indexedHeight: 90,
  finalityDepth: 12,
  finalizedHeight: 78,
  ingestEnabled: true,
  halted: null,
  behindBy: 10,
  lastError: null,
  chain: null,
  clob: { live: true, kind: 'sovereign-venue' },
};
const healthy: ProtocolSnapshot = {
  chain: { status: 'ok', data: chain },
  audit: {
    status: 'ok',
    data: { id: 'x', kind: 'internal', packagePath: 'p', artifactHash: '0x0', signedBy: null, signedAt: null, audited: false },
  },
  indexer: { status: 'ok', data: indexer },
  dex: { status: 'ok', data: { ammVenueWired: true, externalVenueWired: false, internalBook: { enabled: true } } },
  health: { status: 'ok', data: { relayEnabled: true, factoryConfigured: true } },
};
const down = { status: 'down', reason: 'unreachable', message: 'The service could not be reached.' } as const;
const codes = (snapshot: ProtocolSnapshot, action: (typeof PROTOCOL_ACTIONS)[number]) => blockersFor(action, snapshot).map((b) => b.code);
const en = protocolCopy.forLocale('en');

describe('Protocol blocker mapping', () => {
  it('records the P1 GO (D-134), so the constant is true', () => {
    expect(INTACHAIN_P1_GO).toBe(true);
  });

  it('never leaves an action without a blocker, even when every service is healthy', () => {
    for (const action of PROTOCOL_ACTIONS) {
      const found = codes(healthy, action);
      expect(found.length, action).toBeGreaterThan(0);
      expect(found, action).toContain('not_audited');
      expect(found.at(-1), action).toBe('network_label');
    }
  });

  it('puts the P1 GO first for INTACHAIN-native actions only when no GO is recorded, and never for Base actions', () => {
    for (const action of ['bridge', 'stake', 'unstake'] as const) {
      expect(blockersFor(action, healthy, false)[0]?.code, action).toBe('p1_go');
      expect(codes(healthy, action), action).not.toContain('p1_go');
    }
    expect(codes(healthy, 'bridge')[0]).toBe('no_bridge_service');
    expect(codes(healthy, 'stake')[0]).toBe('no_chain_service');
    for (const action of ['swap', 'addLiquidity', 'smartAccount', 'launchToken'] as const)
      expect(codes(healthy, action)).not.toContain('p1_go');
    expect(codes(healthy, 'bridge')).toContain('no_bridge_service');
    expect(codes(healthy, 'stake')).toContain('no_chain_service');
  });

  it('lets a recorded GO clear only the P1 blocker', () => {
    expect(blockersFor('stake', healthy, true).map((b) => b.code)).toEqual(['no_chain_service', 'not_audited', 'network_label']);
  });

  it('names an unreachable service instead of guessing', () => {
    const found = blockersFor('swap', { ...healthy, chain: down });
    expect(found[0]).toMatchObject({
      code: 'source_no_reply',
      params: { source: 'network status', service: 'Protocol' },
    });
    expect(`Blocked: ${en.t(found[0]!.key, found[0]!.params)}`).toBe(
      'Blocked: network status unknown — the Protocol service didn’t answer.',
    );
  });

  it('treats a loading source as not yet confirmed, not as cleared', () => {
    const found = blockersFor('smartAccount', { ...healthy, health: { status: 'loading' } });
    const checking = found.find((b) => b.code === 'source_checking');
    expect(checking?.params.source).toBe('service health');
    expect(en.t(checking!.key, checking!.params)).toBe('still checking service health.');
  });

  it('orders chain, contracts, relay, venue and finality blockers as the audit lists them', () => {
    const broken: ProtocolSnapshot = {
      ...healthy,
      chain: { status: 'ok', data: { ...chain, reachable: false, reason: 'rpc timeout', suiteDeployed: false } },
      indexer: { status: 'ok', data: { ...indexer, finalizedHeight: null, clob: { live: false, kind: 'fixture' } } },
    };
    expect(codes(broken, 'swap')).toEqual([
      'chain_unreachable',
      'venue_not_live',
      'finality_unset',
      'no_execution_path',
      'not_audited',
      'network_label',
    ]);
    expect(blockersFor('swap', broken)[0]!.params.reason).toBe('The network gave no usable answer.');
    expect(blockersFor('swap', broken)[1]!.params.kind).toBe('fixture');
  });

  it('flags a chain id mismatch, a halted indexer and an unknown lag', () => {
    const mismatch = { ...healthy, chain: { status: 'ok', data: { ...chain, observedChainId: 1 } } } as ProtocolSnapshot;
    expect(codes(mismatch, 'smartAccount')[0]).toBe('chain_mismatch');
    const halted = {
      ...healthy,
      indexer: { status: 'ok', data: { ...indexer, halted: { reason: 'reorg', at: 'now' } } },
    } as ProtocolSnapshot;
    expect(codes(halted, 'swap')).toContain('indexer_halted');
    const lag = { ...healthy, indexer: { status: 'ok', data: { ...indexer, behindBy: null } } } as ProtocolSnapshot;
    expect(codes(lag, 'swap')).toContain('behind_unknown');
  });

  it('blocks pool actions when no AMM venue is wired and launch when the token factory is missing', () => {
    const noAmm = {
      ...healthy,
      dex: { status: 'ok', data: { ammVenueWired: false, externalVenueWired: false, internalBook: { enabled: true } } },
    } as ProtocolSnapshot;
    for (const action of ['addLiquidity', 'removeLiquidity', 'createPool'] as const) expect(codes(noAmm, action)).toContain('amm_unwired');
    const noFactory = { ...healthy, chain: { status: 'ok', data: { ...chain, tokenFactoryDeployed: false } } } as ProtocolSnapshot;
    expect(codes(noFactory, 'launchToken')[0]).toBe('token_factory_missing');
  });

  it('blocks smart accounts when relay is off or the suite is missing', () => {
    const noRelay = { ...healthy, health: { status: 'ok', data: { relayEnabled: false, factoryConfigured: true } } } as ProtocolSnapshot;
    expect(codes(noRelay, 'sessionKey')).toContain('relay_disabled');
    const noSuite = { ...healthy, chain: { status: 'ok', data: { ...chain, suiteDeployed: false } } } as ProtocolSnapshot;
    expect(codes(noSuite, 'smartAccount')[0]).toBe('suite_missing');
  });
});

describe('Shared engine copy', () => {
  it('has a plain sentence for every blocker code the engine can return, with no placeholder left over', () => {
    const withPolicy = { ...healthy, sessionPolicy: { refusedBy: 'approve' } };
    const seen = new Set<string>();
    for (const action of PROTOCOL_ACTIONS)
      for (const found of blockersFor(action, withPolicy)) {
        seen.add(found.code);
        const text = en.t(found.key, found.params);
        expect(text, found.code).not.toMatch(/\{\w+\}|^blk_/);
      }
    expect(seen.has('policy_gap')).toBe(true);
    expect(en.t('blk_policy_gap', { rule: 'approve' })).toBe(
      'A session key cannot be given this call: sessions never get approve. It stays with your own signature.',
    );
  });
});

describe('Network label and copy honesty', () => {
  it('labels 84532 as the Base Sepolia test network, not INTACHAIN', () => {
    const label = networkLabel(84532);
    expect(label.name).toBe('Base Sepolia test network');
    expect(label.note).toContain('Testnet');
    expect(en.t('bannerPill')).toContain('Not INTACHAIN');
    expect(en.t('bannerPill')).toContain('not audited');
  });

  it('never labels an unknown or missing chain as INTACHAIN or mainnet', () => {
    for (const id of [1, 8453, 999999, null, undefined]) {
      const label = networkLabel(id);
      expect(label.known).toBe(false);
      expect(`${label.name} ${label.note}`).toMatch(/not confirmed as INTACHAIN/i);
    }
  });

  it('never states audited true or live mainnet in any English blocker sentence', () => {
    for (const action of PROTOCOL_ACTIONS)
      for (const found of blockersFor(action, healthy)) {
        const text = en.t(found.key, found.params);
        expect(text, found.code).not.toMatch(/audited:\s*true|mainnet (is )?live|INTACHAIN (is )?live/i);
      }
    expect(en.t('blk_p1_go')).toContain('launch is not approved');
    expect(en.t('blk_p1_go')).not.toMatch(/Nitro|P1 GO/);
    expect(en.t('blk_not_audited')).toContain('Not audited');
  });
});

describe('Room sub-navigation', () => {
  it('offers the audited IA for each room', () => {
    expect(protocolSubnav('chain')).toEqual(['status', 'blocks', 'validators', 'audit']);
    expect(protocolSubnav('dex')).toEqual(['swap', 'pools', 'positions', 'venue']);
    expect(protocolSubnav('protocol')).toEqual(['overview', 'contracts', 'audit', 'rails']);
  });

  it('picks a tab from the sub-path, with or without the room prefix, and defaults to the first', () => {
    expect(tabFromSubPath('chain', 'validators')).toBe('validators');
    expect(tabFromSubPath('dex', '/dex/pools')).toBe('pools');
    expect(tabFromSubPath('protocol', 'nope')).toBe('overview');
    expect(tabFromSubPath('chain', undefined)).toBe('status');
  });
});
