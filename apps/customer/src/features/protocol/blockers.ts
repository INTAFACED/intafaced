import {
  blockersFor,
  chainReasonWords,
  INTACHAIN_P1_GO,
  isServiceNotConnected,
  KNOWN_NETWORKS,
  networkLabel,
  plainReason,
  PROTOCOL_ACTIONS,
  type Blocker,
  type BlockerCode,
  type BlockerSource as Source,
  type ProtocolAction,
  type ProtocolSnapshot,
} from '@intafaced/contracts/protocol-blockers';

/**
 * Typed blockers for every Protocol action. The engine lives in `@intafaced/contracts/protocol-blockers` so the room, the
 * ops desk and svc-protocol's `protocol.blockers` read answer from one set of rules; this file re-exports it and keeps
 * only the room navigation.
 *
 * Every action always has at least one blocker. `audited` is a literal false on the wire and every network the
 * room can show is a testnet or an unconfirmed chain, so no action here can ever be enabled by this code.
 */
export {
  blockersFor,
  chainReasonWords,
  INTACHAIN_P1_GO,
  isServiceNotConnected,
  KNOWN_NETWORKS,
  networkLabel,
  plainReason,
  PROTOCOL_ACTIONS,
};
export type { Blocker, BlockerCode, ProtocolAction, ProtocolSnapshot, Source };

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
