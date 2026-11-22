/**
 * The lesson reader's video (AC-videos-01), drawn with the kit (intafaced issue 9568): the player when staff attached a
 * video to the item, otherwise the link to a matching recording. The same player logic as the Videos tab's
 * (../academy-video-state.ts); only the drawing is the kit's.
 */
import { useRef } from 'react';
import type { AcademyVideoCue } from '@intafaced/contracts/academy-catalogue';
import { Button } from '@intafaced/ui/lit';
import { SelectField, TextField } from '@intafaced/ui/lit/templates';
import { useKeepInView } from '../../../shared/media-element';
import { AcademyRefusal } from '../academy-refusal';
import { LessonVideoLink } from '../AcademyReaderParts';
import { clock, cuePlainText, useVideoPlayer, VIDEO_SPEEDS, type VideoPlayerProps } from '../academy-video-state';
import { useItemVideo, useVideoReads } from '../AcademyVideoPlayer';
import { Waiting } from '../volt-parts';

/** The player: Academy's signed file with our own controls, captions by language, and a transcript that follows playback. */
function LessonVideoPlayer(props: VideoPlayerProps) {
  const { player, playback } = props;
  const {
    t,
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
  // A save that failed reads as the kit's refusal text.
  const statusClass = status?.kind === 'failed' ? 'lt-refusal-body' : undefined;
  return (
    <figure className="lt-stack" data-video-player={player.slug} aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`} lang="und">
        {player.title}
      </figcaption>
      <div ref={frame} className="lt-stack" tabIndex={0} onKeyDown={keys} aria-describedby={`${id}-keys`}>
        <video
          ref={media}
          className="lt-media"
          src={playback.playbackUrl}
          preload="metadata"
          playsInline
          muted={muted}
          aria-label={t('playerLabel')}
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
            <p className="lt-refusal-body">{loadFailed ? t('videoLoadFailed') : t('videoExpired')}</p>
            <Button tone="secondary" onClick={renew}>
              {t('requestNewLink')}
            </Button>
          </div>
        )}
        <div className="lt-actions" role="group" aria-label={t('videoControls')}>
          <Button tone="secondary" onClick={toggle} aria-pressed={playing} data-video-play>
            {playing ? t('videoPause') : t('videoPlay')}
          </Button>
          <span lang="zxx" data-video-time>
            {clock(time)} / {duration === null ? '–:––' : clock(duration)}
          </span>
          <TextField
            type="range"
            label={t('videoSeek')}
            min={0}
            max={duration ?? 0}
            step={1}
            value={String(Math.floor(time))}
            disabled={duration === null}
            onChange={(value) => seekTo(Number(value))}
          />
          <Button tone="quiet" onClick={() => setMuted((value) => !value)} aria-pressed={muted}>
            {muted ? t('videoUnmute') : t('videoMute')}
          </Button>
          <SelectField
            label={t('videoSpeed')}
            value={String(speed)}
            onChange={(next) => changeSpeed(Number(next))}
            options={VIDEO_SPEEDS.map((value) => ({ value: String(value), label: `${value}×` }))}
            data-video-speed
          />
          <SelectField
            label={t('videoQuality')}
            value="original"
            onChange={() => undefined}
            aria-describedby={`${id}-quality`}
            options={player.renditions.map((rendition) => ({ value: rendition.id, label: t('videoQualityOriginal') }))}
            data-video-quality
          />
          {tracks.length === 0 ? (
            <SelectField
              label={t('videoCaptions')}
              value=""
              disabled
              data-video-captions="none"
              onChange={() => undefined}
              options={[{ value: '', label: t('videoCaptionsNone') }]}
            />
          ) : (
            <SelectField
              label={t('videoCaptions')}
              value={captions}
              onChange={setCaptions}
              data-video-captions
              options={[
                { value: '', label: t('videoCaptionsOff') },
                ...tracks.map((track) => ({ value: track.language, label: track.label })),
              ]}
            />
          )}
          <Button tone="secondary" onClick={screen} aria-pressed={fullScreen}>
            {fullScreen ? t('videoExitFullScreen') : t('videoFullScreen')}
          </Button>
        </div>
      </div>
      <p id={`${id}-quality`} className="lt-hint">
        {t('videoQualityOnly')}
      </p>
      <p id={`${id}-keys`} className="lt-hint">
        {t('videoKeys')}
      </p>
      <p className="lt-hint" data-video-save-interval={player.saveEverySeconds ?? 'unset'}>
        {player.saveEverySeconds === null ? t('videoSaveUnset') : t('videoSaveEvery', { seconds: player.saveEverySeconds })}
      </p>
      <p className="lt-hint" data-video-threshold={player.watchThresholdSeconds ?? 'unset'}>
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
        <p role="status" className={statusClass} data-video-status={status.kind}>
          {status.text}
        </p>
      )}
      <section className="lt-stack" aria-label={t('videoTranscript')} data-transcript={transcript?.language ?? 'none'}>
        <h3>{t('videoTranscript')}</h3>
        {transcript ? (
          <TranscriptList cues={transcript.cues} language={transcript.language} current={current} seek={seekTo} />
        ) : (
          <p className="lt-hint">{t('videoTranscriptNone')}</p>
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
    <ol ref={box} className="lt-stack lt-scroll-block" lang={language}>
      {cues.map((cue, i) => (
        <li key={`${cue.startMs}-${i}`} aria-current={i === current ? 'true' : undefined} data-cue={i}>
          <Button tone="quiet" onClick={() => seek(cue.startMs / 1000)}>
            <span lang="zxx">{clock(cue.startMs / 1000)}</span> {cuePlainText(cue.text)}
          </Button>
        </li>
      ))}
    </ol>
  );
}

/** One video, read from Academy, then the player. */
function LessonVideoReads({ videoSlug, onCompleted }: { videoSlug: string; onCompleted?: (items: string[]) => void }) {
  const { player, playback, position, save } = useVideoReads(videoSlug);
  for (const read of [player, playback, position]) {
    if (read.resource.status === 'failed') return <AcademyRefusal failure={read.resource.failure} retry={read.reload} />;
  }
  if (player.resource.status !== 'ready' || playback.resource.status !== 'ready' || position.resource.status !== 'ready')
    return <Waiting />;
  return (
    <LessonVideoPlayer
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

/** The reader's video: the player when staff attached a video to this item, otherwise the link to a matching recording. */
export function LessonVideo({ itemSlug, onCompleted }: { itemSlug: string; onCompleted?: (items: string[]) => void }) {
  const attached = useItemVideo(itemSlug);
  if (attached.resource.status === 'failed') return <AcademyRefusal failure={attached.resource.failure} retry={attached.reload} />;
  if (attached.resource.status !== 'ready') return <Waiting />;
  if (attached.resource.data.videoSlug === null) return <LessonVideoLink slug={itemSlug} />;
  return <LessonVideoReads videoSlug={attached.resource.data.videoSlug} onCompleted={onCompleted} />;
}
