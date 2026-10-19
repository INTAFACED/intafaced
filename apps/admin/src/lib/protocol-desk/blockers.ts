import { cellOfRow } from '@/lib/ops-desk/model';
import type { Cell, DeskView } from '@/lib/ops-desk/types';
import { formatAsOf } from '@/lib/as-of';

/**
 * The named blockers in front of every Protocol action, worked out from what the founder desk just read.
 *
 * The label set and the order of the checks are COPIED from the customer rooms (apps/customer/src/features/protocol/
 * blockers.ts and copy.ts) so a founder and a customer read the same reasons. They are copied, not imported: the console
 * must not depend on customer code. If the customer wording changes, change it here too.
 *
 * Pure: no React, no network. A source that did not answer cannot clear a blocker, so "unknown" blocks exactly like "no".
 * Nothing here ever calls a network INTACHAIN or audited: the label comes from the chain id a service reported, and
 * "not audited" is a blocker on every action.
 */

/**
 * Whether Nitro has recorded the INTACHAIN P1 GO. TRUE since decision D-134 (docs/adr/2026-09-03-protocol-rails-until-intachain.md,
 * entry "2026-10-13 (later) — P1 GO"). It clears only the P1 blocker: bridge, stake and unstake still stop at the missing
 * chain and bridge services, and every action stays not audited.
 */
export const INTACHAIN_P1_GO: boolean = true;

/** Network labels by chain id (services/svc-protocol/deployments/base-sepolia.json). No id is ever labelled INTACHAIN or mainnet. */
const KNOWN_NETWORKS: Readonly<Record<number, { name: string; note: string }>> = {
  84532: { name: 'Base Sepolia test network', note: 'Testnet only.' },
  31337: { name: 'Local test chain', note: 'Used for automated checks only.' },
};

export function networkLabel(chainId: number | null | undefined): { name: string; note: string; known: boolean } {
  if (chainId === null || chainId === undefined) return { name: 'No chain reported', note: 'Not confirmed as INTACHAIN.', known: false };
  const known = KNOWN_NETWORKS[chainId];
  return known ? { ...known, known: true } : { name: 'Unrecognised network', note: 'Not confirmed as INTACHAIN.', known: false };
}

export type Source<T> =
  | { readonly status: 'ok'; readonly data: T; readonly asOf: string }
  | { readonly status: 'down'; readonly reason: string; readonly asOf: string | null };

export interface ChainFacts {
  readonly reachable: boolean;
  readonly configuredChainId: number;
  readonly observedChainId: number | null;
  readonly suiteDeployed: boolean;
  readonly tokenFactoryDeployed: boolean;
  readonly reason: string | null;
  readonly refusalCode: string | null;
}
export interface IndexerFacts {
  readonly haltedReason: string | null;
  readonly finalizedHeight: number | null;
  readonly behindBy: number | null;
  readonly clobLive: boolean;
  readonly clobKind: string;
}
export interface DexFacts {
  readonly ammVenueWired: boolean;
}
export interface HealthFacts {
  readonly relayEnabled: boolean;
}

export interface ProtocolFacts {
  readonly chain: Source<ChainFacts>;
  readonly indexer: Source<IndexerFacts>;
  readonly dex: Source<DexFacts>;
  readonly health: Source<HealthFacts>;
}

const READ_IDS = { chain: 'protocol.chain', indexer: 'protocol.indexer', dex: 'protocol.dex', health: 'protocol.health' } as const;

/** What an operator calls each source, for "could not load <name>". */
export const SOURCE_NAMES: Readonly<Record<keyof ProtocolFacts, string>> = {
  chain: 'chain status',
  indexer: 'indexer finality',
  dex: 'DEX health',
  health: 'protocol service health',
};

function cellValue(cells: readonly Cell[], key: string): Cell['value'] | undefined {
  return cellOfRow({ id: '', cells }, key);
}
const asBool = (v: Cell['value'] | undefined): boolean | null => (typeof v === 'boolean' ? v : null);
const asInt = (v: Cell['value'] | undefined): number | null => (typeof v === 'number' ? v : null);
const asText = (v: Cell['value'] | undefined): string | null => (typeof v === 'string' ? v : null);

function source<T>(view: DeskView | null, readId: string, build: (cells: readonly Cell[]) => T | null): Source<T> {
  if (view === null) return { status: 'down', reason: 'the desk was not read', asOf: null };
  const outcome = view.reads[readId];
  if (outcome === undefined) return { status: 'down', reason: 'this part was not read', asOf: null };
  if (outcome.part.kind === 'failed') return { status: 'down', reason: outcome.part.message, asOf: outcome.asOf };
  if (outcome.part.data.shape !== 'record') return { status: 'down', reason: 'the answer was not a record', asOf: outcome.asOf };
  const data = build(outcome.part.data.cells);
  return data === null
    ? { status: 'down', reason: 'the answer was missing a field', asOf: outcome.asOf }
    : { status: 'ok', data, asOf: outcome.asOf };
}

/** Fold the desk's reads into the facts the blockers need. A field that cannot be read makes its source "down", never a default. */
export function factsFrom(view: DeskView | null): ProtocolFacts {
  return {
    chain: source(view, READ_IDS.chain, (c) => {
      const reachable = asBool(cellValue(c, 'reachable'));
      const configuredChainId = asInt(cellValue(c, 'configuredChainId'));
      const suiteDeployed = asBool(cellValue(c, 'suiteDeployed'));
      const tokenFactoryDeployed = asBool(cellValue(c, 'tokenFactoryDeployed'));
      if (reachable === null || configuredChainId === null || suiteDeployed === null || tokenFactoryDeployed === null) return null;
      return {
        reachable,
        configuredChainId,
        observedChainId: asInt(cellValue(c, 'observedChainId')),
        suiteDeployed,
        tokenFactoryDeployed,
        reason: asText(cellValue(c, 'reason')),
        refusalCode: asText(cellValue(c, 'refusalCode')),
      };
    }),
    indexer: source(view, READ_IDS.indexer, (c) => {
      const clobLive = asBool(cellValue(c, 'clob.live'));
      const clobKind = asText(cellValue(c, 'clob.kind'));
      if (clobLive === null || clobKind === null) return null;
      return {
        haltedReason: asText(cellValue(c, 'halted.reason')),
        finalizedHeight: asInt(cellValue(c, 'finalizedHeight')),
        behindBy: asInt(cellValue(c, 'behindBy')),
        clobLive,
        clobKind,
      };
    }),
    dex: source(view, READ_IDS.dex, (c) => {
      const amm = asBool(cellValue(c, 'ammVenueWired'));
      return amm === null ? null : { ammVenueWired: amm };
    }),
    health: source(view, READ_IDS.health, (c) => {
      const relay = asBool(cellValue(c, 'relayEnabled'));
      return relay === null ? null : { relayEnabled: relay };
    }),
  };
}

export const PROTOCOL_ACTIONS = [
  'swap',
  'addLiquidity',
  'removeLiquidity',
  'createPool',
  'smartAccount',
  'sessionKey',
  'launchToken',
  'bridge',
  'stake',
  'unstake',
] as const;
export type ProtocolAction = (typeof PROTOCOL_ACTIONS)[number];

export const ACTION_LABELS: Readonly<Record<ProtocolAction, string>> = {
  swap: 'Swap',
  addLiquidity: 'Add liquidity',
  removeLiquidity: 'Remove liquidity',
  createPool: 'Create pool',
  smartAccount: 'Create smart account',
  sessionKey: 'Grant session key',
  launchToken: 'Launch token',
  bridge: 'Bridge to Protocol',
  stake: 'Stake',
  unstake: 'Unstake',
};

export type BlockerCode =
  | 'p1_go'
  | 'no_chain_service'
  | 'no_bridge_service'
  | 'source_down'
  | 'chain_unreachable'
  | 'chain_mismatch'
  | 'suite_missing'
  | 'token_factory_missing'
  | 'amm_unwired'
  | 'relay_disabled'
  | 'venue_not_live'
  | 'finality_unset'
  | 'indexer_halted'
  | 'behind_unknown'
  | 'no_execution_path'
  | 'not_audited'
  | 'network_label';

export interface Blocker {
  readonly code: BlockerCode;
  /** The sentence, with its parameters filled in. */
  readonly text: string;
}

/** The customer rooms' sentences (`blk_*` in their copy.ts), in the same words. `source_down` is reworded for a founder: it names the read and its time. */
const SENTENCES: Readonly<Record<BlockerCode, string>> = {
  p1_go: 'Not activated: the INTACHAIN network launch has not been approved yet. Nothing here runs on it.',
  no_chain_service: 'No INTACHAIN chain service or validator set runs on this stack, so this would be refused rather than shown as done.',
  no_bridge_service: 'No bridge service exists, so a bridge request would be refused rather than shown as locked or minted.',
  source_down: 'Cannot confirm: could not load {source} ({reason}).',
  chain_unreachable: 'The chain is unreachable: {reason}.',
  chain_mismatch: 'Wrong chain: configured as {configured} but the node reports {observed}.',
  suite_missing: 'The smart-account contracts are not deployed on this chain.',
  token_factory_missing: 'The token factory is not deployed on this chain.',
  amm_unwired: 'No AMM venue is wired into the DEX service, so there is no pool to trade against.',
  relay_disabled: 'Relaying is switched off on this deployment. Your account is unaffected.',
  venue_not_live: 'The order-book venue is not live (contract state: {kind}). Only the published venue address counts.',
  finality_unset: 'The indexer has no finalized height yet, so no book can be treated as final.',
  indexer_halted: 'The indexer is halted: {reason}.',
  behind_unknown: 'The indexer cannot tell how far behind the chain it is.',
  no_execution_path: 'No customer execution path is wired. The DEX service quotes and builds unsigned calls; it does not submit them.',
  not_audited: 'Not audited. Passing tests is not an audit.',
  network_label: '{name}. {note}',
};

function blocker(code: BlockerCode, params: Record<string, string> = {}): Blocker {
  return { code, text: SENTENCES[code].replace(/\{(\w+)\}/g, (_m, key: string) => params[key] ?? '') };
}

type Check = (facts: ProtocolFacts, p1Go: boolean) => Blocker | null;

function needs<K extends keyof ProtocolFacts>(
  key: K,
  then: (data: Extract<ProtocolFacts[K], { status: 'ok' }>['data'], facts: ProtocolFacts) => Blocker | null,
): Check {
  return (facts) => {
    const found = facts[key] as Source<never>;
    if (found.status === 'ok') return then(found.data as never, facts);
    return blocker('source_down', {
      source: SOURCE_NAMES[key],
      reason: `${found.reason}${found.asOf ? `, as of ${formatAsOf(found.asOf)}` : ''}`,
    });
  };
}

const p1: Check = (_facts, p1Go) => (p1Go ? null : blocker('p1_go'));
const always =
  (code: BlockerCode): Check =>
  () =>
    blocker(code);
const chainUp = needs('chain', (c) => {
  if (!c.reachable) return blocker('chain_unreachable', { reason: c.reason ?? c.refusalCode ?? 'no reason returned' });
  if (c.observedChainId !== null && c.observedChainId !== c.configuredChainId)
    return blocker('chain_mismatch', { configured: String(c.configuredChainId), observed: String(c.observedChainId) });
  return null;
});
const suite = needs('chain', (c) => (c.suiteDeployed ? null : blocker('suite_missing')));
const tokenFactory = needs('chain', (c) => (c.tokenFactoryDeployed ? null : blocker('token_factory_missing')));
const amm = needs('dex', (d) => (d.ammVenueWired ? null : blocker('amm_unwired')));
const relay = needs('health', (h) => (h.relayEnabled ? null : blocker('relay_disabled')));
const venue = needs('indexer', (i) =>
  i.clobLive && i.clobKind === 'sovereign-venue' ? null : blocker('venue_not_live', { kind: i.clobKind }),
);
const finality = needs('indexer', (i) => {
  if (i.haltedReason !== null) return blocker('indexer_halted', { reason: i.haltedReason });
  if (i.finalizedHeight === null) return blocker('finality_unset');
  if (i.behindBy === null) return blocker('behind_unknown');
  return null;
});
const network: Check = (facts) => {
  const label = networkLabel(facts.chain.status === 'ok' ? facts.chain.data.configuredChainId : null);
  return blocker('network_label', { name: label.name, note: label.note });
};

/** Same order as the customer rooms: P1 GO, chain reachable, contracts deployed, venue, finality, audit, network label. */
const CHECKS: Readonly<Record<ProtocolAction, readonly Check[]>> = {
  swap: [chainUp, venue, finality, always('no_execution_path'), always('not_audited'), network],
  addLiquidity: [chainUp, amm, venue, finality, always('no_execution_path'), always('not_audited'), network],
  removeLiquidity: [chainUp, amm, venue, finality, always('no_execution_path'), always('not_audited'), network],
  createPool: [chainUp, amm, always('no_execution_path'), always('not_audited'), network],
  smartAccount: [chainUp, suite, relay, always('not_audited'), network],
  sessionKey: [chainUp, suite, relay, always('not_audited'), network],
  launchToken: [chainUp, tokenFactory, always('not_audited'), network],
  bridge: [p1, always('no_bridge_service'), always('not_audited'), network],
  stake: [p1, always('no_chain_service'), always('not_audited'), network],
  unstake: [p1, always('no_chain_service'), always('not_audited'), network],
};

/** Every blocker in front of `action`, first failing one first. Never empty: "not audited" is on every action. */
export function blockersFor(action: ProtocolAction, facts: ProtocolFacts, p1Go: boolean = INTACHAIN_P1_GO): Blocker[] {
  return CHECKS[action].map((check) => check(facts, p1Go)).filter((found): found is Blocker => found !== null);
}
