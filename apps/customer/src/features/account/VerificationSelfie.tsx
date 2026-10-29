import { useEffect, useMemo, useRef, useState } from 'react';
import {
  kycSelfieHandoffCheckSchema,
  kycSelfieHandoffSchema,
  kycSelfieReadSchema,
  kycSelfieSchema,
  type KycSelfie,
  type KycSelfieHandoff,
  type KycSelfieRead,
} from '@intafaced/contracts/identity-kyc-selfie';
import type { ApiResult } from '../../shared/api';
import { base64Of, kib } from '../../shared/file-base64';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, Failure, Loading } from '../../shared/ui';
import { encodeQr, qrPath } from '../pay/personal/qr';
import { verificationSelfieCopy as copy } from './verification-selfie-copy';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type Problem = { kind: 'copy'; text: string } | { kind: 'failure'; result: Refusal; retry?: () => void };
/** `done`: this page just used the link. `broken`: the page was opened with a link that is not whole. */
type LinkState = 'open' | 'done' | 'used' | 'expired' | 'unknown' | 'broken';
const statusKey = { provided: 'statusProvided', accepted: 'statusAccepted', rejected: 'statusRejected' } as const;
const viaKey = { this_device: 'viaThisDevice', handoff: 'viaHandoff' } as const;
const linkKey = {
  open: 'handoffOpen',
  done: 'handoffDone',
  used: 'handoffUsed',
  expired: 'handoffExpired',
  unknown: 'handoffUnknown',
  broken: 'handoffBroken',
} as const;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** How often the computer re-reads the latest selfie while its phone link is on screen. */
const PHONE_POLL_MS = 4000;

/** The hand-off this page was opened with (`/verification?handoff=…`): none, a whole token, or one that is not whole. */
function handoffFromUrl(): { token: string | null; broken: boolean } {
  const raw = new URLSearchParams(window.location.search).get('handoff');
  if (raw === null) return { token: null, broken: false };
  return TOKEN.test(raw) ? { token: raw, broken: false } : { token: null, broken: true };
}

/** The link as a QR code, dark on light in every theme because that is what a scanner needs; says so when it cannot be made. */
function PhoneCode({ value, label, failed }: { value: string; label: string; failed: string }) {
  const drawn = useMemo(() => {
    try {
      return qrPath(encodeQr(value, 'M'), 2);
    } catch {
      return null;
    }
  }, [value]);
  if (!drawn) return <p data-testid="verification__selfie-qr-failed">{failed}</p>;
  return (
    <div className="verification__selfie-qr" data-testid="verification__selfie-qr">
      <svg viewBox={`0 0 ${drawn.size} ${drawn.size}`} role="img" aria-label={label} shapeRendering="crispEdges">
        <path d={drawn.d} fill="black" /* look-drift-allow: a QR code needs dark on light in every theme */ />
      </svg>
    </div>
  );
}

/** One frame from the live camera as a JPEG. */
function grab(video: HTMLVideoElement): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d');
  if (!context || !canvas.width || !canvas.height) return Promise.resolve(null);
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}

/**
 * I-kyc-compliance-09 (J-identity-08 #3): the selfie on /verification. It is taken live with the camera (no gallery
 * upload), on this device or on the person's phone through a one-time link shown as a code. The automatic face match
 * and liveness check are not connected, so the page says a person compares the selfie with the ID photo. A link opened
 * on the phone says whether it can still be used; a used, expired or other account's link is refused in plain words.
 */
export function VerificationSelfie({ recordsKey, disabled }: { recordsKey: string; disabled: boolean }) {
  const { api, userId } = useSession();
  const { t, Copy } = copy.useCopy();
  const { resource, reload } = useResource(
    (signal) => api.query('identity', 'kyc.selfie.read', undefined, kycSelfieReadSchema, { signal }),
    `verification-selfie:${userId}:${recordsKey}`,
  );
  const [opened] = useState(handoffFromUrl);
  const token = opened.token;
  const [link, setLink] = useState<LinkState | null>(opened.broken ? 'broken' : null);
  const [checks, setChecks] = useState(0);
  /** On the computer: the latest selfie's id when the phone link was made, so a newer one from the phone shows. */
  const [before, setBefore] = useState<string | null>(null);
  const [linkExpired, setLinkExpired] = useState(false);
  const [handoff, setHandoff] = useState<KycSelfieHandoff | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [sent, setSent] = useState<KycSelfie | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const last = useRef<KycSelfieRead | null>(null);
  if (resource.status === 'ready') last.current = resource.data;
  // `reload` is a new function each render; the phone poll reads the latest through this ref so it keeps one timer.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    void api
      .query('identity', 'kyc.selfie.handoff.check', { token }, kycSelfieHandoffCheckSchema, { signal: controller.signal })
      .then((answer) => {
        if (controller.signal.aborted) return;
        if (answer.ok) {
          setProblem(null);
          setLink(answer.data.state);
        } else if (answer.code === 'kyc.handoff_unknown') setLink('unknown');
        else setProblem({ kind: 'failure', result: answer, retry: () => setChecks((n) => n + 1) });
      });
    return () => controller.abort();
  }, [api, token, userId, checks]);

  // On the computer, while the phone link is on screen: re-read the latest selfie, and say when the link runs out.
  useEffect(() => {
    if (!handoff) return;
    setLinkExpired(false);
    const poll = window.setInterval(() => reloadRef.current(), PHONE_POLL_MS);
    const expiry = window.setTimeout(() => setLinkExpired(true), Math.max(0, Date.parse(handoff.expiresAt) - Date.now()));
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(expiry);
    };
  }, [handoff]);

  // The camera is released when the page closes it, sends, or goes away.
  useEffect(() => {
    if (video.current && stream) video.current.srcObject = stream;
    return () => stream?.getTracks().forEach((track) => track.stop());
  }, [stream]);

  const data = resource.status === 'ready' ? resource.data : last.current;
  const caps = data?.uploadCaps ?? null;
  const viaLink = token !== null && link === 'open';
  const linkRefused = link !== null && link !== 'open' && link !== 'done';
  const fromPhone = handoff && data?.latest && data.latest.id !== before && data.latest.via === 'handoff' ? data.latest : null;

  // The phone's selfie arrived: the code has done its job and leaves the screen.
  useEffect(() => {
    if (!fromPhone) return;
    setHandoff(null);
    setSent(fromPhone);
  }, [fromPhone]);

  const refused = (result: Refusal) => {
    switch (result.code) {
      case 'kyc.handoff_used':
        return setLink('used');
      case 'kyc.handoff_expired':
        return setLink('expired');
      case 'kyc.handoff_unknown':
        return setLink('unknown');
      case 'kyc.handoff_unset':
        return setProblem({ kind: 'copy', text: t('handoffUnset') });
      case 'kyc.upload_caps_unset':
        return setProblem({ kind: 'copy', text: t('capsUnset') });
      case 'kyc.upload_type':
      case 'kyc.selfie_type':
        return setProblem({ kind: 'copy', text: t('wrongType', { types: caps?.contentTypes.join(', ') ?? '' }) });
      case 'kyc.upload_too_large':
        return setProblem({ kind: 'copy', text: caps ? t('overCap', { kib: String(kib(caps.maxBytes)) }) : t('capsUnset') });
      default:
        return setProblem({ kind: 'failure', result });
    }
  };

  const openCamera = async () => {
    setProblem(null);
    try {
      setStream(await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false }));
    } catch {
      setProblem({ kind: 'copy', text: t('cameraRefused') });
    }
  };

  const take = async () => {
    if (!video.current || !caps) return;
    setBusy(true);
    setProblem(null);
    try {
      const frame = await grab(video.current);
      if (!frame) return setProblem({ kind: 'copy', text: t('cameraRefused') });
      if (!caps.contentTypes.includes('image/jpeg'))
        return setProblem({ kind: 'copy', text: t('wrongType', { types: caps.contentTypes.join(', ') }) });
      if (frame.size > caps.maxBytes)
        return setProblem({ kind: 'copy', text: t('tooLarge', { size: String(kib(frame.size)), kib: String(kib(caps.maxBytes)) }) });
      const bytesBase64 = await base64Of(frame);
      const answer = await api.mutate(
        'identity',
        'kyc.selfie.submit',
        { contentType: 'image/jpeg', bytesBase64, ...(viaLink && token ? { handoff: token } : {}) },
        kycSelfieSchema,
      );
      if (!answer.ok) return refused(answer);
      setSent(answer.data);
      setStream(null);
      if (viaLink) setLink('done');
      reload();
    } finally {
      setBusy(false);
    }
  };

  const startHandoff = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const answer = await api.mutate('identity', 'kyc.selfie.handoff.start', undefined, kycSelfieHandoffSchema);
      if (!answer.ok) return refused(answer);
      setBefore(data?.latest?.id ?? null);
      setSent(null);
      setHandoff(answer.data);
    } finally {
      setBusy(false);
    }
  };

  const body = () => {
    if (resource.status === 'failed')
      return (
        <>
          <h3>
            <Copy k="failedTitle" />
          </h3>
          <Failure result={resource.failure} retry={reload} />
        </>
      );
    if (!data) return <Loading />;
    const { latest, liveness, handoffTtlSeconds } = data;
    const phoneLink = handoff ? `${window.location.origin}/verification?handoff=${handoff.token}` : null;
    return (
      <div className="stack">
        <p data-testid="verification__selfie-manual" data-face-check={data.faceCheck}>
          <Copy k="manual" />
        </p>
        <p className="muted" data-testid="verification__selfie-liveness">
          {liveness.recheckFor ? <Copy k="livenessFor" params={{ actions: liveness.recheckFor.join(', ') }} /> : <Copy k="livenessNone" />}
        </p>
        {latest && (
          <p data-testid="verification__selfie-latest" data-status={latest.status} data-via={latest.via}>
            <Copy k="latest" params={{ status: t(statusKey[latest.status]), via: t(viaKey[latest.via]) }} />
          </p>
        )}
        {link !== null && (
          <p role={linkRefused ? 'alert' : undefined} data-testid="verification__selfie-handoff" data-state={link}>
            <Copy k={linkKey[link]} />
          </p>
        )}
        {!caps ? (
          <p>
            <Copy k="capsUnset" />
          </p>
        ) : (
          !linkRefused &&
          link !== 'done' && (
            <div className="verification__selfie-camera">
              {stream ? (
                <>
                  <video ref={video} autoPlay muted playsInline aria-label={t('cameraLabel')} />
                  <div className="verification__selfie-actions">
                    <Button type="button" disabled={disabled || busy} onClick={() => void take()}>
                      <Copy k={busy ? 'sending' : 'take'} />
                    </Button>
                    <Button type="button" variant="secondary" disabled={busy} onClick={() => setStream(null)}>
                      <Copy k="stopCamera" />
                    </Button>
                  </div>
                </>
              ) : (
                <Button type="button" disabled={disabled || busy || (token !== null && link === null)} onClick={() => void openCamera()}>
                  <Copy k="openCamera" />
                </Button>
              )}
            </div>
          )
        )}
        {sent && (
          <p role="status" data-testid="verification__selfie-sent" data-status={sent.status}>
            <Copy k="sent" />
          </p>
        )}
        {token === null && !opened.broken && (
          <div className="stack" data-testid="verification__selfie-phone">
            {!phoneLink || !handoff ? (
              <Button type="button" variant="secondary" disabled={disabled || busy} onClick={() => void startHandoff()}>
                <Copy k="usePhone" />
              </Button>
            ) : (
              <>
                <h3>
                  <Copy k="phoneTitle" />
                </h3>
                <p>
                  <Copy k="phoneHelp" />
                </p>
                {linkExpired ? (
                  <p role="alert" data-testid="verification__selfie-link-expired">
                    <Copy k="phoneExpired" />
                  </p>
                ) : (
                  <>
                    <PhoneCode value={phoneLink} label={t('qrLabel')} failed={t('qrFailed')} />
                    <p className="verification__selfie-link">
                      <a href={phoneLink} data-testid="verification__selfie-link">
                        {phoneLink}
                      </a>
                    </p>
                    <p className="muted" data-testid="verification__selfie-link-until">
                      <Copy
                        k="phoneUntil"
                        params={{ time: new Date(handoff.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}
                      />
                    </p>
                  </>
                )}
                {handoffTtlSeconds && (
                  <p className="muted">
                    <Copy k="phoneRule" params={{ minutes: String(Math.round(handoffTtlSeconds / 60)) }} />
                  </p>
                )}
                <Button type="button" variant="secondary" disabled={disabled || busy} onClick={() => void startHandoff()}>
                  <Copy k="newLink" />
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="verification__cases" aria-labelledby="verification-selfie-title" data-testid="verification__selfie">
      <h2 id="verification-selfie-title">
        <Copy k="title" />
      </h2>
      <p className="muted">
        <Copy k="intro" />
      </p>
      {body()}
      {problem && (
        <div role="alert" data-testid="verification__selfie-problem">
          {problem.kind === 'copy' ? <p>{problem.text}</p> : <Failure result={problem.result} retry={problem.retry} />}
        </div>
      )}
    </section>
  );
}
