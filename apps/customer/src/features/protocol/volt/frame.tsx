import { useMemo } from 'react';
import { Tag } from '@intafaced/ui/lit';
import { navigate } from '../../../app/location';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { useApi } from '../../session';
import { createProtocolApi } from '../api';
import { SUBNAV, type ProtocolSnapshot, type Slug } from '../blockers';
import { protocolCopy as copy } from '../copy';
import type { ChainRef } from '../NetworkPanels';
import { Actions, toSource } from './answer';
import { Tabs } from './parts';

/**
 * The frame the Web3 record-list rooms share, drawn only from the Volt kit: the parked line with its pill (never
 * INTACHAIN mainnet, never audited), and for a /chain, /dex or /protocol tab its sections and the actions it waits on.
 */

type Translate = ReturnType<typeof copy.forLocale>['t'];
type ProtocolApi = ReturnType<typeof createProtocolApi>;

/** What a tab's own parts read: the room's words, the protocol client, the network and the indexer's and DEX's answers. */
export interface TabRoomData {
  t: Translate;
  api: ProtocolApi;
  transport: ReturnType<typeof useApi>;
  chain: ChainRef;
  indexer: ReturnType<typeof useReads>['indexer'];
  dex: ReturnType<typeof useReads>['dex'];
}

/** The room's status reads, keyed as ParkedProtocolRoom keys them, so a tab moved here and one still there share them. */
function useReads(api: ProtocolApi, slug: Slug) {
  const key = `protocol-room:${slug}`;
  const chain = useResource((signal) => api.chainStatus(signal), `${key}:chain`),
    audit = useResource((signal) => api.auditStatus(signal), `${key}:audit`),
    indexer = useResource((signal) => api.indexerStatus(signal), `${key}:indexer`),
    dex = useResource((signal) => api.dexHealth(signal), `${key}:dex`),
    health = useResource((signal) => api.health(signal), `${key}:health`);
  return { chain, audit, indexer, dex, health };
}

/** The line every Web3 room carries: what the network is, and its "not launched" pill. */
export function Banner() {
  const { language } = usePreferences();
  const { t } = copy.forLocale(language);
  return (
    <p className="lt-hint">
      <span>{t('bannerLine')}</span> <Tag>{t('bannerPill')}</Tag>
    </p>
  );
}

/**
 * One tab of /chain, /dex or /protocol on the record-list template: what the room passes its template. The room's sections
 * go in the filters, the parked line heads the summary, and the tab's actions, each disabled with its first blocker, close
 * the list.
 */
export function useProtocolTab(slug: Slug, tab: string) {
  const { language } = usePreferences();
  const { t, renderedLocale } = copy.forLocale(language);
  const transport = useApi();
  const api = useMemo(() => createProtocolApi(transport), [transport]);
  const { chain, audit, indexer, dex, health } = useReads(api, slug);
  const snapshot: ProtocolSnapshot = {
    chain: toSource(chain),
    audit: toSource(audit),
    indexer: toSource(indexer),
    dex: toSource(dex),
    health: toSource(health),
  };
  const chainRef: ChainRef =
    chain.resource.status === 'ready'
      ? { status: 'ready', chainId: chain.resource.data.configuredChainId }
      : chain.resource.status === 'failed'
        ? { status: 'failed', failure: chain.resource.failure, reload: chain.reload }
        : { status: 'loading' };
  const room: TabRoomData = { t, api, transport, chain: chainRef, indexer, dex };
  const tabs = SUBNAV[slug];
  const actions = tabs.find((entry) => entry.id === tab)?.actions ?? [];
  return {
    room,
    /** The room's status reads themselves, for a tab that shows an answer whole (the chain status, the Protocol health). */
    reads: { chain, health },
    lang: renderedLocale,
    title: slug === 'chain' ? t('titleChain') : slug === 'dex' ? t('titleDex') : t('titleProtocol'),
    description: slug === 'chain' ? t('descChain') : slug === 'dex' ? t('descDex') : t('descProtocol'),
    sections: (
      <Tabs
        label={t('subnav')}
        items={tabs.map((entry) => entry.id)}
        value={tab}
        onChange={(id) => navigate(id === tabs[0]!.id ? `/${slug}` : `/${slug}/${id}`)}
        labels={Object.fromEntries(tabs.map((entry) => [entry.id, t(`tab_${entry.id}` as 'tab_status')]))}
      />
    ),
    actions: <Actions actions={actions} snapshot={snapshot} t={t} />,
  };
}
