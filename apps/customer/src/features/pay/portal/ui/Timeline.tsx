import { DateTime } from './DateTime';
import { uiCopy } from './copy';

/** `at` is left out when the service does not record when it happened; the page then says so instead of guessing. */
export type TimelineEvent = { at?: string; title: string; detail?: string };

/** Newest or oldest first is the page's choice; every event carries its time. */
export function Timeline({ items, label }: { items: readonly TimelineEvent[]; label: string }) {
  const { t } = uiCopy.useCopy();
  return (
    <ol className="pp-timeline" aria-label={label}>
      {items.map((item, i) => (
        <li key={`${item.at ?? 'unrecorded'}:${i}`}>
          <span className="pp-timeline-dot" aria-hidden="true" />
          <div>
            <strong>{item.title}</strong>
            {item.detail && <p className="muted">{item.detail}</p>}
            <small className="muted">{item.at ? <DateTime value={item.at} /> : t('timeNotRecorded')}</small>
          </div>
        </li>
      ))}
    </ol>
  );
}
