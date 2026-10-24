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
import { AcademyVideoPlayer } from './AcademyVideoPlayer';

const video = z.object({ slug: z.string(), title: z.string(), path: z.string() });

/** Video library: recordings grouped by path, the player for the chosen one, and a way back to the matching lesson. */
export function AcademyVideos() {
  const api = useApi(),
    { userId } = useSession();
  const { t, Copy } = copy.useCopy();
  const [selected, setSelected] = useState(new URLSearchParams(window.location.search).get('video') ?? '');
  const list = useResource((signal) => api.query('academy', 'videos', undefined, z.array(video), { signal }), `videos:${userId}`);
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
          {selected ? (
            <AcademyVideoPlayer key={selected} videoSlug={selected} />
          ) : (
            <p className="muted">
              <Text k="academy.choose.a.video" />
            </p>
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
