import { DateTime } from './DateTime';

export type TimelineEvent = { at: string; title: string; detail?: string };

/** Newest or oldest first is the page's choice; every event carries its time. */
export function Timeline({ items, label }: { items: readonly TimelineEvent[]; label: string }) {
  return (
    <ol className="pp-timeline" aria-label={label}>
      {items.map((item, i) => (
        <li key={`${item.at}:${i}`}>
          <span className="pp-timeline-dot" aria-hidden="true" />
          <div>
            <strong>{item.title}</strong>
            {item.detail && <p className="muted">{item.detail}</p>}
            <small className="muted">
              <DateTime value={item.at} />
            </small>
          </div>
        </li>
      ))}
    </ol>
  );
}
