import { Tag } from '@intafaced/ui/lit';
import { ReadingTemplate, Tabs } from '@intafaced/ui/lit/templates';
import { launchCopy } from '../launch-copy';
import { launchDepthCopy } from '../launch-depth-copy';
import { launchCatalogueCopy } from '../launch-catalogue-copy';
import { moreRoomRoutesCopy } from '../more-room-routes-copy';
import { preservePaperHref } from '../trade-context';

/** The Launch room's sections, each at its own address (MoreRoutes' SECTION_TABS). */
const SECTIONS = [
  { href: '/launch', key: 'catalogue' },
  { href: '/launch/new', key: 'tabJourney' },
  { href: '/launch/check', key: 'tabCheck' },
  { href: '/launch/requirements', key: 'tabRequirements' },
  { href: '/launch/mine', key: 'tabParticipation' },
] as const;

/**
 * /launch/requirements on the reading template: what launching an asset needs, and why none of it can start here. It
 * shows no account data, so it opens signed out too. The Launch room's sections are links to their own addresses.
 */
export function LaunchRequirementsRoom({ paper }: { paper: boolean }) {
  const { t } = launchCopy.useCopy();
  const depth = launchDepthCopy.useCopy();
  const catalogue = launchCatalogueCopy.useCopy();
  const routes = moreRoomRoutesCopy.useCopy();
  return (
    <div data-room="launch-requirements">
      <ReadingTemplate
        title={routes.t('launchRequirements')}
        description={t('scope')}
        state={{ kind: 'ready' }}
        meta={
          <Tabs
            label={depth.t('sections')}
            current={preservePaperHref('/launch/requirements', paper)}
            items={SECTIONS.map((s) => ({
              href: preservePaperHref(s.href, paper),
              label: s.key === 'catalogue' ? catalogue.t('tabCatalogue') : depth.t(s.key),
            }))}
          />
        }
        body={<LaunchRequirements />}
      />
    </div>
  );
}

/**
 * No customer launch/participation contract is mounted. Keep each required capability explicit; Market access listings
 * do not fulfil asset listing. `orders`: the participation side's words (/uc/innovation/myorders).
 */
export function LaunchRequirements({ orders = false }: { orders?: boolean }) {
  const { Copy, t, languageFor, directionFor } = launchCopy.useCopy();
  return (
    <div lang={languageFor('launchUnavailable')} dir={directionFor('launchUnavailable')}>
      <Tabs
        label={t('nav')}
        // Neither link is the page this is drawn on: the overview and participation are their own addresses.
        current=""
        items={[
          { label: t('overview'), href: '/launch' },
          { label: t('participation'), href: '/uc/innovation/myorders' },
        ]}
      />
      <section>
        <h2>
          <Copy k={orders ? 'ordersUnavailable' : 'launchUnavailable'} />
        </h2>
        <p>
          <Copy k={orders ? 'ordersBody' : 'launchBody'} />
        </p>
        <a className="lt-button lt-button-primary" href="/support">
          <Copy k="support" />
        </a>
        <section>
          <h3>
            <Copy k="required" />
          </h3>
          <dl className="lt-kv">
            {(['issuance', 'listing', 'sale'] as const).map((key) => (
              <div key={key}>
                <dt>
                  <Copy k={key} />{' '}
                  <Tag tone="neutral">
                    <Copy k="unavailable" />
                  </Tag>
                </dt>
                <dd>
                  <Copy k={key === 'issuance' ? 'issuanceBody' : key === 'listing' ? 'listingBody' : 'saleBody'} />
                </dd>
              </div>
            ))}
          </dl>
          <details>
            <summary>
              <Copy k="details" />
            </summary>
            <p>
              <Copy k="detailsBody" />
            </p>
          </details>
        </section>
      </section>
      <aside>
        <section>
          <h3>
            <Copy k={orders ? 'returnTitle' : 'history'} />
          </h3>
          <p>
            <Copy k={orders ? 'returnBody' : 'historyBody'} />
          </p>
          <a className="lt-link lt-link-alone" href={orders ? '/launch' : '/uc/innovation/myorders'}>
            <Copy k={orders ? 'returnLink' : 'historyLink'} />
          </a>
        </section>
        <section>
          <h3>
            <Copy k="market" />
          </h3>
          <p>
            <Copy k="marketBody" />
          </p>
          <a className="lt-link lt-link-alone" href="/market/mine">
            <Copy k="marketLink" />
          </a>
        </section>
      </aside>
    </div>
  );
}
