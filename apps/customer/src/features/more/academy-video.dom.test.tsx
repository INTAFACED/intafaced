// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { AcademyVideoPlayback, AcademyVideoPlayer } from '@intafaced/contracts/academy-catalogue';
import { VideoPlayerView } from './AcademyVideoPlayer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const playback: AcademyVideoPlayback = {
  slug: 'v',
  playbackUrl: 'http://127.0.0.1:1/bucket/v.webm?X-Amz-Signature=00',
  expiresAt: '2999-01-01T00:00:00.000Z',
  grant: 'v1.1.00',
};
const player: AcademyVideoPlayer = {
  slug: 'v',
  title: 'TEST video',
  renditions: [{ id: 'original' }],
  tracks: [
    { language: 'en', label: 'TEST English', cues: [{ startMs: 0, endMs: 1000, text: 'TEST one' }] },
    { language: 'es', label: 'TEST Español', cues: [{ startMs: 0, endMs: 1000, text: 'TEST uno' }] },
  ],
  saveEverySeconds: null,
  watchThresholdSeconds: 4,
};

describe('video player in the browser (AC-videos-01)', () => {
  it('attaches each caption track as a file, saves the place in order, says complete once and keeps saying it', async () => {
    const saves: number[] = [];
    const completed: string[][] = [];
    const save = vi.fn(async (positionSeconds: number) => {
      saves.push(positionSeconds);
      return { ok: true as const, data: { positionSeconds, completedItems: positionSeconds >= 4 ? ['TEST-item'] : [] } };
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <VideoPlayerView
          player={player}
          playback={playback}
          resumeAt={null}
          save={save}
          renewLink={() => undefined}
          onCompleted={(items) => completed.push(items)}
        />,
      ),
    );
    const tracks = host.querySelectorAll('track');
    expect(tracks).toHaveLength(2);
    expect(tracks[0]!.getAttribute('src')).toMatch(/^blob:/);
    expect(tracks[1]!.getAttribute('srclang')).toBe('es');

    const video = host.querySelector('video')!;
    const event = async (name: string, seconds?: number) => {
      if (seconds !== undefined) Object.defineProperty(video, 'currentTime', { value: seconds, configurable: true, writable: true });
      await act(async () => {
        video.dispatchEvent(new Event(name));
        await Promise.resolve();
      });
    };
    const status = () => host.querySelector('[data-video-status]');

    await event('pause', 3);
    expect(status()?.getAttribute('data-video-status')).toBe('saved');
    await event('pause', 5);
    expect(status()?.getAttribute('data-video-status')).toBe('completed');
    await event('pause', 6);
    expect(status()?.getAttribute('data-video-status')).toBe('completed');
    expect(completed).toEqual([['TEST-item']]);

    // Leaving saves the last place the element reported, once.
    await event('timeupdate', 7);
    await act(async () => root.unmount());
    await vi.waitFor(() => expect(saves).toEqual([3, 5, 6, 7]));
    host.remove();
  });
});
