import { copy, t as copyText, Text } from './copy';
import { Page, Panel, EmptyState } from '../../shared/ui';
import { useSession } from '../session';
import { AcademyRoom } from './Academy';
import { academyRoute, academySectionRedirect } from './academy-lms';
import { AcademyLearningRoom } from './academy-catalogue/AcademyLearningRoom';
import { AcademyRoomsRoom } from './academy-catalogue/AcademyRoomsRoom';
import { AcademyCertificatesRoom } from './academy-catalogue/AcademyCertificatesRoom';
import { AcademyVideosRoom } from './academy-catalogue/AcademyVideosRoom';
import { AcademyProgrammesRoom } from './academy-catalogue/AcademyProgrammesRoom';
import { AcademyProgrammeRoom } from './academy-catalogue/AcademyProgrammeRoom';
import { AcademyDiscussionListRoom, AcademyDiscussionThreadRoom } from './AcademyDiscussion';
import { AcademyCourseConversationRoom } from './AcademyCourseMessages';
import { AcademyCourseRoom } from './AcademyCourseRoom';
import { AcademyAssignmentRoom } from './academy-assignment/AcademyAssignmentRoom';
import { AcademyVerifyRoom } from './academy-verify/AcademyVerifyRoom';
import { AcademyReaderRoom } from './academy-reader/AcademyReaderRoom';
import { AcademyProgressRoom } from './academy-progress/AcademyProgressRoom';
import { AgentsRoom } from './agents-room/AgentsRoom';
import { OwnAgentRoom } from './agent-room/OwnAgentRoom';
import { NewAgent, ownAgentId } from './AgentBuilder';
import { AgentsTeam } from './AgentsTeam';
import { AgentApprovalsRoom } from './agent-approvals/AgentApprovalsRoom';
import { AgentConnect } from './AgentConnect';
import { AgentRunPage, agentRunId } from './AgentRun';
import { agentRunCopy } from './agent-run-copy';
import { Blueprint } from './Blueprint';
import { BlueprintSharedRoom } from './BlueprintSharedCard';
import { BlueprintRoom } from './blueprint-room/BlueprintRoom';
import { Campaigns, CampaignsRoom } from './Campaigns';
import { CampaignDetail } from './campaign-detail/CampaignDetailRoom';
import { campaignCatalogueCopy } from './campaign-catalogue-copy';
import { DropRoom } from './DropRoom';
import { Launch, Mining } from './AvailabilityRooms';
import type { LaunchTab } from './LaunchAvailability';
import type { MiningTab } from './MiningAvailability';
import { Market } from './Market';
import { MarketRoom } from './market-room/MarketRoom';
import { MarketStrategyRoom } from './market-strategy/MarketStrategyRoom';
import { MarketListingPage } from './MarketListingPage';
import { Prediction } from './Prediction';
import { PredictRoom } from './predict-room/PredictRoom';
import { PredictSettingsRoom } from './predict-settings/PredictSettingsRoom';
import { quantRoute } from '../quant';
import { quantModeRoute } from './quant-mode-route';
import { Support } from './Support';
import { SupportChatRoom } from './SupportChat';
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
import { LaunchCheckRoom } from './launch-flow/LaunchCheckRoom';
import { LaunchNewRoom } from './launch-flow/LaunchNewRoom';
import { LaunchRequirementsRoom } from './launch-requirements/LaunchRequirementsRoom';
import { TokenEconomyRoom } from './token-economy/TokenEconomyRoom';
import { MiningStatusRoom } from './mining-section/MiningStatusRoom';
import { MiningWorkerRoom } from './mining-section/MiningWorkerRoom';
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
        <a className="lt-link" href="/more">
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
  } else if (userId && academy?.kind === 'progress') {
    volt = <AcademyProgressRoom />;
  } else if (academy?.kind === 'course') {
    volt = <AcademyCourseRoom key={`${p}:${url.search}`} slug={academy.slug} signedIn={Boolean(userId)} />;
  } else if (academy?.kind === 'assignment') {
    volt = (
      <AcademyAssignmentRoom
        key={`${p}:${url.search}`}
        slug={academy.slug ?? ''}
        itemId={academy.itemId ?? ''}
        signedIn={Boolean(userId)}
      />
    );
  } else if (academy?.kind === 'verify') {
    volt = <AcademyVerifyRoom key={academy.code ?? ''} code={academy.code} />;
  } else if (
    academy &&
    !academySectionRedirect(p, url.search) &&
    ((academy.kind === 'tab' && academy.tab === 'Learning') || academy.kind === 'reader')
  ) {
    // The hub and Learning are on the catalogue template (issue 9566); an old `?slug=` address opens that lesson in place.
    volt = (
      <AcademyLearningRoom
        key={`${p}:${url.search}`}
        hub={academy.kind === 'tab' && Boolean(academy.hub)}
        signedIn={Boolean(userId)}
        slug={academy.kind === 'tab' ? (url.searchParams.get('slug') ?? undefined) : undefined}
        initialPath={url.searchParams.get('path') ?? undefined}
      />
    );
  } else if (academy?.kind === 'tab' && academy.tab === 'Certificates') {
    volt = <AcademyCertificatesRoom key={`${p}:${url.search}`} signedIn={Boolean(userId)} />;
  } else if (academy?.kind === 'tab' && academy.tab === 'Rooms') {
    volt = <AcademyRoomsRoom key={`${p}:${url.search}`} signedIn={Boolean(userId)} />;
  } else if (academy?.kind === 'tab' && academy.tab === 'Videos') {
    volt = <AcademyVideosRoom key={`${p}:${url.search}`} signedIn={Boolean(userId)} />;
  } else if (academy?.kind === 'tab' && academy.tab === 'Programmes') {
    volt = <AcademyProgrammesRoom key={`${p}:${url.search}`} signedIn={Boolean(userId)} />;
  } else if (academy?.kind === 'programme') {
    volt = <AcademyProgrammeRoom key={`${p}:${url.search}`} slug={academy.slug} signedIn={Boolean(userId)} />;
  } else if (academy) {
    title = copyText('moreroutes.academy');
    description = copyText('moreroutes.learn.practise.and.join.hosted.sessions');
    content = <AcademyRoom key={`${p}:${url.search}`} pathname={p} search={url.search} route={academy} />;
    // The signed-in course-team inbox is on its Volt template; a signed-out visitor gets the public Academy.
    if (academy.kind === 'messages' && !academy.conversationId && userId) volt = content;
  } else if (p === '/agents') {
    volt = <AgentsRoom paper={paper} />;
  } else if (p === '/agents/connect') {
    volt = <AgentConnect />;
  } else if (p === '/agents/new') {
    volt = <NewAgent />;
  } else if (agentRunId(p)) {
    const runId = agentRunId(p)!;
    volt = <AgentRunPage key={runId} runId={runId} />;
  } else if (ownAgentId(p)) {
    const id = ownAgentId(p)!;
    volt = <OwnAgentRoom key={id} id={id} />;
  } else if (p === '/agents/approvals') {
    volt = <AgentApprovalsRoom />;
  } else if (p === '/blueprint') {
    room = 'blueprint';
    volt = <BlueprintRoom path={path} />;
  } else if (p === '/campaigns') {
    volt = <CampaignsRoom title={copyText('moreroutes.campaigns')} description={copyText('moreroutes.your.campaign.participation')} />;
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
  } else if (p === '/market') {
    room = 'market';
    volt = <MarketRoom />;
  } else if (p === '/market/strategy') {
    room = 'market';
    volt = <MarketStrategyRoom />;
  } else if (p === '/market/mine') {
    room = 'market';
    title = copyText('moreroutes.my.listings');
    description = copyText('moreroutes.published.catalogue.terms.and.your.seller.workspace');
    content = <Market key={p} mine strategy={false} />;
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
    volt = <SupportChatRoom />;
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
      if (hit.route.pattern === '/predict/settings') volt = <PredictSettingsRoom />;
      else if (hit.route.pattern === '/launch/new') volt = <LaunchNewRoom paper={paper} />;
      else if (hit.route.pattern === '/launch/check') volt = <LaunchCheckRoom paper={paper} />;
      else if (hit.route.pattern === '/launch/requirements') volt = <LaunchRequirementsRoom paper={paper} />;
      else if (hit.route.pattern === '/token/economy') volt = <TokenEconomyRoom paper={paper} />;
      else if (hit.route.pattern === '/mining/status') volt = <MiningStatusRoom paper={paper} />;
      else if (hit.route.pattern === '/mining/workers/:workerId')
        volt = <MiningWorkerRoom key={hit.id ?? 'invalid'} invalid={Boolean(hit.invalid)} paper={paper} />;
      else if (hit.route.pattern === '/blueprint/shared/:cardId') volt = <BlueprintSharedRoom path={path} paper={paper} />;
      else if (hit.route.kind === 'detail' && room === 'token')
        volt = <TokenProposalRoom key={hit.id ?? 'invalid'} proposalId={hit.invalid ? null : (hit.id ?? null)} paper={paper} />;
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
            <a className="lt-link" href={preservePaperHref(page.href, paper)}>
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
  // The Team room is on its settings template: it draws its own title, so it is not put inside the old page.
  if (p === '/agents/team') return <AgentsTeam key={userId ?? 'anonymous'} />;
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
