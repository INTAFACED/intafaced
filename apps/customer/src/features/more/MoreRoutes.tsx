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
import './more.css';
const rooms = [
  ['/academy', 'Academy', 'Learning paths, certificates, hosted sessions and programmes.'],
  ['/agents', 'Agents', 'Read permissions, run approved tasks and inspect your action log.'],
  ['/quant', 'Quant', 'Write strategies in a simulation sandbox and inspect historical evidence.'],
  ['/launch', 'Launch', 'Issuance, listing and sale-participation prerequisites.'],
  ['/market', 'Market', 'Browse published listings and manage your seller workspace.'],
  ['/predict', 'Prediction', 'Read listed events and their actual yes/no instruments.'],
  ['/mining', 'Mining', 'Pool connection and the customer activity contracts still needed.'],
  ['/token', 'Token', 'Your exact stake projection, access and governance proposals.'],
  ['/blueprint', 'Blueprint', 'Your profile, share card, mentor shortlist and data controls.'],
  ['/support', 'Support', 'Published help and your support conversations.'],
  ['/campaigns', 'Campaigns', 'Signed-in draft assessment and publication boundaries.'],
  ['/trade/copy', 'Copy', 'Follow leaders through the Trade permission and grant flow.'],
  ['/trade/bots', 'Bots', 'Inspect existing trading algorithms and their actual controls.'],
] as const;
export function MoreRoutes({ path }: { path: string }) {
  const { userId } = useSession();
  const url = new URL(path, location.origin),
    p = url.pathname;
  let title = 'More',
    description = 'Explore the rooms behind your everyday account.',
    content = (
      <div className="more-rooms">
        {rooms.map(([href, name, copy]) => (
          <a className="more-room-link" href={href} key={href}>
            <strong>{name}</strong>
            <p>{copy}</p>
          </a>
        ))}
      </div>
    );
  if (p === '/academy' || p.startsWith('/academy/')) {
    title = 'Academy';
    description = 'Learn, practise and join hosted sessions.';
    let slug = url.searchParams.get('slug') ?? undefined;
    try {
      if (p.split('/')[2]) slug = decodeURIComponent(p.split('/')[2]!);
    } catch {
      slug = undefined;
    }
    content = <Academy key={`${p}:${url.search}`} slug={slug} initialPath={url.searchParams.get('path') ?? undefined} />;
  } else if (p === '/agents') {
    title = 'Agents';
    description = 'Permissions, bounded engine sessions and your activity log.';
    content = <Agents />;
  } else if (p === '/blueprint') {
    title = 'Identity Blueprint';
    description = 'A profile you can keep private, share, export and erase.';
    content = <Blueprint />;
  } else if (p === '/campaigns') {
    title = 'Campaigns';
    description = 'Prepare a grounded proposal for human review.';
    content = <Campaigns />;
  } else if (p === '/launch' || p === '/uc/innovation/myorders') {
    title = p === '/launch' ? 'Launch' : 'My Launch orders';
    description = 'Issuance and sale participation require their owned contracts.';
    content = <Launch orders={p !== '/launch'} />;
  } else if (p === '/market' || p === '/market/mine' || p === '/market/strategy') {
    title = p === '/market' ? 'Market' : p === '/market/mine' ? 'My listings' : 'Strategy subscriptions';
    description = 'Published catalogue terms and your seller workspace.';
    content = <Market key={p} mine={p === '/market/mine'} strategy={p === '/market/strategy'} />;
  } else if (p === '/predict') {
    title = 'Prediction';
    description = 'Listed questions, result sources and fully collateralized instruments.';
    content = <Prediction />;
  } else if (p === '/mining') {
    title = 'Mining';
    description = 'Pool status without invented miners or rewards.';
    content = <Mining />;
  } else if (p === '/token') {
    title = 'Token';
    description = 'Exact stake records, access and governance.';
    content = <Token />;
  } else if (p === '/quant' || p === '/quant/studio' || p === '/quant/backtest') {
    title = p === '/quant' ? 'Quant sandbox' : p === '/quant/studio' ? 'Quant Studio' : 'Backtest';
    description = 'Simulated strategy research with explicit historical evidence.';
    content = <Quant key={p} mode={p === '/quant/studio' ? 'studio' : p === '/quant/backtest' ? 'backtest' : 'sandbox'} />;
  } else if (p === '/support') {
    title = 'Support';
    description = 'Help, requests and your conversation with the desk.';
    content = <Support />;
  } else if (p !== '/more') {
    content = (
      <Panel title="More destination unavailable">
        <EmptyState title="This destination has no customer route">Use a published More room to continue.</EmptyState>
        <a className="text-link" href="/more">
          Open More
        </a>
      </Panel>
    );
  }
  return (
    <div className="more-feature">
      <Page key={userId ?? 'anonymous'} eyebrow="More" title={title} description={description}>
        {content}
      </Page>
    </div>
  );
}
