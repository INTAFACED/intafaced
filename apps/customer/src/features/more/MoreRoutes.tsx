import { copy, t as copyText, Text } from './copy';
import { Page, Panel, EmptyState } from '../../shared/ui';
import { useSession } from '../session/session';
import { Academy } from './Academy';
import { Agents } from './Agents';
import { Blueprint } from './Blueprint';
import { Campaigns } from './Campaigns';
import { Launch, Mining } from './AvailabilityRooms';
import { Market } from './Market';
import { Prediction } from './Prediction';
import { quantRoute } from '../quant/QuantRoutes';
import { Support } from './Support';
import { Token } from './Token';
import { launchCopy } from './launch-copy';
import { miningCopy } from './mining-copy';
import { predictionCatalogueCopy } from './prediction-catalogue-copy';
import { matchMoreRoute, type MoreRoomId } from './more-room-routes';
import { moreRoomRoutesCopy } from './more-room-routes-copy';
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
  if (p === '/academy' || p.startsWith('/academy/')) {
    title = copyText('moreroutes.academy');
    description = copyText('moreroutes.learn.practise.and.join.hosted.sessions');
    let slug = url.searchParams.get('slug') ?? undefined;
    try {
      if (p.split('/')[2]) slug = decodeURIComponent(p.split('/')[2]!);
    } catch {
      slug = undefined;
    }
    content = <Academy key={`${p}:${url.search}`} slug={slug} initialPath={url.searchParams.get('path') ?? undefined} />;
  } else if (p === '/agents') {
    title = copyText('moreroutes.agents');
    description = copyText('moreroutes.permissions.bounded.engine.sessions.and.your.activity');
    content = <Agents paper={paper} />;
  } else if (p === '/blueprint') {
    title = copyText('moreroutes.identity.blueprint');
    description = copyText('moreroutes.a.profile.you.can.keep.private.share');
    content = <Blueprint path={path} />;
  } else if (p === '/campaigns') {
    title = copyText('moreroutes.campaigns');
    description = copyText('moreroutes.your.campaign.participation');
    content = <Campaigns />;
  } else if (p === '/launch' || p === '/uc/innovation/myorders') {
    title = p === '/launch' ? copyText('moreroutes.launch') : copyText('moreroutes.my.launch.orders');
    description = <launchCopy.Copy k="scope" />;
    content = <Launch orders={p !== '/launch'} />;
  } else if (p === '/market' || p === '/market/mine' || p === '/market/strategy') {
    title =
      p === '/market'
        ? copyText('moreroutes.market')
        : p === '/market/mine'
          ? copyText('moreroutes.my.listings')
          : copyText('moreroutes.strategy.subscriptions');
    description = copyText('moreroutes.published.catalogue.terms.and.your.seller.workspace');
    content = <Market key={p} mine={p === '/market/mine'} strategy={p === '/market/strategy'} />;
  } else if (p === '/predict') {
    title = copyText('moreroutes.prediction');
    description = <predictionCatalogueCopy.Copy k="scope" />;
    content = <Prediction />;
  } else if (p === '/mining') {
    title = copyText('moreroutes.mining');
    description = <miningCopy.Copy k="scope" />;
    content = <Mining />;
  } else if (p === '/token') {
    title = copyText('moreroutes.token');
    description = copyText('moreroutes.exact.stake.records.access.and.governance');
    content = <Token />;
  } else if ((p === '/quant' || p.startsWith('/quant/')) && quantRoute(p, paper, userId ?? null)) {
    ({ title, description, content } = quantRoute(p, paper, userId ?? null)!);
  } else if (p === '/support') {
    title = copyText('moreroutes.support');
    description = copyText('moreroutes.help.requests.and.your.conversation.with.the');
    content = <Support />;
  } else {
    // A section or a record of one of the six rooms: /mining/workers, /market/:listingId and so on.
    const hit = matchMoreRoute(p);
    if (hit) {
      const room = ROOM_PAGES[hit.route.room];
      title = moreRoomRoutesCopy.t(hit.route.title);
      description = room.description();
      content =
        hit.route.kind === 'part' ? (
          room.content(path, paper)
        ) : (
          <Panel title={moreRoomRoutesCopy.t(hit.invalid ? 'badIdTitle' : 'detailTitle')}>
            <EmptyState title={moreRoomRoutesCopy.t(hit.invalid ? 'badIdTitle' : 'detailTitle')}>
              {moreRoomRoutesCopy.t(hit.invalid ? 'badIdBody' : 'detailBody')}
            </EmptyState>
            <a className="text-link" href={room.href}>
              {moreRoomRoutesCopy.t('open')}
            </a>
          </Panel>
        );
    }
  }
  return (
    <div className="more-feature">
      <Page
        key={userId ?? 'anonymous'}
        eyebrow={p === '/support' ? undefined : copyText('moreroutes.more')}
        title={title}
        description={description}
      >
        {content}
      </Page>
    </div>
  );
}

/** The room each section opens inside, and the line under its title; a section shows its room until the slice that owns it fills it. */
const ROOM_PAGES: Record<MoreRoomId, { href: string; description: () => ReactNode; content: (path: string, paper: boolean) => ReactNode }> =
  {
    predict: { href: '/predict', description: () => <predictionCatalogueCopy.Copy k="scope" />, content: () => <Prediction /> },
    market: {
      href: '/market',
      description: () => copyText('moreroutes.published.catalogue.terms.and.your.seller.workspace'),
      content: () => <Market key="purchases" mine={false} strategy={false} />,
    },
    launch: { href: '/launch', description: () => <launchCopy.Copy k="scope" />, content: () => <Launch orders={false} /> },
    token: {
      href: '/token',
      description: () => copyText('moreroutes.exact.stake.records.access.and.governance'),
      content: () => <Token />,
    },
    mining: { href: '/mining', description: () => <miningCopy.Copy k="scope" />, content: () => <Mining /> },
    blueprint: {
      href: '/blueprint',
      description: () => copyText('moreroutes.a.profile.you.can.keep.private.share'),
      content: (path) => <Blueprint path={path} />,
    },
  };
