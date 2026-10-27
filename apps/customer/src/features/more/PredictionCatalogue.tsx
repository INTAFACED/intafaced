import type { Resource } from '../../shared/resource';
import { Button } from '../../shared/ui';
import { Read } from './common';
import { predictionCatalogueCopy } from './prediction-catalogue-copy';
import type { PublishedOutcome } from './prediction-catalogue';

export function PredictionCatalogue({
  resource,
  refresh,
  select,
}: {
  resource: Resource<PublishedOutcome[]>;
  refresh: () => void;
  select: (id: string) => void;
}) {
  const { Copy, t, languageFor, directionFor } = predictionCatalogueCopy.useCopy();
  return (
    <section
      data-testid="prediction-catalogue"
      className="prediction-catalogue"
      lang={languageFor('questions')}
      dir={directionFor('questions')}
    >
      <h2>
        <Copy k="questions" />
      </h2>
      <Read resource={resource} retry={refresh}>
        {(rows) =>
          rows.length === 0 ? (
            <div className="prediction-catalogue-status">
              <h3>
                <Copy k="empty" />
              </h3>
              <p className="muted">
                <Copy k="emptyBody" />
              </p>
            </div>
          ) : (
            <div data-testid="prediction-catalogue-records" className="prediction-catalogue-records">
              {rows.map((m) => (
                <article key={m.id}>
                  <h3 lang="und" dir="auto">
                    {m.question}
                  </h3>
                  <p className="muted">
                    <Copy k="closes" />{' '}
                    <time lang="und" dir="ltr" dateTime={m.closeAt}>
                      {m.closeAt}
                    </time>
                  </p>
                  <p className="muted">
                    <Copy k="source" />{' '}
                    <span lang="und" dir="auto">
                      {m.settlementSource}
                    </span>
                  </p>
                  <Button variant="secondary" aria-label={t('openEvent') + ': ' + m.question} onClick={() => select(m.id)}>
                    <Copy k="openEvent" />
                  </Button>
                </article>
              ))}
            </div>
          )
        }
      </Read>
      {resource.status === 'failed' ? (
        <p className="muted">
          <Copy k="failedBody" />
        </p>
      ) : (
        <Button
          variant={resource.status === 'ready' && resource.data.length === 0 ? 'primary' : 'secondary'}
          data-testid="prediction-catalogue-refresh"
          className="prediction-catalogue-refresh"
          onClick={refresh}
          disabled={resource.status === 'loading'}
        >
          <Copy k="refresh" />
        </Button>
      )}
    </section>
  );
}
