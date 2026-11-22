import { copy, t as copyText, Text } from './copy';
import { Page, Panel, EmptyState } from '../../shared/ui';
import { useSession } from '../session';
import { AcademyRoom } from './Academy';
import { academyRoute } from './academy-lms';
import { AcademyDiscussionListRoom, AcademyDiscussionThreadRoom } from './AcademyDiscussion';
import { AcademyCourseConversationRoom } from './AcademyCourseMessages';
import { AcademyCourseRoom } from './AcademyCourseRoom';
import { AcademyReaderRoom } from './academy-reader/AcademyReaderRoom';
import { Agents } from './Agents';
import { NewAgent, OwnAgentPage, OwnAgentTitle, ownAgentId } from './AgentBuilder';
import { agentBuilderCopy } from './agent-builder-copy';
import { AgentsTeam } from './AgentsTeam';
import { AgentApprovalsRoom } from './agent-approvals/AgentApprovalsRoom';
import { AgentConnect } from './AgentConnect';
import { agentConnectCopy } from './agent-connect-copy';
import { AgentRunPage, agentRunId } from './AgentRun';
import { agentsTeamCopy } from './agents-team-copy';
import { Blueprint } from './Blueprint';
import { BlueprintSharedRoom } from './BlueprintSharedCard';
import { Campaigns } from './Campaigns';
import { CampaignDetail } from './campaign-detail/CampaignDetailRoom';
import { campaignCatalogueCopy } from './campaign-catalogue-copy';
import { DropRoom } from './DropRoom';
import { Launch, Mining } from './AvailabilityRooms';
import type { LaunchTab } from './LaunchAvailability';
import type { MiningTab } from './MiningAvailability';
import { Market } from './Market';
import { MarketListingPage } from './MarketListingPage';
import { Prediction } from './Prediction';
import { PredictRoom } from './predict-room/PredictRoom';
import { quantRoute } from '../quant';
import { quantModeRoute } from './quant-mode-route';
import { Support } from './Support';
import { SupportChatRoom } from './SupportChat';
import { chatCopy } from './support-chat-copy';
import { Token, selectedFor, type TokenTab } from './Token';
import { TokenRoom } from './token-room/TokenRoom';
import { launchCopy } from './launch-copy';
import { LaunchDetail } from './LaunchCatalogue';
import { LaunchRoom } from './launch-room/LaunchRoom';
import { miningCopy } from './mining-copy';
import { MiningRoom } from './mining-room/MiningRoom';
import { predictionCatalogueCopy } from './prediction-catalogue-copy';
import { matchMoreRoute, type MoreRoomId } from './more-room-routes';
import { moreRoomRoutesCopy } from './more-room-routes-copy';
import { PaperRoom } from './paper-mode';
import { preservePaperHref } from './trade-context';
import { Fragment, type ReactNode } from 'react';
import { TokenProposalRoom } from './token-proposal/TokenProposalRoom';
import { LaunchRequirementsRoom } from './launch-requirements/LaunchRequirementsRoom';
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
  const quant =
    p === '/quant' || p.startsWith('/quant/') ? (quantRoute(p, paper, userId ?? null) ?? quantModeRoute(p, paper, userId ?? null)) : null;
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
  // A room drawn on its Volt template: it carries its own title, so it opens without the old page frame.
  let volt: ReactNode = undefined;
  const academy = p === '/academy' || p.startsWith('/academy/') ? academyRoute(p) : null;
  if (userId && academy?.kind === 'discussion' && academy.postId) {
    volt = <AcademyDiscussionThreadRoom key={academy.postId} courseSlug={academy.courseSlug} postId={academy.postId} />;
  } else if (userId && academy?.kind === 'discussion') {
    volt = <AcademyDiscussionListRoom key={academy.courseSlug} courseSlug={academy.courseSlug} />;
  } else if (userId && academy?.kind === 'messages' && academy.conversationId) {
    volt = <AcademyCourseConversationRoom key={academy.conversationId} conversationId={academy.conversationId} />;
  } else if (academy?.kind === 'reader' && academy.slug) {
    volt = (
      <AcademyReaderRoom
        key={`${p}:${url.search}`}
        slug={academy.slug}
        initialPath={url.searchParams.get('path') ?? undefined}
        signedIn={Boolean(userId)}
      />
    );
  } else if (academy?.kind === 'course') {
    volt = <AcademyCourseRoom key={`${p}:${url.search}`} slug={academy.slug} signedIn={Boolean(userId)} />;
  } else if (academy) {
    title = copyText('moreroutes.academy');
    description = copyText('moreroutes.learn.practise.and.join.hosted.sessions');
    content = (
      <AcademyRoom
        key={`${p}:${url.search}`}
        pathname={p}
        search={url.search}
        route={academy}
        slug={url.searchParams.get('slug') ?? undefined}
        initialPath={url.searchParams.get('path') ?? undefined}
      />
    );
    // The signed-in course-team inbox is on its Volt template; a signed-out visitor gets the public Academy.
    if (academy.kind === 'messages' && !academy.conversationId && userId) volt = content;
  } else if (p === '/agents') {
    title = copyText('moreroutes.agents');
    description = copyText('moreroutes.permissions.bounded.engine.sessions.and.your.activity');
    content = <Agents paper={paper} />;
  } else if (p === '/agents/connect') {
    title = <agentConnectCopy.Copy k="title" />;
    description = <agentConnectCopy.Copy k="description" />;
    content = <AgentConnect />;
  } else if (p === '/agents/new') {
    title = agentBuilderCopy.t('newAgent');
    content = <NewAgent />;
  } else if (agentRunId(p)) {
    const runId = agentRunId(p)!;
    volt = <AgentRunPage key={runId} runId={runId} />;
  } else if (ownAgentId(p)) {
    const id = ownAgentId(p)!;
    title = <OwnAgentTitle id={id} />;
    content = <OwnAgentPage key={id} id={id} />;
  } else if (p === '/agents/approvals') {
    volt = <AgentApprovalsRoom />;
  } else if (p === '/agents/team') {
    title = <agentsTeamCopy.Copy k="title" />;
    description = <agentsTeamCopy.Copy k="description" />;
    content = <AgentsTeam />;
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
    volt = <CampaignDetail key={p} campaignId={decodeURIComponent(p.slice('/campaigns/'.length))} />;
  } else if (p === '/campaigns/drops') {
    volt = <DropRoom />;
  } else if (p === '/launch') {
    room = 'launch';
    volt = <LaunchRoom paper={paper} />;
  } else if (p === '/uc/innovation/myorders') {
    room = 'launch';
    title = copyText('moreroutes.my.launch.orders');
    description = <launchCopy.Copy k="scope" />;
    content = <Launch orders />;
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
    volt = <PredictRoom />;
  } else if (p === '/mining') {
    room = 'mining';
    volt = <MiningRoom paper={paper} />;
  } else if (p === '/token') {
    room = 'token';
    title = copyText('moreroutes.token');
    description = copyText('moreroutes.exact.stake.records.access.and.governance');
    // With a proposal saved for this account, /token opens on governance, which is not this room: the old room draws it.
    if (selectedFor(userId ?? null)) content = <Token />;
    else volt = <TokenRoom paper={paper} />;
  } else if (quant && 'bare' in quant && quant.bare) {
    volt = quant.content;
  } else if (quant) {
    ({ title, description, content } = quant);
  } else if (p === '/support/chat') {
    title = <chatCopy.Copy k="pageTitle" />;
    description = <chatCopy.Copy k="pageDescription" />;
    content = <SupportChatRoom />;
  } else if (p === '/support' || p.startsWith('/support/')) {
    // The support desk is drawn on its reading template, with its own title for each of its addresses.
    volt = <Support path={p + url.search} />;
  } else {
    // A section or a record of one of the six rooms: /mining/workers, /market/:listingId and so on.
    const hit = matchMoreRoute(p);
    if (hit) {
      room = hit.route.room;
      const page = ROOM_PAGES[room];
      title = moreRoomRoutesCopy.t(hit.route.title);
      description = page.description();
      if (hit.route.pattern === '/launch/requirements') volt = <LaunchRequirementsRoom paper={paper} />;
      else if (hit.route.pattern === '/blueprint/shared/:cardId') volt = <BlueprintSharedRoom path={path} paper={paper} />;
      else if (hit.route.kind === 'detail' && room === 'token')
        volt = <TokenProposalRoom key={hit.id ?? 'invalid'} invalid={Boolean(hit.invalid)} paper={paper} />;
      else if (hit.route.kind === 'detail' && room === 'market' && hit.id && !hit.invalid)
        volt = <MarketListingPage key={hit.id} listingId={hit.id} />;
      else if (hit.route.kind === 'detail' && room === 'launch' && hit.id && !hit.invalid)
        volt = <LaunchDetail key={hit.id} eventId={hit.id} />;
      content =
        hit.route.kind === 'part' ? (
          page.content(path, paper)
        ) : room === 'launch' && hit.id && !hit.invalid ? (
          <LaunchDetail key={hit.id} eventId={hit.id} />
        ) : room === 'market' && hit.id && !hit.invalid ? (
          <MarketListingPage key={hit.id} listingId={hit.id} />
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
    const wrap = (node: ReactNode) => (
      <PaperRoom paper={paper} liveHref={live.pathname + live.search + live.hash}>
        {node}
      </PaperRoom>
    );
    content = wrap(content);
    if (volt) volt = wrap(volt);
  }
  if (volt) return <Fragment key={userId ?? 'anonymous'}>{volt}</Fragment>;
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
  launch: { new: 'Journey', check: 'Check', requirements: 'Requirements', mine: 'Participation' },
  token: { governance: 'Governance', economy: 'Economy', burn: 'Burn' },
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
