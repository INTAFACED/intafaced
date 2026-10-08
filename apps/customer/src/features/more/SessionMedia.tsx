import { t as copyText, Text } from './copy';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { Button, Failure } from '../../shared/ui';
import type { ApiResult } from '../../shared/api';
type MediaTrack = { kind: string; attach: () => HTMLMediaElement; detach: () => HTMLMediaElement[] };
type LocalParticipant = {
  permissions?: { canPublish?: boolean };
  isMicrophoneEnabled: boolean;
  isCameraEnabled: boolean;
  isScreenShareEnabled: boolean;
  setMicrophoneEnabled: (enabled: boolean) => Promise<unknown>;
  setCameraEnabled: (enabled: boolean) => Promise<unknown>;
  setScreenShareEnabled: (enabled: boolean) => Promise<unknown>;
};
type Room = {
  state: string;
  localParticipant: LocalParticipant;
  canPlaybackAudio: boolean;
  on: (event: string, handler: (...args: unknown[]) => void) => Room;
  connect: (url: string, token: string) => Promise<void>;
  disconnect: (stopTracks?: boolean) => Promise<void>;
  startAudio: () => Promise<void>;
};
type Sdk = {
  Room: new (options: { adaptiveStream: boolean; dynacast: boolean }) => Room;
  RoomEvent: Record<string, string>;
  Track: { Kind: { Audio: string; Video: string } };
};
declare global {
  interface Window {
    LivekitClient?: Sdk;
  }
}
let sdkPromise: Promise<Sdk> | null = null;
function sdk() {
  if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('./vendor/livekit-client.umd.js', import.meta.url).href;
    script.onload = () =>
      window.LivekitClient ? resolve(window.LivekitClient) : reject(new Error('The media client did not expose its published API.'));
    script.onerror = () => {
      script.remove();
      sdkPromise = null;
      reject(new Error('The media client could not be loaded.'));
    };
    document.head.appendChild(script);
  });
  return sdkPromise;
}
function track(value: unknown): MediaTrack | null {
  if (typeof value !== 'object' || value === null) return null;
  const t = value as Partial<MediaTrack>;
  return typeof t.kind === 'string' && typeof t.attach === 'function' && typeof t.detach === 'function' ? (t as MediaTrack) : null;
}
const credential = z.object({ url: z.string().url(), token: z.string().min(1), expiresAt: z.string().datetime({ offset: true }) });
export function SessionMedia({ sessionId, sessionStatus }: { sessionId: string; sessionStatus: string }) {
  const api = useApi(),
    { userId } = useSession(),
    media = useRef<HTMLDivElement>(null),
    current = useRef<Room | null>(null),
    generation = useRef(0),
    actor = useRef(userId);
  actor.current = userId;
  const [phase, setPhase] = useState('disconnected'),
    [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null),
    [revision, setRevision] = useState(0);
  const connecting = phase === 'credentials' || phase === 'connecting';
  function leave() {
    generation.current++;
    const room = current.current;
    current.current = null;
    void room?.disconnect(true);
    media.current?.replaceChildren();
    setPhase('disconnected');
    setRevision((v) => v + 1);
  }
  useEffect(() => {
    leave();
    setFailure(null);
    return () => {
      generation.current++;
      const room = current.current;
      current.current = null;
      void room?.disconnect(true);
    };
  }, [sessionId, userId, sessionStatus]);
  async function connect() {
    if (!userId || connecting || sessionStatus !== 'live') return;
    const actorId = userId,
      run = ++generation.current;
    setFailure(null);
    setPhase('credentials');
    const res = await api.mutate('academy', 'streamCredential', { sessionId }, credential);
    if (run !== generation.current || actor.current !== actorId) return;
    if (!res.ok) {
      setFailure(res);
      setPhase('disconnected');
      return;
    }
    if (Date.parse(res.data.expiresAt) <= Date.now()) {
      setFailure({
        ok: false,
        reason: 'invalid_response',
        message: copyText('sessionmedia.the.service.returned.an.expired.media.credential'),
      });
      setPhase('disconnected');
      return;
    }
    const endpoint = new URL(res.data.url);
    if (
      !['https:', 'wss:'].includes(endpoint.protocol) &&
      !(endpoint.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))
    ) {
      setFailure({ ok: false, reason: 'invalid_response', message: copyText('sessionmedia.the.service.media.url.is.not.secure') });
      setPhase('disconnected');
      return;
    }
    setPhase('connecting');
    try {
      const client = await sdk();
      if (run !== generation.current || actor.current !== actorId) return;
      const room = new client.Room({ adaptiveStream: true, dynacast: true });
      current.current = room;
      const attach = (value: unknown, local = false) => {
        if (run !== generation.current) return;
        const t = track(value);
        if (!t || ![client.Track.Kind.Audio, client.Track.Kind.Video].includes(t.kind)) return;
        const element = t.attach();
        element.controls = true;
        element.autoplay = true;
        element.setAttribute('playsinline', '');
        if (local) element.muted = true;
        element.setAttribute(
          'aria-label',
          local ? copyText('sessionmedia.your.published.media') : copyText('sessionmedia.session.participant.media'),
        );
        media.current?.appendChild(element);
      };
      room.on(client.RoomEvent.TrackSubscribed!, (value) => attach(value));
      room.on(client.RoomEvent.TrackUnsubscribed!, (value) =>
        track(value)
          ?.detach()
          .forEach((element) => element.remove()),
      );
      room.on(client.RoomEvent.LocalTrackPublished!, (publication) => {
        if (run !== generation.current) return;
        if (typeof publication === 'object' && publication !== null) attach(Reflect.get(publication, 'track'), true);
        setRevision((v) => v + 1);
      });
      room.on(client.RoomEvent.LocalTrackUnpublished!, (publication) => {
        if (run !== generation.current) return;
        if (typeof publication === 'object' && publication !== null)
          track(Reflect.get(publication, 'track'))
            ?.detach()
            .forEach((element) => element.remove());
        setRevision((v) => v + 1);
      });
      room.on(client.RoomEvent.AudioPlaybackStatusChanged!, () => {
        if (run === generation.current) setRevision((v) => v + 1);
      });
      room.on(client.RoomEvent.ParticipantPermissionsChanged!, () => {
        if (run === generation.current) setRevision((v) => v + 1);
      });
      room.on(client.RoomEvent.Disconnected!, () => {
        if (run !== generation.current) return;
        current.current = null;
        media.current?.replaceChildren();
        setPhase('disconnected');
        setRevision((v) => v + 1);
      });
      await room.connect(res.data.url, res.data.token);
      if (run !== generation.current || actor.current !== actorId) {
        void room.disconnect(true);
        return;
      }
      if (room.state !== 'connected') throw new Error('The media server did not establish a connected session.');
      setPhase('connected');
      setRevision((v) => v + 1);
    } catch {
      if (run !== generation.current) return;
      const room = current.current;
      current.current = null;
      void room?.disconnect(true);
      setPhase('disconnected');
      setFailure({
        ok: false,
        reason: 'unreachable',
        message: copyText('sessionmedia.the.audio.video.server.could.not.establish'),
      });
    }
  }
  async function toggle(kind: 'microphone' | 'camera' | 'screen') {
    const room = current.current;
    if (!room || room.state !== 'connected' || room.localParticipant.permissions?.canPublish !== true) return;
    setFailure(null);
    try {
      if (kind === 'microphone') await room.localParticipant.setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled);
      else if (kind === 'camera') await room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled);
      else await room.localParticipant.setScreenShareEnabled(!room.localParticipant.isScreenShareEnabled);
      if (current.current === room) setRevision((v) => v + 1);
    } catch {
      if (current.current === room)
        setFailure({
          ok: false,
          reason: 'error',
          message: copyText('sessionmedia.the.could.not.be.enabled.check.browser', { value1: kind }),
        });
    }
  }
  async function enableAudio() {
    const room = current.current;
    if (!room) return;
    try {
      await room.startAudio();
      if (current.current === room) setRevision((v) => v + 1);
    } catch {
      if (current.current === room)
        setFailure({ ok: false, reason: 'error', message: copyText('sessionmedia.session.audio.could.not.be.started.check') });
    }
  }
  const room = current.current,
    publish = room?.localParticipant.permissions?.canPublish === true;
  return (
    <section className="more-media" aria-label={copyText('sessionmedia.session.audio.and.video')} data-revision={revision}>
      <p role="status">
        <Text k="sessionmedia.audio.video" />
        {phase}
      </p>
      {phase === 'connected' ? (
        <div className="actions">
          <Button variant="secondary" onClick={leave}>
            <Text k="sessionmedia.disconnect.media" />
          </Button>
          {!room?.canPlaybackAudio && (
            <Button variant="secondary" onClick={() => void enableAudio()}>
              <Text k="sessionmedia.enable.session.audio" />
            </Button>
          )}
          {publish ? (
            <>
              <Button variant="secondary" onClick={() => void toggle('microphone')}>
                {room?.localParticipant.isMicrophoneEnabled
                  ? copyText('sessionmedia.mute.microphone')
                  : copyText('sessionmedia.enable.microphone')}
              </Button>
              <Button variant="secondary" onClick={() => void toggle('camera')}>
                {room?.localParticipant.isCameraEnabled ? copyText('sessionmedia.disable.camera') : copyText('sessionmedia.enable.camera')}
              </Button>
              <Button variant="secondary" onClick={() => void toggle('screen')}>
                {room?.localParticipant.isScreenShareEnabled
                  ? copyText('sessionmedia.stop.screen.share')
                  : copyText('sessionmedia.share.screen')}
              </Button>
            </>
          ) : (
            <p className="muted">
              <Text k="sessionmedia.your.service.grant.permits.receiving.media.publishing" />
            </p>
          )}
        </div>
      ) : (
        <Button variant="secondary" disabled={!userId || connecting || sessionStatus !== 'live'} onClick={() => void connect()}>
          <Text k="sessionmedia.connect.audio.video" />
        </Button>
      )}
      <p className="muted">
        <Text k="sessionmedia.join.the.session.seat.first.camera.and" />
      </p>
      {failure && <Failure result={failure} />}
      <div className="more-media-tracks" ref={media} />
    </section>
  );
}
