import { useState } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, Panel } from '../../shared/ui';
import { Read } from './common';
import { t as copyText, Text } from './copy';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyPaths, lessonHrefFor, isAcademyPath } from './academy-lms';
import { AcademyRefusal, pathLabel } from './AcademyLmsParts';

const video = z.object({ slug: z.string(), title: z.string(), path: z.string() });
const playbackSchema = z.object({ slug: z.string(), playbackUrl: z.string().url(), expiresAt: z.string(), grant: z.string() });

/** Video library: recordings grouped by path, one player, and a way back to the matching lesson. */
export function AcademyVideos() {
  const api = useApi(),
    { userId } = useSession();
  const { t, Copy } = copy.useCopy();
  const [selected, setSelected] = useState(new URLSearchParams(window.location.search).get('video') ?? '');
  const list = useResource((signal) => api.query('academy', 'videos', undefined, z.array(video), { signal }), `videos:${userId}`);
  const playback = useResource(
    (signal) =>
      selected
        ? api.query(
            'academy',
            'videoPlayback',
            { slug: selected },
            playbackSchema.refine((p) => p.slug === selected),
            { signal },
          )
        : Promise.resolve({ ok: true as const, data: null }),
    `video:${userId}:${selected}`,
  );
  return (
    <div className="more-columns">
      <Panel title={copyText('academy.video.library')}>
        <div className="academy-lms-stack">
          <p className="muted">
            <Copy k="videoIntro" />
          </p>
          {list.resource.status === 'failed' ? (
            // A typed refusal (video storage not configured, for one) is worded; the layout and the player panel stay.
            <AcademyRefusal failure={list.resource.failure} retry={list.reload} />
          ) : (
            <Read resource={list.resource} retry={list.reload} empty={copyText('academy.no.videos.are.available')}>
              {(rows) => (
                <>
                  {[...academyPaths, 'other' as const].map((group) => {
                    const inGroup = rows.filter((v) => (isAcademyPath(v.path) ? v.path : 'other') === group);
                    if (inGroup.length === 0) return null;
                    return (
                      <section key={group} className="academy-lms-stack">
                        <h3>{group === 'other' ? t('videoOther') : pathLabel(t, group)}</h3>
                        <ul className="academy-lms-rows">
                          {inGroup.map((v, index) => (
                            <li key={v.slug} aria-current={v.slug === selected ? 'true' : undefined}>
                              <span>{index + 1}</span>
                              <strong lang="und">{v.title}</strong>
                              <Button variant={v.slug === selected ? 'primary' : 'secondary'} onClick={() => setSelected(v.slug)}>
                                <Copy k="playVideo" />
                              </Button>
                            </li>
                          ))}
                        </ul>
                      </section>
                    );
                  })}
                </>
              )}
            </Read>
          )}
        </div>
      </Panel>
      <Panel title={copyText('academy.playback')}>
        <div className="academy-lms-stack">
          {playback.resource.status === 'failed' ? (
            <AcademyRefusal failure={playback.resource.failure} retry={playback.reload} />
          ) : (
            <Read resource={playback.resource} retry={playback.reload} empty={copyText('academy.choose.a.video')}>
              {(p) =>
                p ? (
                  Date.parse(p.expiresAt) > Date.now() && p.playbackUrl.startsWith('https:') ? (
                    <>
                      <video controls style={{ width: '100%' }} src={p.playbackUrl} aria-label={t('playerLabel')} />
                      <p className="muted">
                        <Text k="academy.playback.grant.expires" />
                        {p.expiresAt}.
                      </p>
                    </>
                  ) : (
                    <>
                      <p>
                        <Text k="academy.the.playback.grant.is.expired.or.cannot" />
                      </p>
                      <Button variant="secondary" onClick={playback.reload}>
                        <Copy k="requestNewLink" />
                      </Button>
                    </>
                  )
                ) : null
              }
            </Read>
          )}
          {selected && (
            <a className="academy-learning-link" href={lessonHrefFor(selected)}>
              <Copy k="readMatchingLesson" />
            </a>
          )}
          <p className="muted">
            <Copy k="videoGate" />
          </p>
        </div>
      </Panel>
    </div>
  );
}
