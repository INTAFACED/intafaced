// volt-room: /pay/request/:requestId
// volt-room: /pay/claim/:token
// volt-room: /pay/scan
// volt-room: /pay/l/:linkId
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, EmptyState, StatusNote } from '@intafaced/ui/lit';
import { FileField, FlowTemplate, KeyValue, RefusalBox } from '@intafaced/ui/lit/templates';
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

/** The room on the flow template: its title and line, the body in the flow's main slot, and the way back to Pay under it. */
function Frame({ title, line, children }: { title: string; line: string; children: ReactNode }) {
  const { t } = roomsCopy.useCopy();
  return (
    <div data-testid="pay-room">
      <FlowTemplate
        title={title}
        description={line}
        state={{ kind: 'ready' }}
        step={
          <div className="lt-stack">
            {children}
            <a className="lt-link" href="/pay" data-testid="pay-room-back">
              {t('back')}
            </a>
          </div>
        }
      />
    </div>
  );
}

/** Why a room has nothing behind it yet, always on screen. `slice` is the work that connects it. */
function Blocked({ slice, children }: { slice: string; children: ReactNode }) {
  const { t } = roomsCopy.useCopy();
  return (
    <div id="pay-room-reason" role="note" data-testid="pay-reason" data-slice={slice}>
      <StatusNote title={t('blockedTitle')}>{children}</StatusNote>
    </div>
  );
}

/** Rows of a fact and its value. A value that is not known says so; it is never filled in. */
function Rows({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return <KeyValue rows={rows.map(([label, value]) => ({ label, value }))} />;
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
          <div className="lt-actions">
            <a className="lt-button lt-button-secondary" href={entry.path}>
              {t('requestOpen')}
            </a>
            <Button
              tone="quiet"
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
        <EmptyState
          title={gone ? t('requestRemoved') : t('requestMissingTitle')}
          body={t('requestMissingBody')}
          action={
            <a className="lt-button lt-button-secondary" href="/pay/request">
              {t('requestOpenRequest')}
            </a>
          }
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
      <h3>{t('claimStepsTitle')}</h3>
      <ol className="lt-steps" data-testid="pay-steps">
        {t('claimSteps')
          .split('|')
          .map((step) => (
            <li key={step} className="lt-step">
              <span className="lt-step-dot" aria-hidden="true" />
              <span>{step}</span>
            </li>
          ))}
      </ol>
      <Button type="button" tone="primary" size="lg" block disabled aria-describedby="pay-room-reason">
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
  const fileInput = useRef<HTMLInputElement>(null);

  const picked = async (file: File | null) => {
    const input = fileInput.current;
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
      if (input) input.value = '';
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
      <div className="lt-actions">
        <Button
          type="button"
          tone="secondary"
          disabled={reading}
          onClick={() => {
            setRefusal(null);
            setCamera((on) => !on);
          }}
        >
          {camera ? t('scanCameraStop') : t('scanCamera')}
        </Button>
        <a className="lt-button lt-button-secondary" href="/pay/receive">
          {t('scanShow')}
        </a>
      </div>
      {camera && (
        <>
          <video ref={video} muted playsInline aria-label={t('scanCameraLabel')} />
          <p className="lt-hint" role="status">
            {t('scanLooking')}
          </p>
        </>
      )}
      <FileField
        ref={fileInput}
        id="pay-scan-file"
        label={t('scanFile')}
        accept="image/*"
        disabled={reading}
        onChange={(file) => void picked(file)}
        data-testid="pay-scan-file"
      />
      {reading && (
        <p className="lt-hint" role="status">
          {t('scanReading')}
        </p>
      )}
      {refusal && (
        <div data-kind="refused">
          <RefusalBox refusal={{ variant: 'refused', title: t('scanRefusedTitle'), body: t(refusal), reference: refusal }} />
        </div>
      )}
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
      <Button type="button" tone="primary" size="lg" block disabled aria-describedby="pay-room-reason">
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
        <a className="lt-button lt-button-primary" href={loginHref}>
          {t('signInButton')}
        </a>
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
