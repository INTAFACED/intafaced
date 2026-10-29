import { useState, type ReactNode } from 'react';
import { navigate } from '../../../app/location';
import { Button, DataTable, EmptyState, Page, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { protocolCopy } from '../copy';
import { ADDRESS_SHAPE } from '../routes';
import { BlockedRow } from './BlockedRow';
import { TabList } from './TabList';
import { useSession } from '../../session/session';
import { useAccountTokenWatchlist, type ListWrite } from '../watch/account-lists';
import { tokensCopy, type TokensTranslate } from './copy';
import { addToWatchlist, readWatchlist, removeFromWatchlist, type WatchlistWrite } from './storage';
import '../protocol.css';
import './tokens.css';

type Section = 'pairs' | 'holders' | 'trades';
const SECTIONS: readonly Section[] = ['pairs', 'holders', 'trades'];

function Fact({ label, value, testId }: { label: string; value: ReactNode; testId?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd {...(testId ? { 'data-testid': testId } : {})}>{value}</dd>
    </div>
  );
}

function WatchToggle({
  on,
  busy = false,
  note,
  onAdd,
  onRemove,
  t,
}: {
  on: boolean;
  busy?: boolean;
  note: ReactNode;
  onAdd: () => void;
  onRemove: () => void;
  t: TokensTranslate;
}) {
  return (
    <div className="tokens-watch">
      {on ? (
        <Button variant="secondary" aria-pressed="true" title={t('watchRemove')} disabled={busy} onClick={onRemove}>
          {t('watchOn')}
        </Button>
      ) : (
        <Button variant="secondary" disabled={busy} onClick={onAdd}>
          {t('watchAdd')}
        </Button>
      )}
      {note}
    </div>
  );
}

/** Signed out, the watchlist is kept in this browser. */
function BrowserWatch({ address, t }: { address: string; t: TokensTranslate }) {
  const [list, setList] = useState<string[] | null>(() => readWatchlist());
  const [problem, setProblem] = useState<'not_saved' | 'full' | null>(null);
  if (list === null) return <p className="muted">{t('watchUnavailable')}</p>;
  const change = (write: WatchlistWrite) => {
    if (write.ok) setList(write.list);
    else if (write.reason === 'blocked') setList(null);
    setProblem(!write.ok && write.reason !== 'blocked' ? write.reason : null);
  };
  return (
    <WatchToggle
      on={list.includes(address.toLowerCase())}
      onAdd={() => change(addToWatchlist(address))}
      onRemove={() => change(removeFromWatchlist(address))}
      note={
        <span className="muted" role={problem ? 'alert' : undefined}>
          {problem === 'full' ? t('watchFull') : problem ? t('watchNotSaved') : t('watchNote')}
        </span>
      }
      t={t}
    />
  );
}

const ACCOUNT_PROBLEM: Record<Exclude<ListWrite, 'saved'>, 'watchAccountNotSaved' | 'watchFull' | 'watchUnknown'> = {
  'not-saved': 'watchAccountNotSaved',
  full: 'watchFull',
  unknown: 'watchUnknown',
};

/** Signed in, the watchlist is the account's own (`protocol.token-watchlist`), so it follows the person to every device. */
function AccountWatch({ address, t }: { address: string; t: TokensTranslate }) {
  const { list, change } = useAccountTokenWatchlist();
  const [outcome, setOutcome] = useState<ListWrite | 'saving' | null>(null);
  if (list.status === 'signed-out') return null;
  if (list.status === 'loading')
    return (
      <div className="tokens-watch">
        <Button variant="secondary" disabled>
          {t('watchAdd')}
        </Button>
        <span className="muted">{t('watchAccountChecking')}</span>
      </div>
    );
  if (list.status === 'failed')
    return (
      <div className="tokens-watch">
        <span className="muted">{t('watchAccountFailed')}</span>
        <Button variant="secondary" onClick={list.reload}>
          {t('tryAgain')}
        </Button>
      </div>
    );
  const key = address.toLowerCase();
  const write = async (apply: (items: string[]) => string[]) => {
    setOutcome('saving');
    setOutcome(await change(apply));
  };
  const problem = outcome && outcome !== 'saving' && outcome !== 'saved' ? ACCOUNT_PROBLEM[outcome] : null;
  return (
    <WatchToggle
      on={list.items.includes(key)}
      busy={outcome === 'saving'}
      onAdd={() => void write((items) => (items.includes(key) ? items : [...items, key]))}
      onRemove={() => void write((items) => items.filter((entry) => entry !== key))}
      note={
        <span className="muted" role={problem ? 'alert' : undefined}>
          {problem ? t(problem) : t('watchNoteAccount')}
        </span>
      }
      t={t}
    />
  );
}

function WatchButton({ address, t }: { address: string; t: TokensTranslate }) {
  const { userId } = useSession();
  return userId ? <AccountWatch address={address} t={t} /> : <BrowserWatch address={address} t={t} />;
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
          <BlockedRow span={headers.length}>{t('factsBlocked')}</BlockedRow>
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
          <BlockedRow span={headers.length}>{t('holdersBlocked')}</BlockedRow>
        </DataTable>
      </>
    );
  }
  const headers = [t('hdrTime'), t('hdrSide'), t('hdrAmount'), t('hdrPrice')];
  return (
    <DataTable label={t('tab_trades')} headers={headers}>
      <BlockedRow span={headers.length}>{t('tradesBlocked')}</BlockedRow>
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
  const valid = address !== undefined && ADDRESS_SHAPE.test(address);
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
