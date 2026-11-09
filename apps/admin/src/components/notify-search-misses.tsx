import type { Part } from '@/lib/desk/part';
import { SEARCH_MISS_DAYS, type SearchMisses } from '@/lib/notify/search-misses-model';
import './desk.css';

/**
 * SEARCH MISSES — read-only (HM-navigation-04). How often the customer app's header search found nothing, per UTC day.
 * svc-notify stores no account and no words, so nothing here can say who searched or for what; the counts are approximate.
 */
export function SearchMissesPanel({ part }: { part: Part<SearchMisses> }) {
  return (
    <section className="dk" aria-labelledby="search-misses-title" data-testid="search-misses">
      <div className="adm-pagehead">
        <div>
          <h2 id="search-misses-title">Search misses</h2>
          <p>Header searches in the customer app that found nothing, per UTC day over the last {SEARCH_MISS_DAYS} days. Read-only.</p>
        </div>
      </div>
      <p className="dk-muted">
        Approximate: each is sent once with no retry, and anyone can add one. No account and no search words are stored, so this never says
        who searched or for what.
      </p>
      {part.kind === 'failed' ? (
        <div className="adm-callout" data-tone="danger" role="status" data-testid="search-misses-failed">
          <strong>Search misses unavailable</strong>
          <p>{part.message}</p>
          {part.code && <p className="dk-muted">Code: {part.code}</p>}
        </div>
      ) : (
        <>
          <p data-testid="search-misses-total">
            {part.data.total} {part.data.total === 1 ? 'miss' : 'misses'} from {part.data.from} to {part.data.to}
          </p>
          {part.data.days.length === 0 ? (
            <p className="dk-muted">No search missed in this window.</p>
          ) : (
            <div className="dk-table-wrap" role="region" aria-label="Search misses by day" tabIndex={0}>
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Day (UTC)</th>
                    <th>Misses</th>
                  </tr>
                </thead>
                <tbody>
                  {part.data.days.map((d) => (
                    <tr key={d.day} data-testid={`search-misses-${d.day}`}>
                      <th scope="row">{d.day}</th>
                      <td>{d.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
