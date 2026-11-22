import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Button, EmptyState, Field } from '@intafaced/ui/lit';
import { FlowTemplate, KeyValue, RefusalBox, type KeyValueRow, type RoomState } from '@intafaced/ui/lit/templates';
import { navigate } from '../../app/location';
import { usePreferences } from '../../shared/preferences';
import { stamp } from '../money/time';
import { useSession } from '../../features/session/session';
import { readRequests, removeRequest } from '../../features/pay/personal/personal-model';
import { cameraRefusal, payTarget, readCode, scanImage, ScanError, type ScanRefusal } from '../../features/pay/personal/scan';
import { decodedSegment, type PersonalRoomId, type PersonalRoomMatch } from '../../features/pay/personal/rooms/rooms';
import { roomsCopy } from '../../features/pay/personal/rooms/rooms-copy';
import { isServerRequestId } from '../../features/pay/personal/requests';
import { ServerRequestRoom } from './ServerRequests';

/**
 * The personal Pay rooms on the flow template: Scan to pay, a payment request, a claim and a payment link (PP-order-02).
 * Each keeps its address, its words and its controls; where nothing stands behind a room yet it says what is missing.
 */
const FLOW_ROOMS: ReadonlySet<PersonalRoomId> = new Set<PersonalRoomId>(['scan', 'request', 'claim', 'link']);

/** True for the personal rooms drawn here, on the flow template. */
export function isPersonalFlowRoom(id: PersonalRoomId): boolean {
  return FLOW_ROOMS.has(id);
}

const READY: RoomState = { kind: 'ready' };

/** One flow room with the way back to Pay under its actions. */
function Room({
  title,
  line,
  state = READY,
  step,
  actions,
  summary,
}: {
  title: string;
  line: string;
  state?: RoomState;
  step?: ReactNode;
  actions?: ReactNode;
  summary?: ReactNode;
}) {
  const { t } = roomsCopy.useCopy();
  return (
    <div data-testid="pay-room">
      <FlowTemplate
        title={title}
        description={line}
        state={state}
        step={step}
        summary={summary}
        actions={
          <div className="lt-actions">
            {actions}
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
function Blocked({ slice, body }: { slice: string; body: string }) {
  const { t } = roomsCopy.useCopy();
  return (
    <div id="pay-room-reason" role="note" data-testid="pay-reason" data-slice={slice}>
      <RefusalBox refusal={{ variant: 'parked', title: t('blockedTitle'), body }} />
    </div>
  );
}

/** Facts and their values. A value that is not known says so; it is never filled in. */
function Facts({ rows }: { rows: readonly KeyValueRow[] }) {
  return <KeyValue rows={rows} />;
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
      <Room
        title={t('serverRequestTitle')}
        line={t('serverRequestLine')}
        // A payment link made on another device has an id like a request's: the bank does not know it, so this falls back.
        step={<ServerRequestRoom id={id} onMissing={() => setNotAtBank(true)} />}
      />
    );
  return (
    <Room
      title={t('requestTitle')}
      line={t('requestLine')}
      step={
        <>
          {entry ? (
            <Facts
              rows={[
                { label: t('requestTo'), value: entry.to },
                {
                  label: t('requestAmount'),
                  value: entry.amount && entry.asset ? `${entry.amount} ${entry.asset}` : t('requestAnyAmount'),
                },
                { label: t('requestNote'), value: entry.note ?? t('notSet'), unset: entry.note === undefined || entry.note === null },
                { label: t('requestMade'), value: <span lang="zxx">{stamp(entry.at, timeZone, Date.now())}</span> },
                { label: t('requestStatus'), value: t('requestStatusBody') },
              ]}
            />
          ) : (
            <EmptyState
              title={gone ? t('requestRemoved') : t('requestMissingTitle')}
              body={t('requestMissingBody')}
              action={
                <a className="lt-button lt-button-primary" href="/pay/request">
                  {t('requestOpenRequest')}
                </a>
              }
            />
          )}
          <Blocked slice={slice} body={t('requestReason')} />
        </>
      }
      actions={
        entry ? (
          <>
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
          </>
        ) : null
      }
    />
  );
}

function ClaimRoom({ slice }: { slice: string }) {
  const { t } = roomsCopy.useCopy();
  return (
    <Room
      title={t('claimTitle')}
      line={t('claimLine')}
      step={
        <>
          <h3>{t('claimStepsTitle')}</h3>
          <ol data-testid="pay-steps">
            {t('claimSteps')
              .split('|')
              .map((step) => (
                <li key={step}>{step}</li>
              ))}
          </ol>
          <Blocked slice={slice} body={t('claimReason')} />
        </>
      }
      actions={
        <Button tone="primary" size="lg" block disabled aria-describedby="pay-room-reason">
          {t('claimButton')}
        </Button>
      }
    />
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
    <Room
      title={t('scanTitle')}
      line={t('scanLine')}
      step={
        <>
          {camera && (
            <>
              <video ref={video} muted playsInline aria-label={t('scanCameraLabel')} />
              <p className="lt-hint" role="status">
                {t('scanLooking')}
              </p>
            </>
          )}
          <Field
            label={t('scanFile')}
            id="pay-scan-file"
            type="file"
            accept="image/*"
            disabled={reading}
            onChange={(event) => void picked(event)}
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
          <Blocked slice={slice} body={t('scanReason')} />
        </>
      }
      actions={
        <>
          <Button
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
        </>
      }
    />
  );
}

function LinkRoom({ id, slice }: { id: string | null; slice: string }) {
  const { t } = roomsCopy.useCopy();
  return (
    <Room
      title={t('linkTitle')}
      line={t('linkLine')}
      step={<Blocked slice={slice} body={`${t('linkReason')} ${t('linkCheckout')}`} />}
      summary={
        <Facts
          rows={[
            { label: t('reference'), value: id ?? t('notSet'), unset: id === null, ltr: id !== null },
            { label: t('linkFrom'), value: t('notSet'), unset: true },
            { label: t('linkAmount'), value: t('notSet'), unset: true },
            { label: t('linkFor'), value: t('notSet'), unset: true },
          ]}
        />
      }
      actions={
        <Button tone="primary" size="lg" block disabled aria-describedby="pay-room-reason">
          {t('linkPay')}
        </Button>
      }
    />
  );
}

/** A signed-out visitor is sent to sign in and nothing is read. */
function SignedOut() {
  const { t } = roomsCopy.useCopy();
  const loginHref = `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
  return (
    <Room
      title={t('pay')}
      line={t('signIn')}
      actions={
        <a className="lt-button lt-button-primary" href={loginHref} role="link">
          {t('signInButton')}
        </a>
      }
    />
  );
}

/** Scan, a request, a claim or a payment link, picked by the matched address. */
export function PersonalFlowRoom({ match }: { match: PersonalRoomMatch }) {
  const { session } = useSession();
  if (!session) return <SignedOut />;
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
    default:
      return null;
  }
}
