import { describe, expect, it } from 'vitest';
import {
  blockersFor,
  INTACHAIN_P1_GO,
  networkLabel,
  PROTOCOL_ACTIONS,
  protocolBlockersInputSchema,
  protocolBlockersOutputSchema,
  protocolBlockersRead,
  type IndexerStatus,
  type ProtocolChainStatus,
  type ProtocolSnapshot,
} from './protocol-blockers.js';

const chain: ProtocolChainStatus = {
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
const codes = (snapshot: ProtocolSnapshot, action: (typeof PROTOCOL_ACTIONS)[number], p1Go?: boolean) =>
  blockersFor(action, snapshot, p1Go).map((b) => b.code);

describe('protocol blocker engine', () => {
  it('records the P1 GO (owner decision 2026-10-17)', () => {
    expect(INTACHAIN_P1_GO).toBe(true);
  });

  it('never leaves an action without a blocker, and always ends on the network label', () => {
    for (const action of PROTOCOL_ACTIONS) {
      const found = codes(healthy, action);
      expect(found.length, action).toBeGreaterThan(0);
      expect(found, action).toContain('not_audited');
      expect(found.at(-1), action).toBe('network_label');
    }
  });

  it('shows the P1 blocker on INTACHAIN-native actions only when no GO is recorded', () => {
    for (const action of ['bridge', 'stake', 'unstake'] as const) {
      expect(codes(healthy, action, false)[0], action).toBe('p1_go');
      expect(codes(healthy, action), action).not.toContain('p1_go');
    }
    for (const action of ['swap', 'addLiquidity', 'smartAccount', 'launchToken'] as const)
      expect(codes(healthy, action, false), action).not.toContain('p1_go');
  });

  it('treats an unanswered source like a no, never as cleared', () => {
    expect(codes({ ...healthy, chain: down }, 'swap')[0]).toBe('source_no_reply');
    expect(codes({ ...healthy, health: { status: 'loading' } }, 'smartAccount')).toContain('source_checking');
    expect(
      codes({ ...healthy, dex: { status: 'down', reason: 'unwired', message: 'x', code: 'edge.upstream_unwired' } }, 'createPool'),
    ).toContain('source_not_connected');
    expect(codes({ ...healthy, dex: { status: 'down', reason: 'http_500', message: 'It broke.' } }, 'createPool')).toContain('source_down');
  });

  it('orders chain, venue and finality blockers as the audit lists them', () => {
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
    expect(blockersFor('swap', broken)[1]!.params.kind).toBe('fixture');
  });

  it('flags a chain id mismatch, a halted indexer and an unknown lag', () => {
    expect(codes({ ...healthy, chain: { status: 'ok', data: { ...chain, observedChainId: 1 } } }, 'smartAccount')[0]).toBe(
      'chain_mismatch',
    );
    const halted = { ...indexer, halted: { reason: 'reorg', at: 'now' } } as IndexerStatus;
    expect(codes({ ...healthy, indexer: { status: 'ok', data: halted } }, 'swap')).toContain('indexer_halted');
    expect(codes({ ...healthy, indexer: { status: 'ok', data: { ...indexer, behindBy: null } } }, 'swap')).toContain('behind_unknown');
  });

  it('blocks pool actions without an AMM venue, launch without a factory, and smart accounts without relay or suite', () => {
    const noAmm: ProtocolSnapshot = {
      ...healthy,
      dex: { status: 'ok', data: { ammVenueWired: false, externalVenueWired: false, internalBook: { enabled: true } } },
    };
    for (const action of ['addLiquidity', 'removeLiquidity', 'createPool'] as const) expect(codes(noAmm, action)).toContain('amm_unwired');
    expect(codes({ ...healthy, chain: { status: 'ok', data: { ...chain, tokenFactoryDeployed: false } } }, 'launchToken')[0]).toBe(
      'token_factory_missing',
    );
    expect(codes({ ...healthy, health: { status: 'ok', data: { relayEnabled: false, factoryConfigured: true } } }, 'sessionKey')).toContain(
      'relay_disabled',
    );
    expect(codes({ ...healthy, chain: { status: 'ok', data: { ...chain, suiteDeployed: false } } }, 'smartAccount')[0]).toBe(
      'suite_missing',
    );
  });

  it('names the venue kind when the order-book venue is not live', () => {
    const fixture = { ...indexer, clob: { live: false, kind: 'fixture' } } as IndexerStatus;
    const found = blockersFor('swap', { ...healthy, indexer: { status: 'ok', data: fixture } }).find((b) => b.code === 'venue_not_live');
    expect(found?.params).toEqual({ kind: 'fixture' });
    const unpublished = { ...indexer, clob: { live: true, kind: 'unpublished' } } as IndexerStatus;
    expect(codes({ ...healthy, indexer: { status: 'ok', data: unpublished } }, 'swap')).toContain('venue_not_live');
  });

  it('adds policy_gap to a session key only when the session spec refuses the planned call', () => {
    expect(codes(healthy, 'sessionKey')).not.toContain('policy_gap');
    const refused = { ...healthy, sessionPolicy: { refusedBy: 'approve' } };
    expect(blockersFor('sessionKey', refused).find((b) => b.code === 'policy_gap')?.params).toEqual({ rule: 'approve' });
    expect(codes(refused, 'swap')).not.toContain('policy_gap');
  });
});

describe('network label', () => {
  it('does not read inherited object keys as known networks', () => {
    expect(networkLabel('constructor' as unknown as number).known).toBe(false);
  });

  it('labels 84532 as the Base Sepolia test network, not INTACHAIN', () => {
    const label = networkLabel(84532);
    expect(label.name).toBe('Base Sepolia test network');
    expect(label.known).toBe(true);
  });

  it('never labels an unknown or missing chain as INTACHAIN or mainnet', () => {
    for (const id of [1, 8453, 999999, null, undefined]) {
      const label = networkLabel(id);
      expect(label.known).toBe(false);
      expect(`${label.name} ${label.note}`).toMatch(/not confirmed as INTACHAIN/i);
    }
  });

  it('never states audited true or a live mainnet in what a blocker carries', () => {
    for (const action of PROTOCOL_ACTIONS)
      for (const found of blockersFor(action, healthy)) {
        expect(JSON.stringify(found), found.code).not.toMatch(/audited:\s*true|mainnet (is )?live|INTACHAIN (is )?live/i);
      }
  });
});

describe('protocol.blockers read', () => {
  it('answers every action and validates against its own output schema', () => {
    const out = protocolBlockersRead(healthy, '2026-10-20T00:00:00.000Z');
    expect(protocolBlockersOutputSchema.parse(out)).toEqual(out);
    expect(Object.keys(out.actions).sort()).toEqual([...PROTOCOL_ACTIONS].sort());
    expect(out.sources).toEqual({ chain: 'ok', audit: 'ok', indexer: 'ok', dex: 'ok', health: 'ok' });
  });

  it('rejects an output missing an action or a source, an empty list, or a key that is not tied to its code', () => {
    const out = protocolBlockersRead(healthy, 'now');
    const { swap: _swap, ...fewer } = out.actions;
    expect(protocolBlockersOutputSchema.safeParse({ ...out, actions: fewer }).success).toBe(false);
    expect(protocolBlockersOutputSchema.safeParse({ ...out, actions: { ...out.actions, swap: [] } }).success).toBe(false);
    const { dex: _dex, ...sources } = out.sources;
    expect(protocolBlockersOutputSchema.safeParse({ ...out, sources }).success).toBe(false);
    const wrongKey = [{ ...out.actions.swap[0]!, key: 'blk_p1_go' }];
    expect(protocolBlockersOutputSchema.safeParse({ ...out, actions: { ...out.actions, swap: wrongKey } }).success).toBe(false);
    expect(protocolBlockersOutputSchema.safeParse({ ...out, extra: 1 }).success).toBe(false);
  });

  it('reports how each source answered', () => {
    const out = protocolBlockersRead(
      {
        ...healthy,
        chain: down,
        health: { status: 'loading' },
        dex: { status: 'down', reason: 'x', message: 'm', code: 'edge.upstream_unwired' },
        audit: { status: 'down', reason: 'http_500', message: 'm' },
      },
      'now',
    );
    expect(out.sources).toMatchObject({ chain: 'no_reply', health: 'checking', dex: 'not_connected', audit: 'down' });
  });

  it('accepts only a well-formed planned selector and nothing else', () => {
    expect(protocolBlockersInputSchema.safeParse({}).success).toBe(true);
    expect(protocolBlockersInputSchema.safeParse({ plannedSelector: '0x095ea7b3' }).success).toBe(true);
    expect(protocolBlockersInputSchema.safeParse({ plannedSelector: '095ea7b3' }).success).toBe(false);
    expect(protocolBlockersInputSchema.safeParse({ plannedSelector: '0x095ea7b3', extra: 1 }).success).toBe(false);
  });
});
