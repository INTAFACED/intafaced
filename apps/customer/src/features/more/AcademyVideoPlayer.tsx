import { useCallback, useRef } from 'react';
import {
  academyItemVideoSchema,
  academyVideoPlaybackSchema,
  academyVideoPlayerSchema,
  academyVideoPositionSavedSchema,
  academyVideoPositionSchema,
  type AcademyVideoCue,
} from '@intafaced/contracts/academy-catalogue';
import { useResource } from '../../shared/resource';
import { useApi, useSession } from '../session';
import { useKeepInView } from '../../shared/media-element';
import { Button, Loading } from '../../shared/ui';
import { AcademyRefusal } from './AcademyLmsParts';
import { clock, cuePlainText, useVideoPlayer, VIDEO_SPEEDS, type VideoPlayerProps } from './academy-video-state';
import { academyLmsCopy } from './academy-lms-copy';
import { callAs } from '../../shared/api';
import { ACADEMY_VIDEO_PLAYER } from '@intafaced/contracts/academy-video-player-procedures';
import { ACADEMY_VIDEO_PLAYBACK } from '@intafaced/contracts/academy-video-playback-procedures';
import { ACADEMY_VIDEO_PROGRESS_GET, ACADEMY_VIDEO_PROGRESS_SET } from '@intafaced/contracts/academy-video-progress-procedures';
import { ACADEMY_ITEM_VIDEO } from '@intafaced/contracts/academy-item-video-procedures';

export { VIDEO_SPEEDS, activeCue, clock, cuePlainText, cuesToVtt } from './academy-video-state';

/**
 * The player (AC-videos-01): Academy's signed file with our own controls, captions by language, a transcript that
 * follows playback, and the watch position saved on pause, on leaving and every owner-set interval. Opening resumes at
 * the stored position. `save` stores one position; the view never sends two at once.
 */
export function VideoPlayerView(props: VideoPlayerProps) {
  const { player, playback } = props;
  const {
    id,
    frame,
    media,
    playing,
    muted,
    setMuted,
    time,
    duration,
    speed,
    changeSpeed,
    captions,
    setCaptions,
    fullScreen,
    resumed,
    status,
    loadFailed,
    tracks,
    transcript,
    current,
    urls,
    expired,
    toggle,
    screen,
    keys,
    seekTo,
    renew,
    mediaEvents,
  } = useVideoPlayer(props);
  const { t } = academyLmsCopy.useCopy();

  return (
    <figure className="academy-video" data-video-player={player.slug} aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`} lang="und">
        {player.title}
      </figcaption>
      <div ref={frame} className="academy-video-frame" tabIndex={0} onKeyDown={keys} aria-describedby={`${id}-keys`}>
        <video
          ref={media}
          src={playback.playbackUrl}
          preload="metadata"
          playsInline
          muted={muted}
          aria-label={t('playerLabel')}
          style={{ width: '100%' }}
          onClick={toggle}
          {...mediaEvents}
        >
          {urls.length === tracks.length &&
            tracks.map((track, i) => (
              <track key={track.language} kind="captions" srcLang={track.language} label={track.label} src={urls[i]} />
            ))}
        </video>
        {/* The element stays: a link that expires mid-play keeps playing what the browser holds, and the place is kept. */}
        {(loadFailed || (expired && !playing)) && (
          <div data-testid="failure" className="lt-refusal" role="status" data-video-expired>
            <p>{loadFailed ? t('videoLoadFailed') : t('videoExpired')}</p>
            <Button variant="secondary" onClick={renew}>
              {t('requestNewLink')}
            </Button>
          </div>
        )}
        <div className="academy-video-controls" role="group" aria-label={t('videoControls')}>
          <Button variant="secondary" onClick={toggle} aria-pressed={playing} data-video-play>
            {playing ? t('videoPause') : t('videoPlay')}
          </Button>
          <span lang="zxx" data-video-time>
            {clock(time)} / {duration === null ? '–:––' : clock(duration)}
          </span>
          <input
            type="range"
            aria-label={t('videoSeek')}
            min={0}
            max={duration ?? 0}
            step={1}
            value={Math.floor(time)}
            disabled={duration === null}
            onChange={(event) => seekTo(Number(event.target.value))}
          />
          <Button variant="ghost" onClick={() => setMuted((value) => !value)} aria-pressed={muted}>
            {muted ? t('videoUnmute') : t('videoMute')}
          </Button>
          <label className="lt-field">
            <span>{t('videoSpeed')}</span>
            <select value={String(speed)} onChange={(event) => changeSpeed(Number(event.target.value))} data-video-speed>
              {VIDEO_SPEEDS.map((value) => (
                <option key={value} value={String(value)}>
                  {`${value}×`}
                </option>
              ))}
            </select>
          </label>
          <label className="lt-field">
            <span>{t('videoQuality')}</span>
            <select value="original" onChange={() => undefined} aria-describedby={`${id}-quality`} data-video-quality>
              {player.renditions.map((rendition) => (
                <option key={rendition.id} value={rendition.id}>
                  {t('videoQualityOriginal')}
                </option>
              ))}
            </select>
          </label>
          <label className="lt-field">
            <span>{t('videoCaptions')}</span>
            {tracks.length === 0 ? (
              <select value="" disabled data-video-captions="none" onChange={() => undefined}>
                <option value="">{t('videoCaptionsNone')}</option>
              </select>
            ) : (
              <select value={captions} onChange={(event) => setCaptions(event.target.value)} data-video-captions>
                <option value="">{t('videoCaptionsOff')}</option>
                {tracks.map((track) => (
                  <option key={track.language} value={track.language} lang={track.language}>
                    {track.label}
                  </option>
                ))}
              </select>
            )}
          </label>
          <Button variant="secondary" onClick={screen} aria-pressed={fullScreen}>
            {fullScreen ? t('videoExitFullScreen') : t('videoFullScreen')}
          </Button>
        </div>
      </div>
      <p id={`${id}-quality`} className="lt-muted">
        {t('videoQualityOnly')}
      </p>
      <p id={`${id}-keys`} className="lt-muted">
        {t('videoKeys')}
      </p>
      <p className="lt-muted" data-video-save-interval={player.saveEverySeconds ?? 'unset'}>
        {player.saveEverySeconds === null ? t('videoSaveUnset') : t('videoSaveEvery', { seconds: player.saveEverySeconds })}
      </p>
      <p className="lt-muted" data-video-threshold={player.watchThresholdSeconds ?? 'unset'}>
        {player.watchThresholdSeconds === null
          ? t('videoWatchUnset')
          : t('videoWatchThreshold', { time: clock(player.watchThresholdSeconds) })}
      </p>
      {resumed !== null && (
        <p role="status" data-video-resumed={resumed}>
          {t('videoResumed', { time: clock(resumed) })}
        </p>
      )}
      {status && (
        <p role="status" className={status.kind === 'failed' ? 'error-text' : undefined} data-video-status={status.kind}>
          {status.text}
        </p>
      )}
      <section aria-label={t('videoTranscript')} data-transcript={transcript?.language ?? 'none'}>
        <h3>{t('videoTranscript')}</h3>
        {transcript ? (
          <TranscriptList cues={transcript.cues} language={transcript.language} current={current} seek={seekTo} />
        ) : (
          <p className="lt-muted">{t('videoTranscriptNone')}</p>
        )}
      </section>
    </figure>
  );
}

/** The transcript: every cue, the one playing marked and kept in view inside its own scroll box; a cue seeks there. */
function TranscriptList({
  cues,
  language,
  current,
  seek,
}: {
  cues: readonly AcademyVideoCue[];
  language: string;
  current: number;
  seek: (seconds: number) => void;
}) {
  const box = useRef<HTMLOListElement>(null);
  useKeepInView(box, current);
  return (
    <ol ref={box} className="academy-video-transcript" lang={language} style={{ maxHeight: '12rem', overflowY: 'auto' }}>
      {cues.map((cue, i) => (
        <li key={`${cue.startMs}-${i}`} aria-current={i === current ? 'true' : undefined} data-cue={i}>
          <button type="button" className="link-button" onClick={() => seek(cue.startMs / 1000)}>
            <span lang="zxx">{clock(cue.startMs / 1000)}</span> {cuePlainText(cue.text)}
          </button>
        </li>
      ))}
    </ol>
  );
}

/**
 * One video, read from Academy: player settings and tracks, a signed link, and the stored position. Each save is named
 * by this viewing and its count (`video:<slug>:<opened>:<n>`), so a save sent again after a lost reply is the same save.
 */
export function AcademyVideoPlayer({ videoSlug, onCompleted }: { videoSlug: string; onCompleted?: (items: string[]) => void }) {
  const { player, playback, position, save } = useVideoReads(videoSlug);
  for (const read of [player, playback, position]) {
    if (read.resource.status === 'failed') return <AcademyRefusal failure={read.resource.failure} retry={read.reload} />;
  }
  if (player.resource.status !== 'ready' || playback.resource.status !== 'ready' || position.resource.status !== 'ready')
    return <Loading />;
  return (
    <VideoPlayerView
      key={playback.resource.data.playbackUrl}
      player={player.resource.data}
      playback={playback.resource.data}
      resumeAt={position.resource.data.positionSeconds}
      save={save}
      renewLink={() => {
        position.reload();
        playback.reload();
      }}
      onCompleted={onCompleted}
    />
  );
}

/**
 * One video's reads from Academy: player settings and tracks, a signed link, and the stored position. Each save is named
 * by this viewing and its count (`video:<slug>:<opened>:<n>`), so a save sent again after a lost reply is the same save.
 */
export function useVideoReads(videoSlug: string) {
  const api = useApi(),
    { userId } = useSession();
  const player = useResource(
    (signal) =>
      callAs(
        api,
        ACADEMY_VIDEO_PLAYER,
        { slug: videoSlug },
        academyVideoPlayerSchema.refine((p) => p.slug === videoSlug),
        { signal },
      ),
    `video-player:${userId}:${videoSlug}`,
  );
  const playback = useResource(
    (signal) =>
      callAs(
        api,
        ACADEMY_VIDEO_PLAYBACK,
        { slug: videoSlug },
        academyVideoPlaybackSchema.refine((p) => p.slug === videoSlug),
        { signal },
      ),
    `video-playback:${userId}:${videoSlug}`,
  );
  const position = useResource(
    (signal) =>
      callAs(
        api,
        ACADEMY_VIDEO_PROGRESS_GET,
        { videoSlug },
        academyVideoPositionSchema.refine((p) => p.videoSlug === videoSlug),
        { signal },
      ),
    `video-position:${userId}:${videoSlug}`,
  );
  const opened = useRef(Date.now());
  const count = useRef(0);
  const save = useCallback(
    async (positionSeconds: number) => {
      const key = `video:${videoSlug}:${opened.current}:${++count.current}`;
      const send = () =>
        callAs(
          api,
          ACADEMY_VIDEO_PROGRESS_SET,
          { videoSlug, positionSeconds, clientRequestId: key },
          academyVideoPositionSavedSchema.refine((p) => p.videoSlug === videoSlug),
        );
      const first = await send();
      // A reply that never arrived is asked again under the same key: Academy answers with the save it stored.
      const result = !first.ok && first.reason === 'uncertain' ? await send() : first;
      if (!result.ok) return result;
      return {
        ok: true as const,
        data: { positionSeconds: result.data.positionSeconds ?? positionSeconds, completedItems: result.data.completedItems },
      };
    },
    [api, videoSlug],
  );

  return { player, playback, position, save };
}

/** Whether staff attached a video to this lesson item. */
export function useItemVideo(itemSlug: string) {
  const api = useApi(),
    { userId } = useSession();
  const attached = useResource(
    (signal) =>
      callAs(
        api,
        ACADEMY_ITEM_VIDEO,
        { itemSlug },
        academyItemVideoSchema.refine((v) => v.itemSlug === itemSlug),
        { signal },
      ),
    `item-video:${userId}:${itemSlug}`,
  );
  return attached;
}
