import type { AuditStatus, ChainStatus, DexHealth, IndexerStatus, ProtocolHealth } from './api';

/**
 * Typed blockers for every Protocol action. Pure: no React, no network. The room reads the services once,
 * folds the answers into a {@link ProtocolSnapshot}, and asks which blockers stand in front of each action.
 *
 * Every action always has at least one blocker. `audited` is a literal false on the wire and every network the
 * room can show is a testnet or an unconfirmed chain, so no action here can ever be enabled by this code.
 */

/**
 * Whether Nitro has recorded a GO on INTACHAIN P1. FALSE.
 * Source of truth is a document, not a service: docs/adr/2026-09-03-protocol-rails-until-intachain.md
 * ("Until Nitro says GO again on P1 ... INTACHAIN P1 implement is parked"; unpark needs a written GO, the S-D2
 * module map, and any testnet labelled not mainnet). Flip this only when that ADR records the GO.
 */
export const INTACHAIN_P1_GO: boolean = false;

/**
 * Network labels by chain id. Source: services/svc-protocol/deployments/base-sepolia.json
 * (`chainId: 84532`, `rpcNote: "Base Sepolia testnet. Not INTACHAIN. audited:false."`), pinned server-side by
 * `assertSepoliaRegistry`. 31337 is the local anvil chain CI uses. Anything else is shown as unrecognised;
 * no id is ever labelled INTACHAIN or mainnet.
 */
export const KNOWN_NETWORKS: Readonly<Record<number, { name: string; note: string }>> = {
  84532: { name: 'Base Sepolia', note: 'Testnet. Not INTACHAIN. Not mainnet. audited:false.' },
  31337: { name: 'Local anvil', note: 'Local test chain used by CI. Not INTACHAIN. Not mainnet.' },
};
export function networkLabel(chainId: number | null | undefined): { name: string; note: string; known: boolean } {
  if (chainId === null || chainId === undefined) return { name: 'No chain reported', note: 'Not confirmed as INTACHAIN.', known: false };
  const known = KNOWN_NETWORKS[chainId];
  return known
    ? { ...known, known: true }
    : { name: `Chain ${chainId} (unrecognised)`, note: 'Not confirmed as INTACHAIN. Not audited.', known: false };
}

export type Source<T> = { status: 'loading' } | { status: 'ok'; data: T } | { status: 'down'; reason: string; message: string };

export interface ProtocolSnapshot {
  chain: Source<ChainStatus>;
  audit: Source<AuditStatus>;
  indexer: Source<IndexerStatus>;
  dex: Source<DexHealth>;
  health: Source<ProtocolHealth>;
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
  code: BlockerCode;
  /** Key into the room's copy catalogue; render with `protocolCopy.t(key, params)`. */
  key: `blk_${BlockerCode}`;
  params: Record<string, string>;
}

const blocker = (code: BlockerCode, params: Record<string, string> = {}): Blocker => ({ code, key: `blk_${code}`, params });
const sourceName = {
  chain: 'protocol.chainStatus',
  audit: 'protocol.auditStatus',
  indexer: 'indexer.status',
  dex: 'dex.health',
  health: 'protocol.health',
};

type Check = (snap: ProtocolSnapshot, p1Go: boolean) => Blocker | null;

/** A source that has not answered cannot clear a blocker, so "unknown" blocks exactly like "no". */
function needs<K extends keyof ProtocolSnapshot>(
  key: K,
  then: (data: Extract<ProtocolSnapshot[K], { status: 'ok' }>['data'], snap: ProtocolSnapshot) => Blocker | null,
): Check {
  return (snap) => {
    const source = snap[key] as Source<never>;
    if (source.status === 'ok') return then(source.data as never, snap);
    return blocker('source_down', {
      source: sourceName[key],
      reason: source.status === 'down' ? source.message : 'still checking',
    });
  };
}

const p1: Check = (_snap, p1Go) => (p1Go ? null : blocker('p1_go'));
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
  i.clob.live && i.clob.kind === 'sovereign-venue' ? null : blocker('venue_not_live', { kind: i.clob.kind }),
);
const finality = needs('indexer', (i) => {
  if (i.halted) return blocker('indexer_halted', { reason: i.halted.reason });
  if (i.finalizedHeight === null) return blocker('finality_unset');
  if (i.behindBy === null) return blocker('behind_unknown');
  return null;
});
const network: Check = (snap) => {
  const id = snap.chain.status === 'ok' ? snap.chain.data.configuredChainId : null;
  const label = networkLabel(id);
  return blocker('network_label', { name: label.name, note: label.note });
};

/**
 * Order follows the audit's "first failing blocker" list: P1 GO, chain reachable, contracts deployed, venue,
 * finality, audit, network label. INTACHAIN-native actions (bridge, stake, unstake) stop at P1 GO and the
 * missing services; Base P0 actions are never told they wait on P1, because they do not.
 */
const CHECKS: Record<ProtocolAction, readonly Check[]> = {
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

/** Every blocker standing in front of `action`, first failing one first. Never empty. */
export function blockersFor(action: ProtocolAction, snapshot: ProtocolSnapshot, p1Go: boolean = INTACHAIN_P1_GO): Blocker[] {
  return CHECKS[action].map((check) => check(snapshot, p1Go)).filter((found): found is Blocker => found !== null);
}

export type Slug = 'chain' | 'dex' | 'protocol';
export interface SubTab {
  id: string;
  actions: readonly ProtocolAction[];
}
/** Each room's information architecture. Sub-path `/<slug>/<tab id>` selects a tab. */
export const SUBNAV: Record<Slug, readonly SubTab[]> = {
  chain: [
    { id: 'status', actions: [] },
    { id: 'blocks', actions: [] },
    { id: 'validators', actions: ['stake', 'unstake'] },
    { id: 'audit', actions: [] },
  ],
  dex: [
    { id: 'swap', actions: ['swap'] },
    { id: 'pools', actions: ['createPool'] },
    { id: 'positions', actions: ['addLiquidity', 'removeLiquidity'] },
    { id: 'venue', actions: [] },
  ],
  protocol: [
    { id: 'overview', actions: ['smartAccount', 'sessionKey'] },
    { id: 'contracts', actions: ['launchToken'] },
    { id: 'audit', actions: [] },
    { id: 'rails', actions: ['bridge'] },
  ],
};
export function protocolSubnav(slug: Slug): readonly string[] {
  return SUBNAV[slug].map((tab) => tab.id);
}
export function tabFromSubPath(slug: Slug, subPath: string | undefined): string {
  const parts = (subPath ?? '').split('/').filter(Boolean);
  const first = parts[0] === slug ? parts[1] : parts[0];
  return SUBNAV[slug].find((tab) => tab.id === first)?.id ?? SUBNAV[slug][0]!.id;
}
