import { describe, expect, it } from 'vitest';
import { DESKS, allReads } from './catalog';
import { cellOfRow, formatCell, readData } from './model';

/** The token and protocol reads, each fed what the owning service's output schema says it returns, and then what it must never be trusted to say. */

const read = (id: string) =>
  allReads(DESKS.more)
    .concat(allReads(DESKS.protocol))
    .find((r) => r.id === id)!;
const AT = '2026-10-17T03:00:00.000Z';

describe('token reads', () => {
  const PROPOSAL = {
    id: '5a3b9c10-1111-4222-8333-444455556666',
    kind: 'fee_param',
    body: { anything: 'free form' },
    status: 'open',
    opensAt: AT,
    closesAt: '2026-10-24T03:00:00.000Z',
    createdAt: AT,
  };
  it('listProposals: reads the rows, ignores the free-form body, ids rows by proposal id', () => {
    const data = readData(read('token.proposals'), [
      PROPOSAL,
      { ...PROPOSAL, id: '6b4c0d21-1111-4222-8333-444455556666', status: 'passed' },
    ]);
    expect(data).toMatchObject({ shape: 'list', pageFull: false });
    if (data?.shape !== 'list') throw new Error('list expected');
    expect(data.rows.map((r) => r.id)).toEqual([PROPOSAL.id, '6b4c0d21-1111-4222-8333-444455556666']);
    expect(cellOfRow(data.rows[0]!, 'status')).toBe('open');
    expect(data.rows[0]!.cells.map((c) => c.key)).not.toContain('body');
  });
  it('listProposals: an empty answer is an empty list, and a full page of 50 is flagged as not a total', () => {
    expect(readData(read('token.proposals'), [])).toMatchObject({ shape: 'list', rows: [], pageFull: false });
    const full = Array.from({ length: 50 }, (_, i) => ({ ...PROPOSAL, id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }));
    expect(readData(read('token.proposals'), full)).toMatchObject({ pageFull: true });
  });
  it('listProposals: a bad time or a missing field makes the whole read unreadable, never a partial table', () => {
    expect(readData(read('token.proposals'), [{ ...PROPOSAL, opensAt: 'soon' }])).toBeNull();
    const { kind: _kind, ...missing } = PROPOSAL;
    expect(readData(read('token.proposals'), [missing])).toBeNull();
    expect(readData(read('token.proposals'), { proposals: [] })).toBeNull();
    expect(readData(read('token.proposals'), [PROPOSAL, PROPOSAL])).toBeNull();
  });
  it('burnedSupply: shows the decimal exactly as given and refuses a number', () => {
    const data = readData(read('token.burned'), { burned: '1234.567890123456789012' });
    if (data?.shape !== 'record') throw new Error('record expected');
    expect(formatCell(data.cells[0]!)).toBe('1234.567890123456789012');
    expect(readData(read('token.burned'), { burned: 1234.5 })).toBeNull();
    expect(readData(read('token.burned'), {})).toBeNull();
  });
  it('nextEmissionEpoch: a whole number, zero included, and nothing else', () => {
    const zero = readData(read('token.epoch'), { epoch: 0 });
    if (zero?.shape !== 'record') throw new Error('record expected');
    expect(formatCell(zero.cells[0]!)).toBe('0');
    expect(readData(read('token.epoch'), { epoch: 1.5 })).toBeNull();
    expect(readData(read('token.epoch'), { epoch: '3' })).toBeNull();
  });
});

describe('protocol reads', () => {
  const CHAIN = {
    reachable: true,
    configuredChainId: 84532,
    observedChainId: 84532,
    blockNumber: '123456',
    suiteConfigured: true,
    suiteDeployed: true,
    tokenFactoryConfigured: true,
    tokenFactoryDeployed: false,
    refusalCode: null,
    reason: null,
    usable: true,
    launchUsable: false,
  };
  it('chainStatus: reads the probe, keeps a blank block number blank', () => {
    const data = readData(read('protocol.chain'), {
      ...CHAIN,
      reachable: false,
      observedChainId: null,
      blockNumber: null,
      reason: 'no rpc',
    });
    if (data?.shape !== 'record') throw new Error('record expected');
    expect(cellOfRow({ id: '', cells: data.cells }, 'blockNumber')).toBeNull();
    expect(formatCell(data.cells.find((c) => c.key === 'blockNumber')!)).toBe('—');
    expect(readData(read('protocol.chain'), { ...CHAIN, reachable: 'yes' })).toBeNull();
  });
  const AUDIT = {
    id: 'smart-accounts-internal',
    kind: 'internal',
    packagePath: 'services/svc-protocol/audit/internal',
    artifactHash: `0x${'a'.repeat(64)}`,
    signedBy: null,
    signedAt: null,
    audited: false,
  };
  it('auditStatus: reads an unaudited package', () => {
    expect(readData(read('protocol.audit'), AUDIT)).toMatchObject({ shape: 'record' });
  });
  it('auditStatus: an answer that claims an outside audit, or a kind other than internal, is refused as unreadable instead of shown', () => {
    expect(readData(read('protocol.audit'), { ...AUDIT, audited: true })).toBeNull();
    expect(readData(read('protocol.audit'), { ...AUDIT, kind: 'external' })).toBeNull();
  });
  const INDEXER = {
    chainId: 84532,
    chainSource: 'evm',
    indexedHeight: 100,
    indexedHash: '0xabc',
    earliestHeight: 1,
    finalityDepth: 12,
    finalizedHeight: 88,
    ingestEnabled: true,
    halted: null,
    chain: null,
    behindBy: null,
    lastError: null,
    clob: { live: false, kind: 'unset', reserves: false },
  };
  it('indexer status: a null halted, chain probe and last error read as blank, not as an unreadable answer', () => {
    const data = readData(read('protocol.indexer'), INDEXER);
    if (data?.shape !== 'record') throw new Error('record expected');
    const get = (k: string) => data.cells.find((c) => c.key === k)!.value;
    expect(get('halted.reason')).toBeNull();
    expect(get('lastError.message')).toBeNull();
    expect(get('chain.chainHeight')).toBeNull();
    expect(get('behindBy')).toBeNull();
    expect(get('finalizedHeight')).toBe(88);
    expect(get('clob.kind')).toBe('unset');
  });
  it('indexer status: reads a halted indexer with its reason, and a live chain probe', () => {
    const data = readData(read('protocol.indexer'), {
      ...INDEXER,
      halted: { reason: 'reorg deeper than finality', at: AT },
      chain: {
        kind: 'evm',
        rpcUrl: null,
        venue: null,
        reachable: true,
        observedChainId: 84532,
        chainHeight: 120,
        venueDeployed: false,
        refusalCode: null,
      },
      behindBy: 20,
    });
    if (data?.shape !== 'record') throw new Error('record expected');
    expect(data.cells.find((c) => c.key === 'halted.reason')!.value).toBe('reorg deeper than finality');
    expect(data.cells.find((c) => c.key === 'chain.chainHeight')!.value).toBe(120);
    expect(data.cells.find((c) => c.key === 'behindBy')!.value).toBe(20);
  });
  it('indexer status: a null parent only reads as blank where the column says it may be; elsewhere it is unreadable', () => {
    expect(readData(read('protocol.indexer'), { ...INDEXER, clob: null })).toBeNull();
    const { clob: _clob, ...noClob } = INDEXER;
    expect(readData(read('protocol.indexer'), noClob)).toBeNull();
  });
  it('dex health: reads the venue flags from the top level and from the internal book', () => {
    const data = readData(read('protocol.dex'), {
      ok: true,
      service: 'svc-dex',
      serviceHoldsBalances: false,
      internalBook: { enabled: false },
      ammVenueWired: false,
      externalVenueWired: false,
    });
    if (data?.shape !== 'record') throw new Error('record expected');
    expect(data.cells.map((c) => [c.key, c.value])).toEqual([
      ['ammVenueWired', false],
      ['externalVenueWired', false],
      ['internalBook.enabled', false],
    ]);
    expect(readData(read('protocol.dex'), { ammVenueWired: false, externalVenueWired: false })).toBeNull();
  });
  it('protocol health: reads relay and factory flags and tolerates the optional vault flag it does not show', () => {
    expect(
      readData(read('protocol.health'), { ok: true, relayEnabled: false, factoryConfigured: false, venueVaultConfigured: true }),
    ).toMatchObject({
      shape: 'record',
    });
    expect(readData(read('protocol.health'), { relayEnabled: false })).toBeNull();
  });
});
