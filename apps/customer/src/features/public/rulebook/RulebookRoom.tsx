import { useMemo } from 'react';
import { ReadingTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import { useDataEnv, useSource } from '../../../data/hooks';
import { refusalCopy } from '../../../data';
import type { Loadable } from '../../../data/types';
import { rulebookFetcher, rulebookTime, type Rulebook } from './rulebook-data';
import { rulebookCopy } from './rulebook-copy';

/**
 * /rulebook: the published trading rulebook for anyone, signed in or not (RC-cex-spot-08, J-cex-spot-20 #6), on the
 * reading template. The version in force, section by section, with when it took effect; a published future version as
 * "takes effect on"; and every version with the sections it changed. Bodies are plain text, rendered escaped.
 */
export function RulebookRoom() {
  const env = useDataEnv();
  const source = useMemo(() => env.poller.source<Rulebook>('public-rulebook', rulebookFetcher(env.api), { intervalMs: 60_000 }), [env]);
  return <RulebookView load={useSource(source)} />;
}

export function RulebookView({ load }: { load: Loadable<Rulebook> }) {
  const { t } = rulebookCopy.useCopy();
  const data = load.status === 'ready' ? load.data : null;
  const current = data?.current.published ? data.current : null;

  let state: RoomState;
  if (load.status === 'loading') state = { kind: 'loading' };
  else if (load.status === 'refused') {
    const words = refusalCopy(load.code);
    state = { kind: 'refused', refusal: { variant: 'refused', title: words.title, body: words.body ?? '', reference: load.code } };
  } else if (load.status === 'error' || load.status === 'empty') {
    state = {
      kind: 'refused',
      refusal: {
        variant: 'unreachable',
        title: t('unreachableTitle'),
        body: t('unreachableBody'),
        action: { label: t('retry'), href: '/rulebook' },
      },
    };
  } else if (current === null) {
    state = { kind: 'empty', title: t('unpublishedTitle'), body: t('unpublishedBody') };
  } else state = { kind: 'ready' };

  const upcoming = data?.current.upcoming ?? [];
  return (
    <div data-room="rulebook" data-published={current ? 'true' : 'false'}>
      <ReadingTemplate
        title={t('title')}
        description={t('lead')}
        state={state}
        meta={
          current ? (
            <dl data-rulebook-meta>
              <dt>{t('version')}</dt>
              <dd data-rulebook-version>{current.version}</dd>
              <dt>{t('effective')}</dt>
              <dd>
                <time data-effective-at dateTime={current.effectiveAt}>
                  {rulebookTime(current.effectiveAt)}
                </time>
              </dd>
              <dt>{t('published')}</dt>
              <dd>
                <time dateTime={current.publishedAt}>{rulebookTime(current.publishedAt)}</time>
              </dd>
            </dl>
          ) : null
        }
        toc={
          current ? (
            <nav aria-label={t('onThisPage')}>
              <ol>
                {current.sections.map((s) => (
                  <li key={s.id}>
                    <a href={`#rulebook-${s.id}`}>{s.title}</a>
                  </li>
                ))}
              </ol>
            </nav>
          ) : null
        }
        body={
          current ? (
            <div data-rulebook-body>
              {current.sections.map((s) => (
                <section key={s.id} id={`rulebook-${s.id}`} data-section={s.title} aria-labelledby={`rulebook-h-${s.id}`}>
                  <h2 id={`rulebook-h-${s.id}`}>{s.title}</h2>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{s.body}</p>
                </section>
              ))}
            </div>
          ) : null
        }
        related={
          data ? (
            <div data-rulebook-history>
              {upcoming.length > 0 ? (
                <section aria-label={t('upcomingTitle')} data-rulebook-upcoming>
                  <h2>{t('upcomingTitle')}</h2>
                  <ul>
                    {upcoming.map((u) => (
                      <li key={u.version}>{t('upcomingLine', { version: u.version, at: rulebookTime(u.effectiveAt) })}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <h2>{t('historyTitle')}</h2>
              {data.history.versions.length === 0 ? (
                <p>{t('historyEmpty')}</p>
              ) : (
                <ol>
                  {data.history.versions.map((v) => (
                    <li key={v.version} data-version={v.version} data-status={v.status}>
                      <strong>{v.version}</strong>{' '}
                      {v.status === 'current'
                        ? t('statusCurrent')
                        : v.status === 'upcoming'
                          ? t('statusUpcoming', { at: rulebookTime(v.effectiveAt) })
                          : t('statusSuperseded')}
                      {' · '}
                      {v.supersedes === null ? t('changedAll') : t('changed', { sections: v.changedSections.join(', ') })}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ) : null
        }
      />
    </div>
  );
}
