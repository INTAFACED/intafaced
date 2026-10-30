import { useState } from 'react';
import { SubNav } from '@intafaced/ui';
import { Tabs } from '../../shared/ui';
import { launchCopy } from './launch-copy';
import { launchDepthCopy } from './launch-depth-copy';
import { LaunchCheck, LaunchJourney, LaunchParticipation } from './LaunchRooms';
import { LaunchCatalogue } from './LaunchCatalogue';
import { launchCatalogueCopy } from './launch-catalogue-copy';
import './launch-availability.css';

export type LaunchTab = 'Catalogue' | 'Journey' | 'Check' | 'Requirements' | 'Participation';
const TABS: readonly LaunchTab[] = ['Catalogue', 'Journey', 'Check', 'Requirements', 'Participation'];
/** The published launches, issuer journey, pre-listing check, requirements and participation. `tab`: the section an address such as /launch/check opens on. */
export function Launch({ orders = false, tab: first }: { orders?: boolean; tab?: LaunchTab }) {
  const [tab, setTab] = useState<LaunchTab>(first ?? (orders ? 'Participation' : 'Catalogue'));
  const { t } = launchDepthCopy.useCopy();
  const catalogue = launchCatalogueCopy.useCopy();
  return (
    <div className="more-grid">
      <Tabs
        items={TABS}
        value={tab}
        onChange={(value) => setTab(value as LaunchTab)}
        label={t('sections')}
        labels={{
          Catalogue: catalogue.t('tabCatalogue'),
          Journey: t('tabJourney'),
          Check: t('tabCheck'),
          Requirements: t('tabRequirements'),
          Participation: t('tabParticipation'),
        }}
      />
      {tab === 'Catalogue' ? (
        <LaunchCatalogue />
      ) : tab === 'Journey' ? (
        <LaunchJourney onTab={setTab} />
      ) : tab === 'Check' ? (
        <LaunchCheck />
      ) : tab === 'Participation' ? (
        <LaunchParticipation />
      ) : (
        <LaunchRequirements orders={false} />
      )}
    </div>
  );
}

/** No customer launch/participation contract is mounted. Keep each required
 * capability explicit; Market access listings do not fulfill asset listing. */
function LaunchRequirements({ orders = false }: { orders?: boolean }) {
  const { Copy, t, languageFor, directionFor } = launchCopy.useCopy();
  return (
    <div className="launch-room" lang={languageFor('launchUnavailable')} dir={directionFor('launchUnavailable')}>
      <SubNav
        aria-label={t('nav')}
        active={orders ? 'participation' : 'overview'}
        className="px-0"
        items={[
          { id: 'overview', label: t('overview'), href: '/launch' },
          { id: 'participation', label: t('participation'), href: '/uc/innovation/myorders' },
        ]}
      />
      <div className="launch-room-workspace">
        <section className="launch-room-primary">
          <div className="launch-room-status">
            <h2>
              <Copy k={orders ? 'ordersUnavailable' : 'launchUnavailable'} />
            </h2>
            <p className="muted">
              <Copy k={orders ? 'ordersBody' : 'launchBody'} />
            </p>
          </div>
          <a className="button button--primary launch-room-support" href="/support">
            <Copy k="support" />
          </a>
          <section>
            <h3 className="launch-room-required">
              <Copy k="required" />
            </h3>
            <dl className="launch-room-requirements">
              {(['issuance', 'listing', 'sale'] as const).map((key) => (
                <div key={key}>
                  <dt>
                    <span>
                      <Copy k={key} />
                    </span>
                    <span className="launch-room-state">
                      <Copy k="unavailable" />
                    </span>
                  </dt>
                  <dd>
                    <Copy k={key === 'issuance' ? 'issuanceBody' : key === 'listing' ? 'listingBody' : 'saleBody'} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </section>
        <aside className="launch-room-aside">
          <section>
            <div className="launch-room-side-copy">
              <h3>
                <Copy k={orders ? 'returnTitle' : 'history'} />
              </h3>
              <p className="muted">
                <Copy k={orders ? 'returnBody' : 'historyBody'} />
              </p>
            </div>
            <a className="text-link launch-room-link" href={orders ? '/launch' : '/uc/innovation/myorders'}>
              <Copy k={orders ? 'returnLink' : 'historyLink'} />
            </a>
          </section>
          <section className="launch-room-market">
            <div className="launch-room-side-copy">
              <h3>
                <Copy k="market" />
              </h3>
              <p className="muted">
                <Copy k="marketBody" />
              </p>
            </div>
            <a className="text-link launch-room-link" href="/market/mine">
              <Copy k="marketLink" />
            </a>
          </section>
          <details className="launch-room-details">
            <summary>
              <Copy k="details" />
            </summary>
            <p className="muted">
              <Copy k="detailsBody" />
            </p>
          </details>
        </aside>
      </div>
    </div>
  );
}
