/**
 * The Academy video player, without its drawing (AC-videos-01): the reads of one video, the watch position saved one at a
 * time, the signed link's expiry, the keys and the captions. The Videos tab's player (AcademyVideoPlayer.tsx) draws it
 * with the old parts; the lesson reader's (academy-reader/LessonVideo.tsx) with the kit's. The logic is one.
 */
import { useCallback, useId, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import {
  type AcademyVideoCue,
  type AcademyVideoPlayback,
  type AcademyVideoPlayer as VideoPlayerSettings,
  type AcademyVideoTrack,
} from '@intafaced/contracts/academy-catalogue';
import type { ApiResult } from '../../shared/api';
import { useEventListener, useInterval, useNow } from '../../shared/outside';
import { useObjectUrls, usePageLeave, useTextTrackModes } from '../../shared/media-element';
import { academyRefusalText } from './academy-flows';
import { academyLmsCopy as copy } from './academy-lms-copy';

type Failure = Extract<ApiResult<never>, { ok: false }>;
export type Saved = { positionSeconds: number; completedItems: string[] };

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

export type VideoPlayerProps = {
  player: VideoPlayerSettings;
  playback: AcademyVideoPlayback;
  resumeAt: number | null;
  save: (positionSeconds: number) => Promise<ApiResult<Saved>>;
  renewLink: () => void;
  onCompleted?: (items: string[]) => void;
};

/** One player's state and handlers; `save` stores one position, and the player never sends two at once. */
export function useVideoPlayer({ player, playback, resumeAt, save, renewLink, onCompleted }: VideoPlayerProps) {
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

  const tracks = player.tracks;
  const transcript: AcademyVideoTrack | undefined = tracks.find((track) => track.language === captions) ?? tracks[0];
  const current = transcript ? activeCue(transcript.cues, time) : -1;
  // Each track as a file the browser renders itself, revoked when the tracks are replaced or the player goes.
  const urls = useObjectUrls(tracks, (track) => new Blob([cuesToVtt(track.cues)], { type: 'text/vtt' }));

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
  useInterval(() => store(position()), playing && player.saveEverySeconds !== null ? player.saveEverySeconds * 1000 : null);
  // Hiding the page and leaving the player both store the last place reported.
  usePageLeave(() => {
    if (at.current > 0) store(Math.floor(at.current));
  });

  // The signed link expires on Academy's clock; past it, the player says so and offers a new one.
  const now = useNow(5000);
  const expired = Date.parse(playback.expiresAt) <= now;

  useTextTrackModes(
    media,
    tracks.map((track) => (track.language === captions ? 'showing' : 'disabled')),
    urls,
  );
  useEventListener(typeof document === 'undefined' ? null : document, 'fullscreenchange', () =>
    setFullScreen(document.fullscreenElement === frame.current),
  );

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

  const mediaEvents = {
    onLoadedMetadata: (event: SyntheticEvent<HTMLVideoElement>) => {
      const node = event.currentTarget;
      setDuration(Number.isFinite(node.duration) ? node.duration : null);
      node.playbackRate = speed;
      const from = lastSaved.current;
      if (from !== null && from > 0 && (!Number.isFinite(node.duration) || from < node.duration - 0.5)) {
        node.currentTime = from;
        at.current = from;
        setResumed(from);
      }
    },
    onTimeUpdate: (event: SyntheticEvent<HTMLVideoElement>) => {
      at.current = event.currentTarget.currentTime;
      setTime(at.current);
    },
    onPlay: () => setPlaying(true),
    onPause: (event: SyntheticEvent<HTMLVideoElement>) => {
      setPlaying(false);
      store(Math.floor(event.currentTarget.currentTime));
    },
    onEnded: (event: SyntheticEvent<HTMLVideoElement>) => store(Math.floor(event.currentTarget.currentTime)),
    onError: () => setLoadFailed(true),
  };
  /** The place is stored before the new link reads it back. */
  const renew = () => {
    store(position());
    void queue.current.then(() => {
      setLoadFailed(false);
      renewLink();
    });
  };
  const seekTo = (seconds: number) => {
    if (media.current) media.current.currentTime = seconds;
  };
  const changeSpeed = (next: number) => {
    setSpeed(next);
    if (media.current) media.current.playbackRate = next;
  };
  return {
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
  };
}
