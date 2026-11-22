import { useEffect, useRef, useState } from 'react';
import { navigate } from '../../../app/location';
import { Button, Dialog, Field, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { networkLabel } from '../blockers';
import { walletCopy } from './copy';
import { APP_CHAIN_ID } from './eip1193';
import { DECIMALS_CALL, isTokenDecimals, readScan } from './transfer';
import { useWallet } from './WalletProvider';

/** The relay project id is an owner setting; blank means nothing can connect through a relay (as on the overview). */
const relayProjectId: string = ((import.meta.env.VITE_WALLET_RELAY_PROJECT_ID as string | undefined) ?? '').trim();

interface Detector {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
type DetectorClass = new (options: { formats: string[] }) => Detector;
const detectorClass = (): DetectorClass | null => {
  const found = (globalThis as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
  return typeof found === 'function' && typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function'
    ? found
    : null;
};

/**
 * Scan: what a code holds decides where it goes (D-portfolio-wallet-05). An address opens Send with it filled in and
 * nothing sent; a token contract (it answers `decimals()` through the wallet's own connection) opens its token page; a
 * wallet connection code asks before anything connects; anything else reads "Not recognised". The camera is used when
 * the browser can read codes; pasting the text works everywhere.
 */
export function ScanPanel() {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const wallet = useWallet();
  const [text, setText] = useState('');
  const [outcome, setOutcome] = useState<
    { kind: 'idle' } | { kind: 'reading' } | { kind: 'alert'; message: string } | { kind: 'connect'; uri: string }
  >({ kind: 'idle' });
  const [camera, setCamera] = useState<'off' | 'on' | 'denied'>('off');
  const video = useRef<HTMLVideoElement>(null);
  const Detector = detectorClass();

  const read = async (value: string) => {
    const scanned = readScan(value, APP_CHAIN_ID);
    if (scanned.kind === 'unknown') return setOutcome({ kind: 'alert', message: t('scanUnknown') });
    if (scanned.kind === 'otherNetwork')
      return setOutcome({
        kind: 'alert',
        message: t('scanOtherNetwork', { chain: String(scanned.chainId), network: networkLabel(APP_CHAIN_ID).name }),
      });
    if (scanned.kind === 'connect') return setOutcome({ kind: 'connect', uri: scanned.uri });
    if (!scanned.token) {
      // Only a connected wallet on the app's network can say whether the address is a token; without one nothing is guessed.
      if (wallet.status !== 'connected' || wallet.guard?.ok !== true)
        return setOutcome({ kind: 'alert', message: t('scanNeedsWallet', { network: networkLabel(APP_CHAIN_ID).name }) });
      setOutcome({ kind: 'reading' });
      if (isTokenDecimals(await wallet.call(scanned.address, DECIMALS_CALL))) return navigate(`/dex/tokens/${scanned.address}`);
    }
    const query = new URLSearchParams({ to: scanned.address, ...(scanned.token ? { token: scanned.token } : {}) });
    navigate(`/wallet/send?${query.toString()}`);
  };

  // The camera loop reads through the latest `read`, so a wallet connected while the camera runs is the one asked.
  const latestRead = useRef(read);
  latestRead.current = read;

  useEffect(() => {
    if (camera !== 'on' || !Detector) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    const detector = new Detector({ formats: ['qr_code'] });
    void (async () => {
      try {
        const opened = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        stream = opened;
        // Stopped while the browser was still asking: release the camera it just gave.
        if (stopped || !video.current) return opened.getTracks().forEach((track) => track.stop());
        video.current.srcObject = stream;
        await video.current.play();
        while (!stopped && video.current) {
          const [first] = await detector.detect(video.current);
          if (first?.rawValue) {
            setCamera('off');
            setText(first.rawValue);
            void latestRead.current(first.rawValue);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      } catch {
        if (!stopped) setCamera('denied');
      }
    })();
    return () => {
      stopped = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [camera, Detector]);

  return (
    <Panel title={t('scanTitle')}>
      <section aria-label={t('scanTitle')} className="protocol-scan">
        <p className="muted">{t('scanNote')}</p>
        {Detector ? (
          <>
            <Button variant="secondary" onClick={() => setCamera(camera === 'on' ? 'off' : 'on')}>
              {camera === 'on' ? t('scanCameraStop') : t('scanCamera')}
            </Button>
            {camera === 'on' && <video ref={video} muted playsInline aria-label={t('scanCamera')} />}
            {camera === 'denied' && <p className="muted">{t('scanCameraDenied')}</p>}
          </>
        ) : (
          <p className="muted">{t('scanCameraNone')}</p>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void read(text);
          }}
        >
          <Field
            label={t('scanPaste')}
            value={text}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setText(event.target.value);
              setOutcome({ kind: 'idle' });
            }}
          />
          <Button type="submit" disabled={text.trim() === '' || outcome.kind === 'reading'}>
            {t('scanRead')}
          </Button>
        </form>
        {outcome.kind === 'reading' && <p role="status">{t('scanReading')}</p>}
        {outcome.kind === 'alert' && <p role="alert">{outcome.message}</p>}
      </section>
      {outcome.kind === 'connect' && (
        <Dialog title={t('connectTitle2')} onClose={() => setOutcome({ kind: 'idle' })}>
          <p>{t('connectNote')}</p>
          <p className="muted" role="note" data-code="owner.decision">
            {relayProjectId ? t('remoteNotBuilt') : t('connectBlocked')}
          </p>
          <div className="protocol-actions">
            <Button variant="secondary" onClick={() => setOutcome({ kind: 'idle' })}>
              {t('connectCancel')}
            </Button>
            <Button disabled aria-disabled="true">
              {t('connectApprove')}
            </Button>
          </div>
        </Dialog>
      )}
    </Panel>
  );
}
