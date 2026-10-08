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
import { Quant } from './Quant';
import { Support } from './Support';
import { Token } from './Token';
import { preservePaperHref } from './trade-context';
import './more.css';
const rooms = [
  ['/academy', copyText('moreroutes.academy'), copyText('moreroutes.learning.paths.certificates.hosted.sessions.and.programmes')],
  ['/agents', copyText('moreroutes.agents'), copyText('moreroutes.read.permissions.run.approved.tasks.and.inspect')],
  ['/quant', copyText('moreroutes.quant'), copyText('moreroutes.write.strategies.in.a.simulation.sandbox.and')],
  ['/launch', copyText('moreroutes.launch'), copyText('moreroutes.issuance.listing.and.sale.participation.prerequisites')],
  ['/market', copyText('moreroutes.market'), copyText('moreroutes.browse.published.listings.and.manage.your.seller')],
  ['/predict', copyText('moreroutes.prediction'), copyText('moreroutes.read.listed.events.and.their.actual.yes')],
  ['/mining', copyText('moreroutes.mining'), copyText('moreroutes.pool.connection.and.the.customer.activity.contracts')],
  ['/token', copyText('moreroutes.token'), copyText('moreroutes.your.exact.stake.projection.access.and.governance')],
  ['/blueprint', copyText('moreroutes.blueprint'), copyText('moreroutes.your.profile.share.card.mentor.shortlist.and')],
  ['/support', copyText('moreroutes.support'), copyText('moreroutes.published.help.and.your.support.conversations')],
  ['/campaigns', copyText('moreroutes.campaigns'), copyText('moreroutes.campaign.participation')],
  ['/trade/copy', copyText('moreroutes.copy'), copyText('moreroutes.follow.leaders.through.the.trade.permission.and')],
  ['/trade/bots', copyText('moreroutes.bots'), copyText('moreroutes.inspect.existing.trading.algorithms.and.their.actual')],
] as const;
export function MoreRoutes({ path }: { path: string }) {
  copy.useCopy();
  return (
    <div lang="en" style={{ display: 'contents' }}>
      <MoreRooms path={path} />
    </div>
  );
}
function MoreRooms({ path }: { path: string }) {
  const { userId } = useSession();
  const url = new URL(path, location.origin),
    p = url.pathname;
  const paper = url.searchParams.get('simulated') === 'true';
  let title = copyText('moreroutes.more'),
    description = copyText('moreroutes.explore.the.rooms.behind.your.everyday.account'),
    content = (
      <div className="more-rooms">
        {rooms.map(([href, name, copy]) => (
          <a className="more-room-link" href={preservePaperHref(href, paper)} key={href}>
            <strong>{name}</strong>
            <p>{copy}</p>
          </a>
        ))}
      </div>
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
    content = <Blueprint />;
  } else if (p === '/campaigns') {
    title = copyText('moreroutes.campaigns');
    description = copyText('moreroutes.your.campaign.participation');
    content = <Campaigns />;
  } else if (p === '/launch' || p === '/uc/innovation/myorders') {
    title = p === '/launch' ? copyText('moreroutes.launch') : copyText('moreroutes.my.launch.orders');
    description = copyText('moreroutes.issuance.and.sale.participation.require.their.owned');
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
    description = copyText('moreroutes.listed.questions.result.sources.and.fully.collateralized');
    content = <Prediction />;
  } else if (p === '/mining') {
    title = copyText('moreroutes.mining');
    description = copyText('moreroutes.pool.status.without.invented.miners.or.rewards');
    content = <Mining />;
  } else if (p === '/token') {
    title = copyText('moreroutes.token');
    description = copyText('moreroutes.exact.stake.records.access.and.governance');
    content = <Token />;
  } else if (p === '/quant' || p === '/quant/studio' || p === '/quant/backtest') {
    title =
      p === '/quant'
        ? copyText('moreroutes.quant.sandbox')
        : p === '/quant/studio'
          ? copyText('moreroutes.quant.studio')
          : copyText('moreroutes.backtest');
    description = copyText('moreroutes.simulated.strategy.research.with.explicit.historical.evidence');
    content = <Quant key={p} paper={paper} mode={p === '/quant/studio' ? 'studio' : p === '/quant/backtest' ? 'backtest' : 'sandbox'} />;
  } else if (p === '/support') {
    title = copyText('moreroutes.support');
    description = copyText('moreroutes.help.requests.and.your.conversation.with.the');
    content = <Support />;
  } else if (p !== '/more') {
    content = (
      <Panel title={copyText('moreroutes.more.destination.unavailable')}>
        <EmptyState title={copyText('moreroutes.this.destination.has.no.customer.route')}>
          <Text k="moreroutes.use.a.published.more.room.to.continue" />
        </EmptyState>
        <a className="text-link" href="/more">
          <Text k="moreroutes.open.more" />
        </a>
      </Panel>
    );
  }
  return (
    <div className="more-feature">
      <Page key={userId ?? 'anonymous'} eyebrow={copyText('moreroutes.more')} title={title} description={description}>
        {content}
      </Page>
    </div>
  );
}
