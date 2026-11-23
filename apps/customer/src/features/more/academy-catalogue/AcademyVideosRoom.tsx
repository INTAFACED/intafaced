// volt-room: /academy/videos
import { useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { ACADEMY_VIDEOS } from '@intafaced/contracts/academy-videos-procedures';
import { ACADEMY_PUBLIC_VIDEOS } from '@intafaced/contracts/academy-public-videos-procedures';
import { useApi, useSession } from '../../session';
import { useResource } from '../../../shared/resource';
import { t as copyText, Text } from '../copy';
import { academyLmsCopy as copy } from '../academy-lms-copy';
import { academyPaths, isAcademyPath, lessonHrefFor } from '../academy-lms';
import { pathLabel } from '../academy-labels';
import { AcademyRefusal } from '../academy-refusal';
import { AcademySignIn } from '../academy-kit-parts';
import { useKitAcademyAction } from '../academy-reader/academy-action-kit';
import { LessonVideoReads } from '../academy-reader/LessonVideo';
import { EmptyNote, KitRead, Section, Waiting } from '../volt-parts';
import { CatalogueTemplate } from '@intafaced/ui/lit/templates';
import { AcademyVisitor, academyCatalogue } from './frame';

/**
 * /academy/videos on the catalogue template (intafaced issue 9566): the video library grouped by path, the player for the
 * chosen recording, and a way back to the matching lesson. Signed out it lists the published videos and says playback
 * needs sign-in. The player is the lesson reader's (academy-reader/LessonVideo.tsx).
 */
export function AcademyVideosRoom({ signedIn }: { signedIn: boolean }) {
  if (!signedIn)
    return (
      <AcademyVisitor signedIn={false}>
        <CatalogueTemplate {...academyCatalogue({ current: 'Videos' })} items={<PublicVideos />} />
      </AcademyVisitor>
    );
  return <SignedInVideos />;
}

function SignedInVideos() {
  const action = useKitAcademyAction();
  return (
    <>
      <AcademyVisitor signedIn>
        <CatalogueTemplate
          {...academyCatalogue({ current: 'Videos', onLeave: action.retire })}
          items={
            <div className="lt-stack">
              <AcademyVideos />
              {action.feedback}
            </div>
          }
        />
      </AcademyVisitor>
      {action.dialog}
    </>
  );
}

/** Video library: recordings grouped by path, the player for the chosen one, and a way back to the matching lesson. */
function AcademyVideos() {
  const api = useApi(),
    { userId } = useSession();
  const { t, Copy } = copy.useCopy();
  const [selected, setSelected] = useState(new URLSearchParams(window.location.search).get('video') ?? '');
  const list = useResource((signal) => api.call(ACADEMY_VIDEOS, undefined, { signal }), `videos:${userId}`);
  return (
    <div className="lt-stack">
      <Section title={copyText('academy.video.library')} className="lt-stack">
        <p className="lt-hint">
          <Copy k="videoIntro" />
        </p>
        {list.resource.status === 'failed' ? (
          // A typed refusal (video storage not configured, for one) is worded; the layout and the player panel stay.
          <AcademyRefusal failure={list.resource.failure} retry={list.reload} />
        ) : (
          <KitRead resource={list.resource} retry={list.reload} empty={copyText('academy.no.videos.are.available')}>
            {(rows) => (
              <>
                {[...academyPaths, 'other' as const].map((group) => {
                  const inGroup = rows.filter((v) => (isAcademyPath(v.path) ? v.path : 'other') === group);
                  if (inGroup.length === 0) return null;
                  return (
                    <section key={group} className="lt-stack">
                      <h3>{group === 'other' ? t('videoOther') : pathLabel(t, group)}</h3>
                      <ul className="lt-stack">
                        {inGroup.map((v, index) => (
                          <li key={v.slug} className="lt-actions" aria-current={v.slug === selected ? 'true' : undefined}>
                            <span>{index + 1}</span>
                            <strong lang="und">{v.title}</strong>
                            <Button tone={v.slug === selected ? 'primary' : 'secondary'} onClick={() => setSelected(v.slug)}>
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
          </KitRead>
        )}
      </Section>
      <Section title={copyText('academy.playback')} className="lt-stack">
        {selected ? (
          <LessonVideoReads key={selected} videoSlug={selected} />
        ) : (
          <p className="lt-hint">
            <Text k="academy.choose.a.video" />
          </p>
        )}
        {selected && (
          <a className="lt-link lt-link-alone" href={lessonHrefFor(selected)}>
            <Copy k="readMatchingLesson" />
          </a>
        )}
        <p className="lt-hint">
          <Copy k="videoGate" />
        </p>
      </Section>
    </div>
  );
}

/** The published videos for a visitor with no account: their titles, and playback that needs sign-in. */
function PublicVideos() {
  const api = useApi();
  const { t, Copy } = copy.useCopy();
  const list = useResource(
    (signal) =>
      api.call(ACADEMY_PUBLIC_VIDEOS, undefined, {
        signal,
      }),
    'public-videos',
  );
  return (
    <div className="lt-stack">
      <Section title={copyText('academy.video.library')} className="lt-stack">
        <p className="lt-hint">
          <Copy k="videoIntro" />
        </p>
        {list.resource.status === 'loading' ? (
          <Waiting />
        ) : list.resource.status === 'failed' ? (
          <AcademyRefusal failure={list.resource.failure} retry={list.reload} />
        ) : list.resource.data.length === 0 ? (
          <EmptyNote title={copyText('academy.no.videos.are.available')} />
        ) : (
          <ul className="lt-stack">
            {list.resource.data.map((video) => (
              <li key={video.slug}>
                <strong lang="und">{video.title}</strong>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={copyText('academy.playback')}>
        <EmptyNote title={t('publicVideosSignIn')} action={<AcademySignIn />} />
      </Section>
    </div>
  );
}
