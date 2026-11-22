import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Button, StateBlock } from '@intafaced/ui';
import { navigate } from '../../../../app/location';
import { usePreferences } from '../../../../shared/preferences';
import { stamp } from '../../../../screens/money/time';
import { useSession } from '../../../session';
import { readRequests, removeRequest } from '../personal-model';
import { cameraRefusal, payTarget, readCode, scanImage, ScanError, type ScanRefusal } from '../scan';
import { decodedSegment, type PersonalRoomMatch } from './rooms';
import { roomsCopy } from './rooms-copy';
import { SETTINGS_ROOM_IDS, SettingsRoom } from './SettingsRooms';
import { isServerRequestId } from '../requests';
import { ServerRequestRoom } from '../../../../screens/pay/ServerRequests';
import { PersonalRecordRoom } from '../../../../screens/pay/PersonalRecordRooms';

/** The room's layout: headline on the left, one card on the right, the way Send and Receive sit. */
function Frame({ title, line, children }: { title: string; line: string; children: ReactNode }) {
  const { t } = roomsCopy.useCopy();
  return (
    <div className="if-pay" data-testid="pay-room">
      <div className="pay-grid">
        <header data-testid="pay-hero" className="pay-hero">
          <h1>{title}</h1>
          <p>{line}</p>
        </header>
        <section data-testid="pay-card" className="pay-card" aria-label={title}>
          <div className="pay-body">
            {children}
            <a className="pay-recent__link" href="/pay" data-testid="pay-room-back">
              {t('back')}
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}

/** Why a room has nothing behind it yet, always on screen. `slice` is the work that connects it. */
function Blocked({ slice, children }: { slice: string; children: ReactNode }) {
  const { t } = roomsCopy.useCopy();
  return (
    <div className="pay-reason" id="pay-room-reason" role="note" data-testid="pay-reason" data-slice={slice}>
      <p className="pay-reason__title">{t('blockedTitle')}</p>
      <p className="pay-reason__body">{children}</p>
    </div>
  );
}

/** Rows of a fact and its value. A value that is not known says so; it is never filled in. */
function Rows({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="pay-quote">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RequestRoom({ id, slice }: { id: string | null; slice: string }) {
  const { t } = roomsCopy.useCopy();
  const { userId } = useSession();
  const { timeZone } = usePreferences();
  const [gone, setGone] = useState(false);
  const [notAtBank, setNotAtBank] = useState(false);
  const entry = useMemo(() => (userId && id ? (readRequests(userId).find((row) => row.id === id) ?? null) : null), [userId, id, gone]);
  // A request the bank keeps (PP-send-request-12): one this device did not make as a link, with a request id.
  if (id && !entry && !gone && !notAtBank && isServerRequestId(id))
    return (
      <Frame title={t('serverRequestTitle')} line={t('serverRequestLine')}>
        {/* A payment link made on another device has an id like a request's: the bank does not know it, so this falls back. */}
        <ServerRequestRoom id={id} onMissing={() => setNotAtBank(true)} />
      </Frame>
    );
  return (
    <Frame title={t('requestTitle')} line={t('requestLine')}>
      {entry ? (
        <>
          <Rows
            rows={[
              [t('requestTo'), entry.to],
              [t('requestAmount'), entry.amount && entry.asset ? `${entry.amount} ${entry.asset}` : t('requestAnyAmount')],
              [t('requestNote'), entry.note ?? t('notSet')],
              [t('requestMade'), <span lang="zxx">{stamp(entry.at, timeZone, Date.now())}</span>],
              [t('requestStatus'), t('requestStatusBody')],
            ]}
          />
          <div className="pay-row-actions">
            <Button variant="secondary" size={40} nativeButton={false} render={<a href={entry.path} />}>
              {t('requestOpen')}
            </Button>
            <Button
              variant="ghost"
              size={40}
              onClick={() => {
                if (userId) removeRequest(userId, entry.id);
                setGone(true);
              }}
            >
              {t('requestRemove')}
            </Button>
          </div>
        </>
      ) : (
        <StateBlock
          kind="empty"
          title={gone ? t('requestRemoved') : t('requestMissingTitle')}
          body={t('requestMissingBody')}
          action={{ label: t('requestOpenRequest'), href: '/pay/request' }}
        />
      )}
      <Blocked slice={slice}>{t('requestReason')}</Blocked>
    </Frame>
  );
}

function ClaimRoom({ slice }: { slice: string }) {
  const { t } = roomsCopy.useCopy();
  return (
    <Frame title={t('claimTitle')} line={t('claimLine')}>
      <h3 className="pay-section-title">{t('claimStepsTitle')}</h3>
      <ol className="pay-steps" data-testid="pay-steps">
        {t('claimSteps')
          .split('|')
          .map((step) => (
            <li key={step}>{step}</li>
          ))}
      </ol>
      <Button type="button" variant="primary" size={56} fullWidth disabled aria-describedby="pay-room-reason">
        {t('claimButton')}
      </Button>
      <Blocked slice={slice}>{t('claimReason')}</Blocked>
    </Frame>
  );
}

/** How often a camera frame is read for a code. */
const FRAME_MS = 250;

function ScanRoom({ slice }: { slice: string }) {
  const { t } = roomsCopy.useCopy();
  const [refusal, setRefusal] = useState<ScanRefusal | null>(null);
  const [reading, setReading] = useState(false);
  const [camera, setCamera] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  const picked = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setCamera(false);
    setRefusal(null);
    setReading(true);
    try {
      navigate(await scanImage(file, window.location.origin));
    } catch (err) {
      setRefusal(err instanceof ScanError ? err.code : 'scan.unreadable');
    } finally {
      setReading(false);
      // The same image chosen again after a refusal is read again.
      input.value = '';
    }
  };

  useEffect(() => {
    if (!camera) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    const refuse = (code: ScanRefusal) => {
      if (stopped) return;
      setCamera(false);
      setRefusal(code);
    };
    void (async () => {
      if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return refuse('scan.camera_unavailable');
      let opened: MediaStream;
      try {
        opened = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      } catch (err) {
        return refuse(cameraRefusal(err));
      }
      stream = opened;
      // Stopped while the browser was still asking: release the camera it just gave.
      if (stopped || !video.current) return opened.getTracks().forEach((track) => track.stop());
      try {
        video.current.srcObject = opened;
        await video.current.play();
      } catch {
        return refuse('scan.camera_unavailable');
      }
      let last = '';
      while (!stopped && video.current) {
        const frame = video.current;
        const text = frame.videoWidth > 0 ? await readCode(frame, frame.videoWidth, frame.videoHeight).catch(() => null) : null;
        if (stopped) return;
        if (text && text !== last) {
          last = text;
          try {
            return navigate(payTarget(text, window.location.origin));
          } catch {
            // Another code in view: say so and keep looking for a pay code.
            setRefusal('scan.not_pay_code');
          }
        }
        await new Promise((resolve) => setTimeout(resolve, FRAME_MS));
      }
    })();
    return () => {
      stopped = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [camera]);

  return (
    <Frame title={t('scanTitle')} line={t('scanLine')}>
      <div className="pay-row-actions">
        <Button
          type="button"
          variant="secondary"
          size={40}
          disabled={reading}
          onClick={() => {
            setRefusal(null);
            setCamera((on) => !on);
          }}
        >
          {camera ? t('scanCameraStop') : t('scanCamera')}
        </Button>
        <Button variant="secondary" size={40} nativeButton={false} render={<a href="/pay/receive" />}>
          {t('scanShow')}
        </Button>
      </div>
      {camera && (
        <>
          <video ref={video} className="pay-scan-video" muted playsInline aria-label={t('scanCameraLabel')} />
          <p className="lt-hint" role="status">
            {t('scanLooking')}
          </p>
        </>
      )}
      <div className="pay-field">
        <label className="pay-field__label" htmlFor="pay-scan-file">
          {t('scanFile')}
        </label>
        <input
          id="pay-scan-file"
          className="pay-text"
          type="file"
          accept="image/*"
          disabled={reading}
          onChange={(event) => void picked(event)}
          data-testid="pay-scan-file"
        />
      </div>
      {reading && (
        <p className="lt-hint" role="status">
          {t('scanReading')}
        </p>
      )}
      {refusal && <StateBlock kind="refused" title={t('scanRefusedTitle')} body={t(refusal)} code={refusal} />}
      <Blocked slice={slice}>{t('scanReason')}</Blocked>
    </Frame>
  );
}

function LinkRoom({ id, slice }: { id: string | null; slice: string }) {
  const { t } = roomsCopy.useCopy();
  return (
    <Frame title={t('linkTitle')} line={t('linkLine')}>
      <Rows
        rows={[
          [t('reference'), id ?? t('notSet')],
          [t('linkFrom'), t('notSet')],
          [t('linkAmount'), t('notSet')],
          [t('linkFor'), t('notSet')],
        ]}
      />
      <Button type="button" variant="primary" size={56} fullWidth disabled aria-describedby="pay-room-reason">
        {t('linkPay')}
      </Button>
      <Blocked slice={slice}>
        {t('linkReason')} {t('linkCheckout')}
      </Blocked>
    </Frame>
  );
}

/** One personal Pay room, picked by the matched address. A signed-out visitor is sent to sign in and nothing is read. */
export function PersonalRoom({ match }: { match: PersonalRoomMatch }) {
  const { t } = roomsCopy.useCopy();
  const { session } = useSession();
  // The settings rooms are on their template, and say sign in there themselves.
  if (SETTINGS_ROOM_IDS.has(match.room.id)) return <SettingsRoom match={match} />;
  if (!session) {
    const loginHref = `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
    return (
      <Frame title={t('pay')} line={t('signIn')}>
        <Button variant="primary" size={56} fullWidth nativeButton={false} render={<a href={loginHref} role="link" />}>
          {t('signInButton')}
        </Button>
      </Frame>
    );
  }
  return <RoomBody match={match} />;
}

function RoomBody({ match }: { match: PersonalRoomMatch }) {
  const { room, params } = match;
  const slice = room.slice;
  switch (room.id) {
    case 'request':
      return <RequestRoom id={decodedSegment(params.requestId)} slice={slice} />;
    case 'claim':
      return <ClaimRoom slice={slice} />;
    case 'scan':
      return <ScanRoom slice={slice} />;
    case 'link':
      return <LinkRoom id={decodedSegment(params.linkId)} slice={slice} />;
    case 'scheduled':
    case 'payment':
    case 'cases':
    case 'case':
    case 'invoice':
      return <PersonalRecordRoom match={match} />;
  }
}
