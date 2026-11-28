// volt-room: /launch/mine
// volt-room: /uc/innovation/myorders
import { Select, Tag } from '@intafaced/ui/lit';
import { RecordListTemplate, Tabs } from '@intafaced/ui/lit/templates';
import { useSession } from '../../session';
import { t as copyText } from '../copy';
import { launchCatalogueCopy } from '../launch-catalogue-copy';
import { launchCopy } from '../launch-copy';
import { launchDepthCopy } from '../launch-depth-copy';
import { moreRoomRoutesCopy } from '../more-room-routes-copy';
import { SessionRetryNote, SignInNote } from '../sign-in-note';
import { preservePaperHref } from '../trade-context';
import { EmptyNote, ScrollTable, Section } from '../volt-parts';

/** The Launch room's sections, each at its own address (MoreRoutes' SECTION_TABS). */
const SECTIONS = [
  { href: '/launch', key: 'catalogue' },
  { href: '/launch/new', key: 'tabJourney' },
  { href: '/launch/check', key: 'tabCheck' },
  { href: '/launch/requirements', key: 'tabRequirements' },
  { href: '/launch/mine', key: 'tabParticipation' },
] as const;

/**
 * `/launch/mine` and `/uc/innovation/myorders` on the record-list template: the customer's launch participation records
 * and honest blocker state. Private to a signed-in account: signed out shows the shared sign-in panel returning here.
 */
export function LaunchMineRoom({ paper, orders = false }: { paper: boolean; orders?: boolean }) {
  const { t: scopeT } = launchCopy.useCopy();
  const { Copy, t } = launchDepthCopy.useCopy();
  const catalogue = launchCatalogueCopy.useCopy();
  const routes = moreRoomRoutesCopy.useCopy();
  const { userId, restoreFailed, retryRestore } = useSession();

  return (
    <RecordListTemplate
      title={orders ? copyText('moreroutes.my.launch.orders') : routes.t('myLaunches')}
      description={scopeT('scope')}
      state={{ kind: 'ready' }}
      filters={
        <Tabs
          label={t('sections')}
          current={preservePaperHref('/launch/mine', paper)}
          items={SECTIONS.map((s) => ({
            href: preservePaperHref(s.href, paper),
            label: s.key === 'catalogue' ? catalogue.t('tabCatalogue') : t(s.key),
          }))}
        />
      }
      list={
        !userId ? (
          restoreFailed ? (
            <SessionRetryNote retry={retryRestore} />
          ) : (
            <SignInNote returnTo={orders ? '/uc/innovation/myorders' : '/launch/mine'} />
          )
        ) : (
          <Section title={t('participationTitle')} className="lt-stack">
            <p className="lt-muted">
              <Copy k="participationBody" />
            </p>
            <div className="lt-toolbar">
              <Select label={t('filterRound')} value="" onChange={() => undefined} options={[{ value: '', label: t('filterAny') }]} />
              <Select label={t('filterStatus')} value="" onChange={() => undefined} options={[{ value: '', label: t('filterAny') }]} />
            </div>
            <EmptyNote title={<Copy k="participationUnavailable" />}>
              <Tag tone="neutral">
                <Copy k="modeBlocked" />
              </Tag>{' '}
              <Copy k="participationBlocker" />
            </EmptyNote>
            <ScrollTable headers={[t('colRound'), t('colSubscribed'), t('colAllocated'), t('colStatus')]} label={t('participationTitle')}>
              <tr>
                <td colSpan={4}>
                  <Copy k="participationUnavailable" />
                </td>
              </tr>
            </ScrollTable>
          </Section>
        )
      }
    />
  );
}
