import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  academyItemVideoSchema,
  academyVideoPlaybackSchema,
  academyVideoPlayerSchema,
  academyVideoPositionSavedSchema,
  academyVideoPositionSchema,
  type AcademyVideoCue,
  type AcademyVideoPlayback,
  type AcademyVideoPlayer as VideoPlayerSettings,
  type AcademyVideoTrack,
} from '@intafaced/contracts/academy-catalogue';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Loading } from '../../shared/ui';
import { useApi, useSession } from '../session/session';
import { academyRefusalText } from './academy-flows';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { AcademyRefusal } from './AcademyLmsParts';
import { LessonVideoLink } from './AcademyReaderParts';

type Failure = Extract<ApiResult<never>, { ok: false }>;
type Saved = { positionSeconds: number; completedItems: string[] };

export const VIDEO_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** Seconds as m:ss (h:mm:ss past an hour), the way a player shows time. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600),
    m = Math.floor((whole % 3600) / 60),
    s = String(whole % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** A WebVTT file from Academy's cues, for the browser's own caption rendering. */
export function cuesToVtt(cues: readonly AcademyVideoCue[]): string {
  const stamp = (ms: number) =>
    `${String(Math.floor(ms / 3_600_000)).padStart(2, '0')}:${String(Math.floor(ms / 60_000) % 60).padStart(2, '0')}:${String(
      Math.floor(ms / 1000) % 60,
    ).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  return `WEBVTT\n\n${cues.map((cue) => `${stamp(cue.startMs)} --> ${stamp(cue.endMs)}\n${cue.text}\n`).join('\n')}`;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', nbsp: '\u00a0', lrm: '\u200e', rlm: '\u200f' };

/** A cue's words for the transcript: WebVTT tags (`<v Name>`, `<i>`, timestamps) dropped and its entities read. */
export function cuePlainText(text: string): string {
  return text.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (_all, name: string) => ENTITIES[name]!);
}

/** The cue playing at `seconds`, or -1. */
export function activeCue(cues: readonly AcademyVideoCue[], seconds: number): number {
  const ms = seconds * 1000;
  return cues.findIndex((cue) => ms >= cue.startMs && ms < cue.endMs);
}

/**
 * The player (AC-videos-01): Academy's signed file with our own controls, captions by language, a transcript that
 * follows playback, and the watch position saved on pause, on leaving and every owner-set interval. Opening resumes at
 * the stored position. `save` stores one position; the view never sends two at once.
 */
export function VideoPlayerView({
  player,
  playback,
  resumeAt,
  save,
  renewLink,
  onCompleted,
}: {
  player: VideoPlayerSettings;
  playback: AcademyVideoPlayback;
  resumeAt: number | null;
  save: (positionSeconds: number) => Promise<ApiResult<Saved>>;
  renewLink: () => void;
  onCompleted?: (items: string[]) => void;
}) {
  const { t } = copy.useCopy();
  const id = useId();
  const frame = useRef<HTMLDivElement>(null);
  const media = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [speed, setSpeed] = useState(1);
  const [captions, setCaptions] = useState('');
  const [fullScreen, setFullScreen] = useState(false);
  const [resumed, setResumed] = useState<number | null>(null);
  const [status, setStatus] = useState<{ kind: 'saved' | 'failed' | 'completed'; text: string } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const tracks = player.tracks;
  const transcript: AcademyVideoTrack | undefined = tracks.find((track) => track.language === captions) ?? tracks[0];
  const current = transcript ? activeCue(transcript.cues, time) : -1;
  // Each track as a file the browser renders itself; made and revoked by the same effect.
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const made = tracks.map((track) => URL.createObjectURL(new Blob([cuesToVtt(track.cues)], { type: 'text/vtt' })));
    setUrls(made);
    return () => made.forEach((url) => URL.revokeObjectURL(url));
  }, [tracks]);

  // One save at a time, in order; a position already stored is not sent again. The words and the completion callback are
  // read when a save answers, so a new render never starts or drops a save.
  const queue = useRef(Promise.resolve());
  const lastSaved = useRef<number | null>(resumeAt);
  // The last place the element reported: saves read it, so a save after the element is gone never stores 0.
  const at = useRef(resumeAt ?? 0);
  const reported = useRef(new Set<string>());
  const latest = useRef({ t, onCompleted });
  latest.current = { t, onCompleted };
  const store = useCallback(
    (position: number) => {
      queue.current = queue.current.then(async () => {
        if (position === lastSaved.current) return;
        const result = await save(position);
        const { t, onCompleted } = latest.current;
        if (result.ok) {
          lastSaved.current = result.data.positionSeconds;
          // Once complete, the player keeps saying so; the outline hears about each item once.
          const fresh = result.data.completedItems.filter((item) => !reported.current.has(item));
          fresh.forEach((item) => reported.current.add(item));
          setStatus((was) =>
            result.data.completedItems.length > 0 || was?.kind === 'completed'
              ? { kind: 'completed', text: t('videoCompleted') }
              : { kind: 'saved', text: t('videoSaved', { time: clock(result.data.positionSeconds) }) },
          );
          if (fresh.length > 0) onCompleted?.(fresh);
        } else {
          const reason = academyRefusalText(result as Failure, t) ?? t('videoSaveFailedPlain');
          setStatus({ kind: 'failed', text: t('videoSaveFailed', { reason }) });
        }
      });
    },
    [save],
  );
  const position = () => Math.floor(at.current);

  // While playing, save every owner-set interval; with none set, only pause and leaving save.
  useEffect(() => {
    if (!playing || player.saveEverySeconds === null) return;
    const timer = window.setInterval(() => store(position()), player.saveEverySeconds * 1000);
    return () => window.clearInterval(timer);
  }, [playing, player.saveEverySeconds, store]);
  useEffect(() => {
    const leave = () => {
      if (document.visibilityState === 'hidden' && at.current > 0) store(Math.floor(at.current));
    };
    document.addEventListener('visibilitychange', leave);
    return () => {
      document.removeEventListener('visibilitychange', leave);
      if (at.current > 0) store(Math.floor(at.current));
    };
  }, [store]);

  // The signed link expires on Academy's clock; past it, the player says so and offers a new one.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);
  const expired = Date.parse(playback.expiresAt) <= now;

  useEffect(() => {
    const node = media.current;
    if (!node) return;
    for (const [i, track] of Array.from(node.textTracks).entries()) track.mode = tracks[i]?.language === captions ? 'showing' : 'disabled';
  }, [captions, tracks, urls]);
  useEffect(() => {
    if (media.current) media.current.playbackRate = speed;
  }, [speed]);
  useEffect(() => {
    const change = () => setFullScreen(document.fullscreenElement === frame.current);
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, []);

  const toggle = () => {
    const node = media.current;
    if (!node) return;
    if (node.paused) void node.play().catch(() => setPlaying(false));
    else node.pause();
  };
  const skip = (by: number) => {
    const node = media.current;
    if (node)
      node.currentTime = Math.min(
        Math.max(0, node.currentTime + by),
        Number.isFinite(node.duration) ? node.duration : node.currentTime + by,
      );
  };
  const screen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void frame.current?.requestFullscreen?.();
  };
  const keys = (event: KeyboardEvent) => {
    if ((event.target as HTMLElement).closest('select, input')) return;
    const act: Record<string, () => void> = {
      ' ': toggle,
      k: toggle,
      ArrowLeft: () => skip(-5),
      ArrowRight: () => skip(5),
      f: screen,
      m: () => setMuted((value) => !value),
      c: () => tracks.length > 0 && setCaptions((value) => (value ? '' : tracks[0]!.language)),
    };
    const run = act[event.key];
    // Space on a focused button presses that button; every other key acts on the player.
    if (!run || (event.key === ' ' && (event.target as HTMLElement).closest('button'))) return;
    event.preventDefault();
    run();
  };

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
          onLoadedMetadata={(event) => {
            const node = event.currentTarget;
            setDuration(Number.isFinite(node.duration) ? node.duration : null);
            node.playbackRate = speed;
            const from = lastSaved.current;
            if (from !== null && from > 0 && (!Number.isFinite(node.duration) || from < node.duration - 0.5)) {
              node.currentTime = from;
              at.current = from;
              setResumed(from);
            }
          }}
          onTimeUpdate={(event) => {
            at.current = event.currentTarget.currentTime;
            setTime(at.current);
          }}
          onPlay={() => setPlaying(true)}
          onPause={(event) => {
            setPlaying(false);
            store(Math.floor(event.currentTarget.currentTime));
          }}
          onEnded={(event) => store(Math.floor(event.currentTarget.currentTime))}
          onError={() => setLoadFailed(true)}
        >
          {urls.length === tracks.length &&
            tracks.map((track, i) => (
              <track key={track.language} kind="captions" srcLang={track.language} label={track.label} src={urls[i]} />
            ))}
        </video>
        {/* The element stays: a link that expires mid-play keeps playing what the browser holds, and the place is kept. */}
        {(loadFailed || (expired && !playing)) && (
          <div data-testid="failure" className="failure" role="status" data-video-expired>
            <p>{loadFailed ? t('videoLoadFailed') : t('videoExpired')}</p>
            <Button
              variant="secondary"
              onClick={() => {
                // The place is stored before the new link reads it back.
                store(position());
                void queue.current.then(() => {
                  setLoadFailed(false);
                  renewLink();
                });
              }}
            >
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
            onChange={(event) => {
              if (media.current) media.current.currentTime = Number(event.target.value);
            }}
          />
          <Button variant="ghost" onClick={() => setMuted((value) => !value)} aria-pressed={muted}>
            {muted ? t('videoUnmute') : t('videoMute')}
          </Button>
          <label className="field">
            <span>{t('videoSpeed')}</span>
            <select value={String(speed)} onChange={(event) => setSpeed(Number(event.target.value))} data-video-speed>
              {VIDEO_SPEEDS.map((value) => (
                <option key={value} value={String(value)}>
                  {`${value}×`}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('videoQuality')}</span>
            <select value="original" onChange={() => undefined} aria-describedby={`${id}-quality`} data-video-quality>
              {player.renditions.map((rendition) => (
                <option key={rendition.id} value={rendition.id}>
                  {t('videoQualityOriginal')}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
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
      <p id={`${id}-quality`} className="muted">
        {t('videoQualityOnly')}
      </p>
      <p id={`${id}-keys`} className="muted">
        {t('videoKeys')}
      </p>
      <p className="muted" data-video-save-interval={player.saveEverySeconds ?? 'unset'}>
        {player.saveEverySeconds === null ? t('videoSaveUnset') : t('videoSaveEvery', { seconds: player.saveEverySeconds })}
      </p>
      <p className="muted" data-video-threshold={player.watchThresholdSeconds ?? 'unset'}>
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
          <TranscriptList
            cues={transcript.cues}
            language={transcript.language}
            current={current}
            seek={(seconds) => {
              if (media.current) media.current.currentTime = seconds;
            }}
          />
        ) : (
          <p className="muted">{t('videoTranscriptNone')}</p>
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
  useEffect(() => {
    const list = box.current,
      row = list?.children[current] as HTMLElement | undefined;
    if (list && row) list.scrollTop = row.offsetTop - list.offsetTop - list.clientHeight / 3;
  }, [current]);
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
  const api = useApi(),
    { userId } = useSession();
  const player = useResource(
    (signal) =>
      api.query(
        'academy',
        'videoPlayer',
        { slug: videoSlug },
        academyVideoPlayerSchema.refine((p) => p.slug === videoSlug),
        { signal },
      ),
    `video-player:${userId}:${videoSlug}`,
  );
  const playback = useResource(
    (signal) =>
      api.query(
        'academy',
        'videoPlayback',
        { slug: videoSlug },
        academyVideoPlaybackSchema.refine((p) => p.slug === videoSlug),
        { signal },
      ),
    `video-playback:${userId}:${videoSlug}`,
  );
  const position = useResource(
    (signal) =>
      api.query(
        'academy',
        'videoProgress.get',
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
        api.mutate(
          'academy',
          'videoProgress.set',
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

/** The reader's video: the player when staff attached a video to this item, otherwise the link to a matching recording. */
export function ItemVideo({ itemSlug, onCompleted }: { itemSlug: string; onCompleted?: (items: string[]) => void }) {
  const api = useApi(),
    { userId } = useSession();
  const attached = useResource(
    (signal) =>
      api.query(
        'academy',
        'itemVideo',
        { itemSlug },
        academyItemVideoSchema.refine((v) => v.itemSlug === itemSlug),
        { signal },
      ),
    `item-video:${userId}:${itemSlug}`,
  );
  if (attached.resource.status === 'failed') return <AcademyRefusal failure={attached.resource.failure} retry={attached.reload} />;
  if (attached.resource.status !== 'ready') return <Loading />;
  if (attached.resource.data.videoSlug === null) return <LessonVideoLink slug={itemSlug} />;
  return <AcademyVideoPlayer videoSlug={attached.resource.data.videoSlug} onCompleted={onCompleted} />;
}
