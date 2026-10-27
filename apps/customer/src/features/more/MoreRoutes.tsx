import { copy, t as copyText, Text } from './copy';
import { Page, Panel, EmptyState } from '../../shared/ui';
import { useSession } from '../session/session';
import { AcademyRoom } from './Academy';
import { academyRoute } from './academy-lms';
import { Agents } from './Agents';
import { Blueprint } from './Blueprint';
import { Campaigns } from './Campaigns';
import { CampaignDetail } from './campaign-catalogue';
import { campaignCatalogueCopy } from './campaign-catalogue-copy';
import { DropRoom } from './DropRoom';
import { Launch, Mining } from './AvailabilityRooms';
import type { LaunchTab } from './LaunchAvailability';
import type { MiningTab } from './MiningAvailability';
import { Market } from './Market';
import { Prediction } from './Prediction';
import { quantRoute } from '../quant/QuantRoutes';
import { Support, supportPageTitleKey } from './Support';
import { supportRoute } from './support-desk';
import { deskCopy } from './support-desk-copy';
import { Token, type TokenTab } from './Token';
import { launchCopy } from './launch-copy';
import { miningCopy } from './mining-copy';
import { predictionCatalogueCopy } from './prediction-catalogue-copy';
import { matchMoreRoute, type MoreRoomId } from './more-room-routes';
import { moreRoomRoutesCopy } from './more-room-routes-copy';
import { PaperRoom } from './paper-mode';
import { preservePaperHref } from './trade-context';
import type { ReactNode } from 'react';
import './more.css';
export function MoreRoutes({ path }: { path: string }) {
  const { languageFor } = copy.useCopy();
  return (
    <div lang={languageFor('moreroutes.more')} style={{ display: 'contents' }}>
      <MoreRooms path={path} />
    </div>
  );
}
function MoreRooms({ path }: { path: string }) {
  const { userId } = useSession();
  const url = new URL(path, location.origin),
    p = url.pathname;
  const paper = url.searchParams.get('simulated') === 'true';
  const quant = p === '/quant' || p.startsWith('/quant/') ? quantRoute(p, paper, userId ?? null) : null;
  let title: ReactNode = copyText('moreroutes.more'),
    description: ReactNode = undefined,
    content: ReactNode = (
      <Panel title={copyText('moreroutes.more.destination.unavailable')}>
        <EmptyState title={copyText('moreroutes.this.destination.has.no.customer.route')}>
          <Text k="moreroutes.use.a.published.more.room.to.continue" />
        </EmptyState>
        <a className="text-link" href="/more">
          <Text k="moreroutes.open.more" />
        </a>
      </Panel>
    );
  // Set when the path is one of the six rooms of the set, so `?simulated=true` labels it and refuses its actions.
  let room: MoreRoomId | undefined;
  if (p === '/academy' || p.startsWith('/academy/')) {
    title = copyText('moreroutes.academy');
    description = copyText('moreroutes.learn.practise.and.join.hosted.sessions');
    content = (
      <AcademyRoom
        key={`${p}:${url.search}`}
        pathname={p}
        search={url.search}
        route={academyRoute(p)}
        slug={url.searchParams.get('slug') ?? undefined}
        initialPath={url.searchParams.get('path') ?? undefined}
      />
    );
  } else if (p === '/agents') {
    title = copyText('moreroutes.agents');
    description = copyText('moreroutes.permissions.bounded.engine.sessions.and.your.activity');
    content = <Agents paper={paper} />;
  } else if (p === '/blueprint') {
    room = 'blueprint';
    title = copyText('moreroutes.identity.blueprint');
    description = copyText('moreroutes.a.profile.you.can.keep.private.share');
    content = <Blueprint path={path} />;
  } else if (p === '/campaigns') {
    title = copyText('moreroutes.campaigns');
    description = copyText('moreroutes.your.campaign.participation');
    content = <Campaigns />;
  } else if (p === '/campaigns/mine') {
    title = <campaignCatalogueCopy.Copy k="myCampaigns" />;
    description = <campaignCatalogueCopy.Copy k="mineTitle" />;
    content = <Campaigns initial="Mine" />;
  } else if (/^\/campaigns\/cmp_[A-Za-z0-9-]+$/.test(p)) {
    title = <campaignCatalogueCopy.Copy k="detailTitle" />;
    content = <CampaignDetail key={p} campaignId={decodeURIComponent(p.slice('/campaigns/'.length))} />;
  } else if (p === '/campaigns/drops') {
    title = copyText('moreroutes.drop.room');
    description = copyText('moreroutes.drop.room.description');
    content = <DropRoom />;
  } else if (p === '/launch' || p === '/uc/innovation/myorders') {
    room = 'launch';
    title = p === '/launch' ? copyText('moreroutes.launch') : copyText('moreroutes.my.launch.orders');
    description = <launchCopy.Copy k="scope" />;
    content = <Launch orders={p !== '/launch'} />;
  } else if (p === '/market' || p === '/market/mine' || p === '/market/strategy') {
    room = 'market';
    title =
      p === '/market'
        ? copyText('moreroutes.market')
        : p === '/market/mine'
          ? copyText('moreroutes.my.listings')
          : copyText('moreroutes.strategy.subscriptions');
    description = copyText('moreroutes.published.catalogue.terms.and.your.seller.workspace');
    content = <Market key={p} mine={p === '/market/mine'} strategy={p === '/market/strategy'} />;
  } else if (p === '/predict') {
    room = 'predict';
    title = copyText('moreroutes.prediction');
    description = <predictionCatalogueCopy.Copy k="scope" />;
    content = <Prediction />;
  } else if (p === '/mining') {
    room = 'mining';
    title = copyText('moreroutes.mining');
    description = <miningCopy.Copy k="scope" />;
    content = <Mining />;
  } else if (p === '/token') {
    room = 'token';
    title = copyText('moreroutes.token');
    description = copyText('moreroutes.exact.stake.records.access.and.governance');
    content = <Token />;
  } else if (quant) {
    ({ title, description, content } = quant);
  } else if (p === '/support' || p.startsWith('/support/')) {
    const key = supportPageTitleKey(supportRoute(p, url.search));
    title = key ? <deskCopy.Copy k={key} /> : copyText('moreroutes.support');
    description = copyText('moreroutes.help.requests.and.your.conversation.with.the');
    content = <Support path={p + url.search} />;
  } else {
    // A section or a record of one of the six rooms: /mining/workers, /market/:listingId and so on.
    const hit = matchMoreRoute(p);
    if (hit) {
      room = hit.route.room;
      const page = ROOM_PAGES[room];
      title = moreRoomRoutesCopy.t(hit.route.title);
      description = page.description();
      content =
        hit.route.kind === 'part' ? (
          page.content(path, paper)
        ) : (
          <Panel title={moreRoomRoutesCopy.t(hit.invalid ? 'badIdTitle' : 'detailTitle')}>
            <EmptyState title={moreRoomRoutesCopy.t(hit.invalid ? 'badIdTitle' : 'detailTitle')}>
              {moreRoomRoutesCopy.t(hit.invalid ? 'badIdBody' : 'detailBody')}
            </EmptyState>
            <a className="text-link" href={preservePaperHref(page.href, paper)}>
              {moreRoomRoutesCopy.t('open')}
            </a>
          </Panel>
        );
    }
  }
  if (room) {
    const live = new URL(url);
    live.searchParams.delete('simulated');
    content = (
      <PaperRoom paper={paper} liveHref={live.pathname + live.search + live.hash}>
        {content}
      </PaperRoom>
    );
  }
  return (
    <div className="more-feature">
      <Page
        key={userId ?? 'anonymous'}
        eyebrow={p === '/support' || p.startsWith('/support/') ? undefined : copyText('moreroutes.more')}
        title={title}
        description={description}
      >
        {content}
      </Page>
    </div>
  );
}

/** The second segment of a room address: "workers" for /mining/workers. */
const section = (path: string) => (path.split(/[?#]/)[0] ?? '').split('/')[2] ?? '';
/** The tab each section's own address opens its room on, so /mining/workers is not the same page as /mining (Phantom 24 Oct). */
export const SECTION_TABS: { launch: Record<string, LaunchTab>; token: Record<string, TokenTab>; mining: Record<string, MiningTab> } = {
  launch: { new: 'Journey', check: 'Check', requirements: 'Requirements' },
  token: { governance: 'Governance', economy: 'Economy' },
  mining: { workers: 'Workers', shares: 'Shares', rewards: 'Rewards', status: 'Status' },
};

/** The room each section opens inside, and the line under its title; a section shows its room until the slice that owns it fills it. */
const ROOM_PAGES: Record<MoreRoomId, { href: string; description: () => ReactNode; content: (path: string, paper: boolean) => ReactNode }> =
  {
    predict: { href: '/predict', description: () => <predictionCatalogueCopy.Copy k="scope" />, content: () => <Prediction /> },
    market: {
      href: '/market',
      description: () => copyText('moreroutes.published.catalogue.terms.and.your.seller.workspace'),
      content: () => <Market key="purchases" mine={false} strategy={false} />,
    },
    launch: {
      href: '/launch',
      description: () => <launchCopy.Copy k="scope" />,
      content: (path) => <Launch key={section(path)} orders={false} tab={SECTION_TABS.launch[section(path)]} />,
    },
    token: {
      href: '/token',
      description: () => copyText('moreroutes.exact.stake.records.access.and.governance'),
      content: (path) => <Token key={section(path)} tab={SECTION_TABS.token[section(path)]} />,
    },
    mining: {
      href: '/mining',
      description: () => <miningCopy.Copy k="scope" />,
      content: (path) => <Mining key={section(path)} tab={SECTION_TABS.mining[section(path)]} />,
    },
    blueprint: {
      href: '/blueprint',
      description: () => copyText('moreroutes.a.profile.you.can.keep.private.share'),
      content: (path) => <Blueprint path={path} />,
    },
  };
