import { useState, type ReactNode } from 'react';
import { navigate } from '../../../app/location';
import { Button, DataTable, EmptyState, Page, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { protocolCopy } from '../copy';
import { TabList } from './TabList';
import { tokensCopy, type TokensTranslate } from './copy';
import { addToWatchlist, readWatchlist } from './storage';
import '../protocol.css';
import './tokens.css';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
type Section = 'pairs' | 'holders' | 'trades';
const SECTIONS: readonly Section[] = ['pairs', 'holders', 'trades'];

function Blocked({ span, children }: { span: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={span}>
        <div role="status" data-blocker="indexer">
          <EmptyState title={children} />
        </div>
      </td>
    </tr>
  );
}

function Fact({ label, value, testId }: { label: string; value: ReactNode; testId?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd {...(testId ? { 'data-testid': testId } : {})}>{value}</dd>
    </div>
  );
}

function WatchButton({ address, t }: { address: string; t: TokensTranslate }) {
  const [list, setList] = useState<string[] | null>(() => readWatchlist());
  const on = list?.includes(address.toLowerCase()) ?? false;
  if (list === null) return <p className="muted">{t('watchUnavailable')}</p>;
  return (
    <div className="tokens-watch">
      <Button variant="secondary" disabled={on} onClick={() => setList(addToWatchlist(address))}>
        {on ? t('watchOn') : t('watchAdd')}
      </Button>
      <span className="muted">{t('watchNote')}</span>
    </div>
  );
}

function SectionBody({ section, t }: { section: Section; t: TokensTranslate }) {
  if (section === 'pairs') {
    const headers = [t('hdrPair'), t('hdrLiquidity'), t('hdrVolume')];
    return (
      <>
        <figure role="img" aria-label={t('priceChart')} className="tokens-chart">
          <figcaption>{t('chartEmpty')}</figcaption>
        </figure>
        <DataTable label={t('tab_pairs')} headers={headers}>
          <Blocked span={headers.length}>{t('factsBlocked')}</Blocked>
        </DataTable>
      </>
    );
  }
  if (section === 'holders') {
    const headers = [t('hdrHolder'), t('hdrAmount'), t('hdrShare')];
    return (
      <>
        <p>{t('holdersRule')}</p>
        <DataTable label={t('tab_holders')} headers={headers}>
          <Blocked span={headers.length}>{t('holdersBlocked')}</Blocked>
        </DataTable>
      </>
    );
  }
  const headers = [t('hdrTime'), t('hdrSide'), t('hdrAmount'), t('hdrPrice')];
  return (
    <DataTable label={t('tab_trades')} headers={headers}>
      <Blocked span={headers.length}>{t('tradesBlocked')}</Blocked>
    </DataTable>
  );
}

/**
 * A token's page (/dex/tokens/:address, D-portfolio-wallet-07 with D-launch-listing-02 and D-explorer-05): facts, trust,
 * pairs, holders and trades. Every figure needs a reader this build does not have, so each one reads "Not available" or
 * names its blocker; the trust tier reads "unknown" and the organic score "Not scored" rather than a guess.
 */
export function TokenPage({ address }: { address: string | undefined }) {
  const { language } = usePreferences();
  const { t, renderedLocale } = tokensCopy.forLocale(language);
  const room = protocolCopy.forLocale(language).t;
  const [section, setSection] = useState<Section>('pairs');
  const valid = address !== undefined && ADDRESS.test(address);
  return (
    <div className="legacy-room protocol-room tokens-room" lang={renderedLocale} data-route="tokenDetail">
      <Page
        title={valid ? t('pageTitle', { address }) : t('notFoundTitle')}
        eyebrow={
          <>
            <span>{room('bannerLine')}</span>
            <span className="badge protocol-pill">{room('bannerPill')}</span>
          </>
        }
        actions={valid ? <WatchButton address={address} t={t} /> : undefined}
      >
        {valid ? (
          <>
            <section aria-label={t('factsTitle')}>
              <Panel title={t('factsTitle')}>
                <dl className="protocol-facts">
                  <Fact label={t('factPrice')} value={t('notAvailable')} />
                  <Fact label={t('factLiquidity')} value={t('notAvailable')} />
                  <Fact label={t('factFees')} value={t('notAvailable')} />
                  <Fact label={t('factGrowth')} value={t('notAvailable')} />
                  <Fact label={t('factMarketCap')} value={t('notAvailable')} />
                </dl>
                <p className="muted" data-blocker="indexer">
                  {t('factsBlocked')} {t('marketCapNote')}
                </p>
              </Panel>
            </section>
            <section aria-label={t('trustTitle')}>
              <Panel title={t('trustTitle')}>
                <dl className="protocol-facts">
                  <Fact label={t('trustTier')} value={t('tierUnknown')} testId="token-trust-tier" />
                  <Fact label={t('organicScore')} value={t('notScored')} testId="token-organic-score" />
                  <Fact label={t('flags')} value={t('flagsNotChecked')} />
                </dl>
                <p className="muted">{t('tierNote')}</p>
                <p className="muted">{t('organicNote')}</p>
              </Panel>
            </section>
            <Panel title={t('tokenSections')}>
              <TabList
                label={t('tokenSections')}
                tabs={SECTIONS.map((id) => ({ id, label: t(`tab_${id}`) }))}
                value={section}
                onChange={setSection}
              >
                <SectionBody section={section} t={t} />
              </TabList>
            </Panel>
          </>
        ) : (
          <Panel title={t('notFoundTitle')}>
            <div data-code="protocol.not_found" role="status">
              <EmptyState title={t('notFoundBody')} />
            </div>
          </Panel>
        )}
        <Button variant="secondary" onClick={() => navigate('/dex/tokens')}>
          {t('back')}
        </Button>
      </Page>
    </div>
  );
}
