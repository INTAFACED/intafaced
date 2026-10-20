import { z } from 'zod';

/**
 * PROTOCOL BLOCKERS — the one engine that says what stands in front of each Protocol action, and the wire contract of the
 * `protocol.blockers` read (D-order-controls-02). Pure: no network, no clock. The customer room and svc-protocol both run
 * this file over a snapshot of the five sources, so the room, the founder desk and the compliance view agree.
 *
 * Every action always has at least one blocker. `audited` is a literal false on the wire and every network is a testnet or
 * an unconfirmed chain, so nothing here can ever enable an action. A source that did not answer blocks like "no".
 */

/**
 * Whether the owner recorded a GO on INTACHAIN P1 (decision D-134, merged as #4640). The GO clears only the P1 blocker:
 * bridge, stake and unstake still stop at the missing chain and bridge services, every action stays not audited, and no
 * testnet is labelled mainnet.
 */
export const INTACHAIN_P1_GO: boolean = true;

/** Network labels by chain id (services/svc-protocol/deployments/base-sepolia.json). No id is ever labelled INTACHAIN or mainnet. */
export const KNOWN_NETWORKS: Readonly<Record<number, { name: string; note: string }>> = {
  84532: { name: 'Base Sepolia test network', note: 'Testnet only.' },
  31337: { name: 'Local test chain', note: 'Used for automated checks only.' },
};
export function networkLabel(chainId: number | null | undefined): { name: string; note: string; known: boolean } {
  if (chainId === null || chainId === undefined) return { name: 'No chain reported', note: 'Not confirmed as INTACHAIN.', known: false };
  const known = Object.hasOwn(KNOWN_NETWORKS, chainId) ? KNOWN_NETWORKS[chainId] : undefined;
  return known ? { ...known, known: true } : { name: 'Unrecognised network', note: 'Not confirmed as INTACHAIN.', known: false };
}

// ── Source answers (what each service returns, reduced to what the blockers read) ───────────────────────────────────────

export const protocolChainStatusSchema = z.object({
  reachable: z.boolean(),
  configuredChainId: z.number(),
  observedChainId: z.number().nullable(),
  blockNumber: z.string().nullable(),
  suiteConfigured: z.boolean(),
  suiteDeployed: z.boolean(),
  tokenFactoryConfigured: z.boolean(),
  tokenFactoryDeployed: z.boolean(),
  refusalCode: z.string().nullable(),
  reason: z.string().nullable(),
  usable: z.boolean(),
  launchUsable: z.boolean(),
});
export const protocolAuditStatusSchema = z.object({
  id: z.string(),
  kind: z.literal('internal'),
  packagePath: z.string(),
  artifactHash: z.string(),
  signedBy: z.string().nullable(),
  signedAt: z.string().nullable(),
  audited: z.literal(false),
});
export const protocolServiceHealthSchema = z.object({
  relayEnabled: z.boolean(),
  factoryConfigured: z.boolean(),
  venueVaultConfigured: z.boolean().optional(),
});
export const indexerStatusSchema = z.object({
  chainId: z.number(),
  chainSource: z.string(),
  indexedHeight: z.number().nullable(),
  finalityDepth: z.number(),
  finalizedHeight: z.number().nullable(),
  ingestEnabled: z.boolean(),
  halted: z.object({ reason: z.string(), at: z.string() }).nullable(),
  behindBy: z.number().nullable(),
  lastError: z.object({ code: z.string().nullable(), message: z.string(), at: z.string() }).nullable(),
  chain: z.object({ reachable: z.boolean(), chainHeight: z.number().nullable(), reason: z.string().nullable() }).nullable(),
  clob: z.object({ live: z.boolean(), kind: z.enum(['unset', 'fixture', 'sovereign-venue', 'unpublished']) }),
});
export const dexHealthSchema = z.object({
  ammVenueWired: z.boolean(),
  externalVenueWired: z.boolean(),
  internalBook: z.object({ enabled: z.boolean() }).passthrough(),
});
export type ProtocolChainStatus = z.infer<typeof protocolChainStatusSchema>;
export type ProtocolAuditStatus = z.infer<typeof protocolAuditStatusSchema>;
export type ProtocolServiceHealth = z.infer<typeof protocolServiceHealthSchema>;
export type IndexerStatus = z.infer<typeof indexerStatusSchema>;
export type DexHealth = z.infer<typeof dexHealthSchema>;

/** `code` is the gateway's own refusal code when there was one. */
export type BlockerSource<T> =
  { status: 'loading' } | { status: 'ok'; data: T } | { status: 'down'; reason: string; message: string; code?: string };

/** The gateway's "this service is not connected in this environment" answer. */
export const isServiceNotConnected = (code: string | undefined): boolean => code === 'edge.upstream_unwired';

export interface ProtocolSnapshot {
  chain: BlockerSource<ProtocolChainStatus>;
  audit: BlockerSource<ProtocolAuditStatus>;
  indexer: BlockerSource<IndexerStatus>;
  dex: BlockerSource<DexHealth>;
  health: BlockerSource<ProtocolServiceHealth>;
  /** Set by svc-protocol when the session spec would refuse the planned call; the room cannot know it. */
  sessionPolicy?: { refusedBy: string } | null;
}
export const PROTOCOL_SOURCES = ['chain', 'audit', 'indexer', 'dex', 'health'] as const;
export type ProtocolSourceKey = (typeof PROTOCOL_SOURCES)[number];

/** What the chain status says went wrong, in plain words. The service's own text carries an RPC address and spec references, so it is never shown. */
export function chainReasonWords(refusalCode: string | null | undefined): string {
  if (refusalCode === 'protocol.chain_unreachable') return 'The network did not answer.';
  if (refusalCode === 'protocol.contract_not_deployed') return 'The contracts are not on this network.';
  return 'The network gave no usable answer.';
}
/** A reason is dropped into a sentence of ours, so it loses its own full stop and any bare HTTP code. */
export function plainReason(text: string): string {
  return text
    .replace(/\s*\(\s*\d{3}\s*\)/g, '')
    .trim()
    .replace(/[\s.!?;:,…]+$/u, '');
}
const inSentence = (text: string): string => plainReason(text).replace(/^([A-Z])(?=[a-z])/, (letter) => letter.toLowerCase());

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
export const protocolActionSchema = z.enum(PROTOCOL_ACTIONS);

export const BLOCKER_CODES = [
  'p1_go',
  'no_chain_service',
  'no_bridge_service',
  'source_down',
  'source_no_reply',
  'source_checking',
  'source_not_connected',
  'chain_unreachable',
  'chain_mismatch',
  'suite_missing',
  'token_factory_missing',
  'amm_unwired',
  'relay_disabled',
  'venue_not_live',
  'finality_unset',
  'indexer_halted',
  'behind_unknown',
  'no_execution_path',
  'not_audited',
  'network_label',
  'policy_gap',
] as const;
export type BlockerCode = (typeof BLOCKER_CODES)[number];

/**
 * Which allowlisted NotConnected code (platform/foundations/NOT-CONNECTED-ALLOWLIST.md) a blocker shows as, or null when it
 * is our own missing build or a plain label. `p1_go` is cleared and never shown as a refusal. A not-launched INTACHAIN action
 * is `chain.go`; our own missing chain or bridge back end is "needs build", never NotConnected.
 */
export const BLOCKER_REFUSAL: Readonly<Record<BlockerCode, 'rail.crypto' | 'chain.go' | 'audit.external' | 'owner.decision' | null>> = {
  p1_go: null,
  no_chain_service: 'chain.go',
  no_bridge_service: 'chain.go',
  source_down: null,
  source_no_reply: null,
  source_checking: null,
  source_not_connected: null,
  chain_unreachable: 'rail.crypto',
  chain_mismatch: null,
  suite_missing: null,
  token_factory_missing: null,
  amm_unwired: null,
  relay_disabled: null,
  venue_not_live: null,
  finality_unset: null,
  indexer_halted: null,
  behind_unknown: null,
  no_execution_path: null,
  not_audited: null,
  network_label: null,
  policy_gap: null,
};

export interface Blocker {
  code: BlockerCode;
  /** Key into the room's copy catalogue; render with `protocolCopy.t(key, params)`. */
  key: `blk_${BlockerCode}`;
  params: Record<string, string>;
}
const blocker = (code: BlockerCode, params: Record<string, string> = {}): Blocker => ({ code, key: `blk_${code}`, params });

/** How a source is named to a customer. Never a procedure name. */
const sourceName = {
  chain: 'network status',
  audit: 'audit status',
  indexer: 'indexer status',
  dex: 'DEX status',
  health: 'service health',
};
const serviceName = { chain: 'Protocol', audit: 'Protocol', indexer: 'indexer', dex: 'DEX', health: 'Protocol' };

type Check = (snap: ProtocolSnapshot, p1Go: boolean) => Blocker | null;

/** A source that has not answered cannot clear a blocker, so "unknown" blocks exactly like "no". */
function needs<K extends ProtocolSourceKey>(
  key: K,
  then: (data: Extract<ProtocolSnapshot[K], { status: 'ok' }>['data'], snap: ProtocolSnapshot) => Blocker | null,
): Check {
  return (snap) => {
    const source = snap[key] as BlockerSource<never>;
    if (source.status === 'ok') return then(source.data as never, snap);
    if (source.status === 'down' && isServiceNotConnected(source.code))
      return blocker('source_not_connected', { service: serviceName[key] });
    if (source.status !== 'down') return blocker('source_checking', { source: sourceName[key] });
    if (source.reason === 'unreachable') return blocker('source_no_reply', { source: sourceName[key], service: serviceName[key] });
    return blocker('source_down', { source: sourceName[key], reason: inSentence(source.message) });
  };
}

const p1: Check = (_snap, p1Go) => (p1Go ? null : blocker('p1_go'));
const always =
  (code: BlockerCode): Check =>
  () =>
    blocker(code);
const chainUp = needs('chain', (c) => {
  if (!c.reachable) return blocker('chain_unreachable', { reason: chainReasonWords(c.refusalCode) });
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
  if (i.halted) return blocker('indexer_halted', { reason: inSentence(i.halted.reason) });
  if (i.finalizedHeight === null) return blocker('finality_unset');
  if (i.behindBy === null) return blocker('behind_unknown');
  return null;
});
const network: Check = (snap) => {
  const label = networkLabel(snap.chain.status === 'ok' ? snap.chain.data.configuredChainId : null);
  return blocker('network_label', { name: label.name, note: label.note });
};
/** The session spec would refuse the planned call (approve/permit selectors, transfers): a session key cannot be given it. */
const policy: Check = (snap) => (snap.sessionPolicy ? blocker('policy_gap', { rule: snap.sessionPolicy.refusedBy }) : null);

/**
 * Order follows the audit's "first failing blocker" list: P1 GO, chain reachable, contracts deployed, venue, finality, audit,
 * network label. INTACHAIN-native actions stop at P1 GO and the missing services; Base P0 actions are never told they wait on P1.
 */
const CHECKS: Record<ProtocolAction, readonly Check[]> = {
  swap: [chainUp, venue, finality, always('no_execution_path'), always('not_audited'), network],
  addLiquidity: [chainUp, amm, venue, finality, always('no_execution_path'), always('not_audited'), network],
  removeLiquidity: [chainUp, amm, venue, finality, always('no_execution_path'), always('not_audited'), network],
  createPool: [chainUp, amm, always('no_execution_path'), always('not_audited'), network],
  smartAccount: [chainUp, suite, relay, always('not_audited'), network],
  sessionKey: [chainUp, suite, relay, policy, always('not_audited'), network],
  launchToken: [chainUp, tokenFactory, always('not_audited'), network],
  bridge: [p1, always('no_bridge_service'), always('not_audited'), network],
  stake: [p1, always('no_chain_service'), always('not_audited'), network],
  unstake: [p1, always('no_chain_service'), always('not_audited'), network],
};

/** Every blocker standing in front of `action`, first failing one first. Never empty. */
export function blockersFor(action: ProtocolAction, snapshot: ProtocolSnapshot, p1Go: boolean = INTACHAIN_P1_GO): Blocker[] {
  return CHECKS[action].map((check) => check(snapshot, p1Go)).filter((found): found is Blocker => found !== null);
}

// ── The `protocol.blockers` read ────────────────────────────────────────────────────────────────────────────────────────

export const protocolBlockersInputSchema = z
  .object({
    /** The selector of the call a session key is planned for (`0x` and eight hex digits); only `sessionKey` reads it. */
    plannedSelector: z
      .string()
      .regex(/^0x[0-9a-fA-F]{8}$/)
      .optional(),
  })
  .strict();
export const blockerSchema = z
  .object({
    code: z.enum(BLOCKER_CODES),
    key: z.string(),
    params: z.record(z.string(), z.string()),
  })
  .strict()
  .refine((found) => found.key === `blk_${found.code}`, { message: 'key must be blk_<code>', path: ['key'] });
const sourceAnswerSchema = z.enum(['ok', 'checking', 'no_reply', 'not_connected', 'down']);
export const protocolBlockersOutputSchema = z
  .object({
    asOf: z.string(),
    p1Go: z.boolean(),
    /** How each source answered, so a client sees why a list is what it is. Every source is present. */
    sources: z
      .object(
        Object.fromEntries(PROTOCOL_SOURCES.map((key) => [key, sourceAnswerSchema])) as Record<
          ProtocolSourceKey,
          typeof sourceAnswerSchema
        >,
      )
      .strict(),
    /** Every action is present and none is ever empty. */
    actions: z
      .object(
        Object.fromEntries(PROTOCOL_ACTIONS.map((action) => [action, z.array(blockerSchema).min(1)])) as Record<
          ProtocolAction,
          z.ZodArray<typeof blockerSchema>
        >,
      )
      .strict(),
  })
  .strict();
export type ProtocolBlockersOutput = z.infer<typeof protocolBlockersOutputSchema>;

/** Runs the engine over a snapshot for every action: the body of `protocol.blockers`. */
export function protocolBlockersRead(snapshot: ProtocolSnapshot, asOf: string, p1Go: boolean = INTACHAIN_P1_GO): ProtocolBlockersOutput {
  const sources = Object.fromEntries(
    PROTOCOL_SOURCES.map((key) => {
      const source = snapshot[key] as BlockerSource<unknown>;
      return [
        key,
        source.status === 'ok'
          ? 'ok'
          : source.status === 'loading'
            ? 'checking'
            : isServiceNotConnected(source.code)
              ? 'not_connected'
              : source.reason === 'unreachable'
                ? 'no_reply'
                : 'down',
      ];
    }),
  ) as ProtocolBlockersOutput['sources'];
  const actions = Object.fromEntries(
    PROTOCOL_ACTIONS.map((action) => [action, blockersFor(action, snapshot, p1Go)]),
  ) as ProtocolBlockersOutput['actions'];
  return { asOf, p1Go, sources, actions };
}
