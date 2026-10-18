import { Chip } from '@/components/chip';
import { ACTION_LABELS, PROTOCOL_ACTIONS, SOURCE_NAMES, blockersFor, factsFrom, networkLabel } from '@/lib/protocol-desk/blockers';
import type { DeskView } from '@/lib/ops-desk/types';
import './desk.css';
import { formatAsOf } from '@/lib/as-of';

/**
 * The named blockers in front of each Protocol action, worked out from the reads on this desk.
 *
 * A source that could not be loaded is named with the time it was tried, and counts as a blocker: nothing here is ever
 * shown as clear because a read failed. The network line is a label for the chain id a service reported; it is never
 * INTACHAIN and never audited.
 */
export function ProtocolBlockers({ view }: { view: DeskView | null }) {
  const facts = factsFrom(view);
  const label = networkLabel(facts.chain.status === 'ok' ? facts.chain.data.configuredChainId : null);
  const sources = (Object.keys(SOURCE_NAMES) as (keyof typeof SOURCE_NAMES)[]).map((key) => ({
    key,
    name: SOURCE_NAMES[key],
    fact: facts[key],
  }));
  return (
    <div className="dk-stack" data-testid="protocol-blockers">
      <div className="dk-row">
        <Chip tone="warn">{label.name}</Chip>
        <span className="dk-muted" data-testid="network-label">
          {label.note} Not audited.
        </span>
      </div>
      <ul className="dk-stack" data-testid="protocol-sources">
        {sources.map(({ key, name, fact }) => (
          <li key={key} data-testid={`source-${key}`}>
            {fact.status === 'ok' ? (
              <span className="dk-muted">
                Read {name}: answered, as of {formatAsOf(fact.asOf)}.
              </span>
            ) : (
              <strong>
                Could not load {name}
                <span className="dk-muted">
                  {' '}
                  ({fact.reason}
                  {fact.asOf ? `, as of ${formatAsOf(fact.asOf)}` : ''})
                </span>
              </strong>
            )}
          </li>
        ))}
      </ul>
      {PROTOCOL_ACTIONS.map((action) => {
        const blockers = blockersFor(action, facts);
        return (
          <div key={action} className="dk-stack" data-testid={`blockers-${action}`}>
            <h3>{ACTION_LABELS[action]}</h3>
            <p className="dk-muted">
              {blockers.length === 1 ? '1 blocker' : `${blockers.length} blockers`}; the action stays off until every one clears.
            </p>
            <ul>
              {blockers.map((b) => (
                <li key={b.code} data-code={b.code}>
                  {b.text}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
