import { useId } from 'react';
import { Text as RoomText } from './copy';
import { discoveryCopy } from './discovery-copy';
import { preservePaperHref } from './trade-context';
import './more-discovery.css';

const primary = [
  {
    href: '/academy',
    name: 'moreroutes.academy',
    description: 'academy',
    action: 'academyAction',
    icon: 'book',
  },
  {
    href: '/support',
    name: 'moreroutes.support',
    description: 'support',
    action: 'supportAction',
    icon: 'chat',
  },
] as const;
const research = [
  { href: '/quant', name: 'moreroutes.quant', description: 'quant' },
  { href: '/agents', name: 'moreroutes.agents', description: 'agents' },
  { href: '/trade/copy', name: 'moreroutes.copy', description: 'copy' },
  { href: '/trade/bots', name: 'moreroutes.bots', description: 'bots' },
] as const;
const explore = [
  { href: '/market', name: 'moreroutes.market', description: 'market' },
  { href: '/token', name: 'moreroutes.token', description: 'token' },
  {
    href: '/predict',
    name: 'moreroutes.prediction',
    description: 'prediction',
  },
  {
    href: '/campaigns',
    name: 'moreroutes.campaigns',
    description: 'campaigns',
  },
  { href: '/launch', name: 'moreroutes.launch', description: 'launch' },
  { href: '/mining', name: 'moreroutes.mining', description: 'mining' },
] as const;
const blueprint = {
  href: '/blueprint',
  name: 'moreroutes.blueprint',
  description: 'blueprint',
} as const;
type CompactRoom = (typeof research)[number] | (typeof explore)[number] | typeof blueprint;

function TaskMark({ icon }: { icon: 'book' | 'chat' }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      {icon === 'book' ? (
        <>
          <path d="M16 8c-4-3-8-4-13-3v21c5-1 9 0 13 3 4-3 8-4 13-3V5c-5-1-9 0-13 3Z" />
          <path d="M16 8v21M7 10l5 2M7 16l5 2M20 12l5-2M20 18l5-2" />
        </>
      ) : (
        <>
          <path d="M27 4H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h5v5l7-5h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Z" />
          <path d="M9 11h14M9 17h9" />
        </>
      )}
    </svg>
  );
}

function CompactLink({ room, paper }: { room: CompactRoom; paper: boolean }) {
  const { Copy } = discoveryCopy.useCopy();
  return (
    <a className="more-discovery-link" href={preservePaperHref(room.href, paper)}>
      <div>
        <h3>
          <RoomText k={room.name} />
        </h3>
        <p>
          <Copy k={room.description} />
        </p>
      </div>
      <span className="more-discovery-arrow" aria-hidden="true">
        ↗
      </span>
    </a>
  );
}

export function MoreDiscovery({ paper }: { paper: boolean }) {
  const id = useId();
  const { Copy } = discoveryCopy.useCopy();
  return (
    <div className="more-discovery">
      <section aria-labelledby={`${id}-learn`}>
        <h2 id={`${id}-learn`}>
          <Copy k="learn" />
        </h2>
        <div className="more-discovery-primary">
          {primary.map((room) => (
            <a className="more-discovery-card" href={preservePaperHref(room.href, paper)} key={room.href}>
              <span className="more-discovery-mark">
                <TaskMark icon={room.icon} />
              </span>
              <h3>
                <RoomText k={room.name} />
              </h3>
              <p>
                <Copy k={room.description} />
              </p>
              <span className="more-discovery-cta">
                <Copy k={room.action} /> <span aria-hidden="true">↗</span>
              </span>
            </a>
          ))}
        </div>
        <CompactLink room={blueprint} paper={paper} />
      </section>
      <section aria-labelledby={`${id}-research`}>
        <h2 id={`${id}-research`}>
          <Copy k="research" />
        </h2>
        <div className="more-discovery-list">
          {research.map((room) => (
            <CompactLink room={room} paper={paper} key={room.href} />
          ))}
        </div>
      </section>
      <section aria-labelledby={`${id}-explore`}>
        <h2 id={`${id}-explore`}>
          <Copy k="explore" />
        </h2>
        <div className="more-discovery-list">
          {explore.map((room) => (
            <CompactLink room={room} paper={paper} key={room.href} />
          ))}
        </div>
      </section>
    </div>
  );
}
