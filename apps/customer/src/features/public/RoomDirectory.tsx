import { doorSummaries } from './public-catalogue';
import { pagesCopy } from './public-pages-copy';

/** The rooms behind each door, read from the app's room list. Used on the landing page and on About. */
export function RoomDirectory({ limit = 6 }: { limit?: number }) {
  const copy = pagesCopy.useCopy();
  const summaries = doorSummaries();
  return (
    <div className="lt-reading-main">
      {summaries.map((door) => (
        <section key={door.door} aria-label={door.label}>
          <h3>{door.label}</h3>
          <p>
            <small>{door.count === 1 ? copy.t('roomsOne') : copy.t('rooms', { count: door.count })}</small>
          </p>
          <ul>
            {door.entries.slice(0, limit).map((entry) => (
              <li key={entry.path}>
                <a className="lt-link" href={entry.path}>
                  {entry.title}
                </a>{' '}
                <small>{entry.description}</small>
              </li>
            ))}
          </ul>
          {door.count > limit && <p>{copy.t('andMore', { count: door.count - limit })}</p>}
          <a className="lt-link" href={`/${door.door.toLowerCase()}`}>
            {copy.t('openDoor', { door: door.label })} →
          </a>
        </section>
      ))}
    </div>
  );
}
