import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import type { AcademyVideoPlayback, AcademyVideoPlayer } from '@intafaced/contracts/academy-catalogue';
import { SessionProvider } from '../session/session';
import { VideoPlayerView, activeCue, clock, cuePlainText, cuesToVtt } from './AcademyVideoPlayer';

const html = (node: React.ReactNode) => renderToStaticMarkup(<SessionProvider>{node}</SessionProvider>);
const save = async (positionSeconds: number) => ({ ok: true as const, data: { positionSeconds, completedItems: [] } });

const playback: AcademyVideoPlayback = {
  slug: 'v',
  playbackUrl: 'http://127.0.0.1:1/bucket/v.webm?X-Amz-Signature=00',
  expiresAt: '2999-01-01T00:00:00.000Z',
  grant: 'v1.1.00',
};
const cues = [
  { startMs: 0, endMs: 2500, text: 'TEST first line' },
  { startMs: 2500, endMs: 61_000, text: 'TEST second line' },
];
const player = (over: Partial<AcademyVideoPlayer> = {}): AcademyVideoPlayer => ({
  slug: 'v',
  title: 'TEST video',
  renditions: [{ id: 'original' }],
  tracks: [
    { language: 'en', label: 'TEST English', cues },
    { language: 'es', label: 'TEST Español', cues: [{ startMs: 0, endMs: 1000, text: 'TEST primera' }] },
  ],
  saveEverySeconds: 2,
  watchThresholdSeconds: 4,
  ...over,
});
const view = (p: AcademyVideoPlayer, at: number | null = null, link = playback) =>
  html(<VideoPlayerView player={p} playback={link} resumeAt={at} save={save} renewLink={() => undefined} />);

describe('video player (AC-videos-01)', () => {
  it('has our own controls: play, time, seek, speed, the one quality that exists, captions by language and full screen', () => {
    const out = view(player());
    expect(out).toContain('data-video-player="v"');
    expect(out).toContain('aria-label="Video controls"');
    for (const word of ['Play', 'Speed', 'Quality', 'Original file', 'Captions', 'Full screen', 'Mute']) expect(out).toContain(word);
    for (const speed of ['0.5×', '1×', '2×']) expect(out).toContain(speed);
    expect(out).toContain('Only the original file exists for this video');
    expect(out).toMatch(
      /<option value="" selected="">Off<\/option><option value="en" lang="en">TEST English<\/option><option value="es" lang="es">TEST Español<\/option>/,
    );
    // The track files are made in the browser (academy-video.dom.test.tsx); a server render has none yet.
    expect(out).not.toContain('<track');
    expect(out).toContain('Keys: Space or K plays and pauses');
  });

  it('shows the transcript as cues that seek, the save interval and the watch threshold', () => {
    const out = view(player());
    expect(out).toContain('data-transcript="en"');
    expect(out).toContain('TEST first line');
    expect(out).toContain('0:02</span> TEST second line');
    expect(out).toContain('Your place is saved every 2 seconds while the video plays');
    expect(out).toContain('Watching past 0:04 completes this item.');
  });

  it('with no captions the menu says so, no empty track is attached, and the transcript says there is none', () => {
    const out = view(player({ tracks: [], saveEverySeconds: null, watchThresholdSeconds: null }));
    expect(out).toContain('data-video-captions="none"');
    expect(out).toContain('No captions for this video');
    expect(out).not.toContain('<track');
    expect(out).toContain('This video has no transcript.');
    expect(out).toContain('Academy has no save interval set for playback.');
    expect(out).toContain('Academy has no watch threshold set');
  });

  it('an expired link says so and offers a new one, and the element stays so the place is kept', () => {
    const out = view(player(), null, { ...playback, expiresAt: '2000-01-01T00:00:00.000Z' });
    expect(out).toContain('The playback link expired.');
    expect(out).toContain('Request a new link');
    expect(out).toContain('<video');
    expect(view(player())).not.toContain('data-video-expired');
  });

  it('the transcript reads cue words without WebVTT tags or entities', () => {
    const marked = [{ startMs: 0, endMs: 1000, text: '<v TEST Speaker>Risk &amp; <i>reward</i> &lt;3' }];
    expect(cuePlainText(marked[0]!.text)).toBe('Risk & reward <3');
    const out = view(player({ tracks: [{ language: 'en', label: 'TEST English', cues: marked }] }));
    expect(out).toContain('0:00</span> Risk &amp; reward &lt;3');
    expect(out).not.toContain('&lt;v TEST');
  });

  it('times, cues and the WebVTT the browser renders', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(61.9)).toBe('1:01');
    expect(clock(3725)).toBe('1:02:05');
    expect(activeCue(cues, 2.5)).toBe(1);
    expect(activeCue(cues, 70)).toBe(-1);
    expect(cuesToVtt(cues)).toBe(
      'WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nTEST first line\n\n00:00:02.500 --> 00:01:01.000\nTEST second line\n',
    );
  });
});
