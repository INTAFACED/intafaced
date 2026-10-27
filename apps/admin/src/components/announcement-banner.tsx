import Link from 'next/link';
import type { Announcement } from '@intafaced/contracts/ops-console-announcements';
import { KIND_LABEL, KIND_TONE, type ActiveAnnouncementView } from '@/lib/console-announcements/model';
import { formatInZone } from '@/lib/time-zone';

function Action({ action }: { action: Announcement['action'] }) {
  if (action.type === 'link')
    return action.url.startsWith('/') ? (
      <Link href={action.url} data-testid="announcement-link">
        {action.label}
      </Link>
    ) : (
      <a href={action.url} rel="noopener noreferrer" data-testid="announcement-link">
        {action.label}
      </a>
    );
  if (action.type === 'dialog')
    return (
      <details data-testid="announcement-dialog">
        <summary>Read more</summary>
        <p>{action.text}</p>
      </details>
    );
  return null;
}

/**
 * The announcement banner on every console page (OPS-admin-access-08): the one published announcement whose window is open
 * now, in its kind's tone, with its link or dialog and when it ends in the founder's own time zone. None showing, or none
 * readable: nothing (the desk says why it could not be read; the banner never guesses).
 */
export function AnnouncementBanner({ view, timeZone }: { view: ActiveAnnouncementView; timeZone: string }) {
  if (view.kind !== 'read' || !view.data.active) return null;
  const a = view.data.active;
  return (
    <div
      className="adm-callout"
      data-tone={KIND_TONE[a.kind]}
      role="status"
      data-testid="announcement-banner"
      data-announcement-id={a.id}
      data-kind={a.kind}
    >
      <strong>
        {KIND_LABEL[a.kind]}: {a.title}
      </strong>
      {a.body !== '' && <> {a.body}</>} <span className="dk-muted">Until {formatInZone(a.endsAt, timeZone)}.</span>{' '}
      <Action action={a.action} />
    </div>
  );
}
